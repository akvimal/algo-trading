"""The in-house engine's periodic tick - self-contained in this service,
same reasoning as execution's square-off/exit-monitor jobs
(see execution/backend/app/scheduler.py, docs/architecture.md). Runs
much more often than any one strategy's own `interval` - run_live_tick's
per-strategy last_signal_candle_ts check (not this poll cadence) is what
prevents re-signaling on the same completed bar every tick.

Also two Weekly Advisor trade-lifecycle jobs (2026-09-22, same
self-contained-scheduler pattern) - see
_refresh_weekly_advisor_leg_prices/_expire_weekly_advisor_trades below."""

import logging
from datetime import date, datetime, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from app.adapters.db import models as db_models
from app.adapters.db.session import SessionLocal
from app.adapters.market_data import client as market_data_client
from app.adapters.market_data.client import (
    get_candle_history,
    get_ltp,
    get_universe_constituents,
    resolve_underlying,
)
from app.config import settings
from app.domain.generation.engine import run_live_tick
from app.domain.processing.intake.core import create_signal_from_ingest
from app.domain.processing.models import SignalIngest
from app.domain.weekly_advisor.pipeline import EXCHANGE as WEEKLY_ADVISOR_EXCHANGE
from app.domain.weekly_advisor.pipeline import _leg_market_data

logger = logging.getLogger(__name__)

_scheduler = BackgroundScheduler()
_ENGINE_TICK_JOB_ID = "engine-tick"
_WEEKLY_ADVISOR_LEG_REFRESH_JOB_ID = "weekly-advisor-leg-refresh"
_WEEKLY_ADVISOR_EXPIRE_JOB_ID = "weekly-advisor-expire-trades"
# Moderate cadence, not market-hours-gated - signal-engine has no session-
# hours concept of its own (that lives in market-data, and importing it
# directly would cross the systems/* boundary), and an off-hours chain
# fetch just returns whatever market-data last cached/fetched at low cost,
# same tradeoff every other clock-time-only job in this codebase accepts.
WEEKLY_ADVISOR_LEG_REFRESH_INTERVAL_SECONDS = 15 * 60


def run_engine_tick() -> dict:
    with SessionLocal() as db:
        # Since the signal-engine merge (2026-08-28, see docs/architecture.md),
        # the in-house engine's PostSignal callable (see engine.py's own
        # type alias) posts straight into create_signal_from_ingest instead
        # of an HTTP POST /signals round-trip to a separate signal-processing
        # service - same DB session as the rest of this tick, not a second
        # transaction on a different connection.
        def post_signal(payload: dict) -> dict:
            return create_signal_from_ingest(db, SignalIngest(**payload))

        result = run_live_tick(
            db, resolve_underlying, get_candle_history, get_ltp, get_universe_constituents, post_signal
        )
    if result["signaled"] or result["failed"]:
        logger.info("engine tick: %s", result)
    return result


def _refresh_weekly_advisor_leg_prices() -> None:
    """Mark-to-market for every OPEN Weekly Advisor trade's legs - one
    option-chain fetch per (symbol, expiry_date) combination, shared
    across every trade on it (same call pipeline.py's own run_symbol
    already makes for a fresh recommendation, reused here for a live mark
    on an already-journaled one) rather than one fetch per trade/leg.
    Best-effort per group - a market-data hiccup on one symbol's chain
    doesn't block every other group's refresh, and a trade with no
    expiry_date/legs recorded yet (journaled before this feature existed)
    is simply skipped, not an error. Writes current_price onto each leg
    dict in place (JSONB, no per-leg child rows - see the table's own
    comment) and prices_updated_at on the trade - see journal.py's
    unrealized_pnl for how this feeds the trade card's own live P&L."""
    with SessionLocal() as db:
        rows = (
            db.query(db_models.WeeklyAdvisorTrade, db_models.WeeklyAdvisorRecommendation.symbol)
            .join(db_models.WeeklyAdvisorRecommendation, db_models.WeeklyAdvisorTrade.recommendation_id == db_models.WeeklyAdvisorRecommendation.id)
            .filter(
                db_models.WeeklyAdvisorTrade.status == "open",
                db_models.WeeklyAdvisorTrade.legs.isnot(None),
                db_models.WeeklyAdvisorTrade.expiry_date.isnot(None),
            )
            .all()
        )
        groups: dict[tuple[str, str], list[db_models.WeeklyAdvisorTrade]] = {}
        for trade, symbol in rows:
            groups.setdefault((symbol, trade.expiry_date.isoformat()), []).append(trade)

        for (symbol, expiry), trades in groups.items():
            try:
                chain = market_data_client.get_option_chain(WEEKLY_ADVISOR_EXCHANGE, symbol, expiry)
            except Exception:
                logger.exception("weekly-advisor leg-price refresh: chain fetch failed for %s %s", symbol, expiry)
                continue
            if not chain:
                continue
            leg_data = _leg_market_data(chain.get("strikes"))
            if not leg_data:
                continue
            for trade in trades:
                new_legs = []
                changed = False
                for leg in trade.legs or []:
                    leg = dict(leg)
                    try:
                        key = (round(float(leg["strike"]), 2), leg["option_type"])
                    except (KeyError, TypeError, ValueError):
                        new_legs.append(leg)
                        continue
                    data = leg_data.get(key)
                    if data is not None:
                        leg["current_price"] = data.premium
                        if leg.get("security_id") is None:
                            leg["security_id"] = data.security_id
                        changed = True
                    new_legs.append(leg)
                if changed:
                    trade.legs = new_legs
                    trade.prices_updated_at = datetime.now(timezone.utc)
        db.commit()


def _expire_weekly_advisor_trades() -> None:
    """Flags every OPEN Weekly Advisor trade whose expiry_date has passed
    as 'expired' - NOT auto-closed with a guessed P&L. This module already
    refuses to guess at numbers it isn't confident in elsewhere (see
    journal.py's compute_performance_summary excluding a closed trade with
    no realized_pnl rather than assuming 0) - "last tracked LTP before
    expiry" is an approximation of true settlement, not the real thing,
    especially for a leg that finished ITM. The user still closes it
    manually via the existing PUT .../trades/{id}/close (works identically
    on an 'expired' trade as an 'open' one - not a locked/terminal state),
    ideally pre-filled from whatever current_price the refresh job above
    last captured before expiry."""
    with SessionLocal() as db:
        today = date.today()
        (
            db.query(db_models.WeeklyAdvisorTrade)
            .filter(
                db_models.WeeklyAdvisorTrade.status == "open",
                db_models.WeeklyAdvisorTrade.expiry_date.isnot(None),
                db_models.WeeklyAdvisorTrade.expiry_date < today,
            )
            .update({"status": "expired"}, synchronize_session=False)
        )
        db.commit()


def start_scheduler() -> None:
    _scheduler.add_job(
        run_engine_tick,
        IntervalTrigger(seconds=settings.engine_poll_seconds),
        id=_ENGINE_TICK_JOB_ID,
        replace_existing=True,
    )
    _scheduler.add_job(
        _refresh_weekly_advisor_leg_prices,
        IntervalTrigger(seconds=WEEKLY_ADVISOR_LEG_REFRESH_INTERVAL_SECONDS),
        id=_WEEKLY_ADVISOR_LEG_REFRESH_JOB_ID,
        replace_existing=True,
    )
    # Once daily is plenty - an expiry date only ever needs noticing once
    # it's passed, not polled continuously; the leg-refresh job above still
    # keeps prices current right up until that day arrives.
    _scheduler.add_job(
        _expire_weekly_advisor_trades,
        IntervalTrigger(hours=24),
        id=_WEEKLY_ADVISOR_EXPIRE_JOB_ID,
        replace_existing=True,
    )
    _scheduler.add_job(_expire_weekly_advisor_trades, id=f"{_WEEKLY_ADVISOR_EXPIRE_JOB_ID}-initial", replace_existing=True)
    if not _scheduler.running:
        _scheduler.start()
