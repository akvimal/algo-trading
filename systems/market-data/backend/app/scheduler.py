import logging
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.adapters.db.models import EquityScreenerSnapshot, OiEodSnapshot, SentimentHistory
from app.adapters.db.session import SessionLocal
from app.config import settings
from app.domain.equity_screener import compute_equity_screener_row
from app.domain.oi_buildup import PreviousSnapshot, compute_eod_buildup
from app.domain.sentiment import SENTIMENT_UNDERLYINGS, is_within_session
from app.domain.sentiment_fetch import fetch_underlying_sentiment
from app.providers import nse_indices
from app.providers.dhan import renew_access_token
from app.providers.router import all_providers, get_provider

logger = logging.getLogger(__name__)
# Nothing in this service configures logging (uvicorn only sets up its own
# loggers), so a bare logger.info here never reaches `docker compose logs` -
# only WARNING+ does, via Python's last-resort handler. The EOD jobs' start /
# summary lines are what tell you a run happened at all, so give THIS logger
# its own handler rather than turning INFO on for the whole process (every
# Dhan httpx call would then log too).
if not logger.handlers and not logging.getLogger().handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
_scheduler = BackgroundScheduler(timezone=settings.timezone)


THROTTLE_RETRY_ATTEMPTS = 8
THROTTLE_RETRY_SLEEP_SECONDS = 5.0
# A real Dhan 429 needs longer than our own queue-full wait for its budget to refill.
DHAN_429_RETRY_SLEEP_SECONDS = 10.0


def _retry_when_throttled(fn, *args):
    """Calls fn(*args), waiting out a Dhan rate-limit rejection instead of
    failing the symbol outright. Two flavours, both retried:

    * DhanProvider._throttle's LOCAL "queue is backed up" RuntimeError - the
      EOD batch jobs share Dhan's per-endpoint throttle with everything else
      in this process (browser pollers, the 5-minute sentiment job that fires
      on the same :40 boundary as the OI job). A failed call reserves no slot
      and never sleeps, so without a retry a single brief collision made the
      loop rip through the ENTIRE ~210/~2000-symbol batch in about a second,
      every symbol failing - zero rows written for the day.
    * A real HTTP 429 from Dhan ("rate limit hit (429)"). The local throttle
      sits exactly on Dhan's documented 1-request-per-3s limit (and Dhan is
      known to 429 slightly outside its documented gap - see
      MIN_LTP_CALL_INTERVAL_SECONDS), so network jitter or another process on
      the same account (the manual retry script runs in its OWN process with
      its own clocks) can trip it mid-batch. That used to abandon the symbol
      on the first 429; now it backs off longer, since the budget needs time
      to refill, and only then gives up.

    Anything else (bad symbol, auth, HTTP error) propagates to the caller's
    own per-symbol handling unchanged."""
    for attempt in range(THROTTLE_RETRY_ATTEMPTS):
        try:
            return fn(*args)
        except RuntimeError as e:
            message = str(e)
            if "rate limit hit (429)" in message:
                sleep_seconds = DHAN_429_RETRY_SLEEP_SECONDS
            elif "queue is backed up" in message:
                sleep_seconds = THROTTLE_RETRY_SLEEP_SECONDS
            else:
                raise
            if attempt == THROTTLE_RETRY_ATTEMPTS - 1:
                raise
            time.sleep(sleep_seconds)


def _log_eod_summary(job: str, total: int, tally: dict[str, int]) -> None:
    """One line per EOD batch run: how many symbols it tried and how each
    ended. A run that wrote nothing (or failed everything) is logged at
    WARNING so it stands out in `docker compose logs`."""
    detail = ", ".join(f"{k}={v}" for k, v in tally.items())
    message = f"scheduled {job}: finished, {tally['written']}/{total} written ({detail})"
    if tally["written"] == 0:
        logger.warning("%s - NOTHING WAS WRITTEN", message)
    else:
        logger.info(message)


def _sync_all() -> None:
    for provider in all_providers():
        try:
            provider.sync_instruments()
        except Exception:
            logger.exception("scheduled instrument sync failed for provider %s", provider.name)

    try:
        nse_indices.sync_universes()
    except Exception:
        logger.exception("scheduled NSE index universe sync failed")


def _renew_dhan_token() -> None:
    try:
        renew_access_token()
    except Exception:
        logger.exception("scheduled Dhan token renewal failed")


def _record_sentiment_history() -> None:
    """Writes one market_data.sentiment_history row per SENTIMENT_UNDERLYINGS
    symbol whose exchange is currently in session (is_within_session) -
    always the platform-default Dhan credential (credentials=None), since
    this is a background job with no caller to attribute a BYO credential
    to, unlike GET /options/sentiment itself. Same cadence as that route's
    own frontend pollers (5 minutes, see SentimentBadges.tsx/shell/
    index.html) - no value recording more often than the OI-change windows
    the score itself is computed over (5m/15m) actually shift.

    Skipping outside session hours (added so SentimentHistoryChart.tsx's
    day view isn't mostly off-hours error/stale-price noise - see
    docs/architecture.md's sentiment-history section) means a segment
    simply has no rows at all outside its own SEGMENT_SESSION_HOURS window,
    rather than rows with error='...' - the chart's x-axis is bounded to
    that same session window regardless, so this doesn't create a visible
    gap there, just avoids a wasted Dhan option-chain call and a noisy row
    for a market that isn't even open."""
    db = SessionLocal()
    try:
        now = datetime.now(ZoneInfo(settings.timezone))
        for exchange, symbols in SENTIMENT_UNDERLYINGS.items():
            if not is_within_session(exchange, now):
                continue
            for symbol in symbols:
                sentiment, spot_price = fetch_underlying_sentiment(exchange, symbol)
                db.add(
                    SentimentHistory(
                        exchange=exchange,
                        symbol=symbol,
                        direction=sentiment.direction,
                        strength=sentiment.strength,
                        score_5m=sentiment.score_5m,
                        score_15m=sentiment.score_15m,
                        spot_price=spot_price,
                        atm_call_buildup=sentiment.atm_call_buildup,
                        atm_put_buildup=sentiment.atm_put_buildup,
                        error=sentiment.error,
                    )
                )
        db.commit()
    except Exception:
        logger.exception("scheduled sentiment history recording failed")
        db.rollback()
    finally:
        db.close()


def _record_oi_eod_snapshot() -> None:
    """Writes one market_data.oi_eod_snapshot row per NSE F&O stock
    (DhanProvider.list_fno_stock_underlyings - ~150-200 symbols, NOT
    SENTIMENT_UNDERLYINGS' fixed 6) once per trading day, shortly after
    close - the EOD OI-buildup screener's whole reason for existing: Dhan's
    option-chain API has no historical-OI endpoint at all, so this table
    IS the history, one snapshot at a time going forward (see
    app/domain/oi_buildup.py's own module docstring).

    Skips weekends outright (no trading-calendar/holiday concept anywhere
    in this codebase, same gap SEGMENT_SESSION_HOURS's own docstring
    already notes - a real market holiday still runs and just produces
    whatever Dhan's chain endpoint happens to return for a closed market,
    same degrade-per-symbol handling as any other transient failure).

    One symbol's fetch failing (bad/missing expiry, a throttled-queue
    RuntimeError, ...) is skipped and rolled back individually - never
    fatal to the rest of this ~150-200-symbol batch, same "best effort per
    symbol" convention as signal-engine's weekly_advisor batch scan.
    Commits per-symbol (not once at the end, unlike
    _record_sentiment_history's own 6-symbol batch) since this job's own
    Dhan-throttle waits stretch it to several minutes - a long-lived
    transaction holding that many rows uncommitted the whole time has
    nothing to gain and a crash mid-run would otherwise lose every row.

    Deliberately NOT also run once immediately on boot (unlike
    _record_sentiment_history/_sync_all below) - a ~150-200-symbol Dhan
    scan on every backend restart during dev iteration would be wasteful;
    missing today's snapshot just means it fills in at tomorrow's own
    scheduled run instead."""
    now = datetime.now(ZoneInfo(settings.timezone))
    if now.weekday() >= 5:
        logger.info("scheduled OI EOD snapshot: skipped, weekend")
        return

    try:
        provider = get_provider("NSE")
        symbols = provider.list_fno_stock_underlyings()
    except Exception:
        logger.exception("scheduled OI EOD snapshot: could not list NSE F&O stocks")
        return

    # Every skip below used to be a bare `continue` with no log line, so a
    # run that wrote nothing left no trace at all. Tally each outcome and
    # log one summary at the end (see _log_eod_summary).
    if not symbols:
        logger.warning(
            "scheduled OI EOD snapshot: 0 NSE F&O stocks listed (instrument master not loaded?) - nothing to do"
        )
        return
    logger.info("scheduled OI EOD snapshot: starting, %d symbols", len(symbols))
    tally = {"written": 0, "unresolved": 0, "no_expiry": 0, "no_chain": 0, "failed": 0}

    today = now.date()
    db = SessionLocal()
    try:
        for symbol in symbols:
            try:
                resolved = provider.resolve_underlying(symbol)
                if resolved is None:
                    tally["unresolved"] += 1
                    continue
                expiries = _retry_when_throttled(provider.get_expiry_list, resolved.chart_symbol)
                if not expiries:
                    tally["no_expiry"] += 1
                    continue
                expiry = sorted(expiries)[0]  # nearest - same convention as sentiment_fetch.py
                chain = _retry_when_throttled(provider.get_option_chain, resolved.chart_symbol, expiry)
                if chain is None:
                    tally["no_chain"] += 1
                    continue

                total_call_oi = sum(row.ce.oi for row in chain.strikes if row.ce is not None)
                total_put_oi = sum(row.pe.oi for row in chain.strikes if row.pe is not None)
                spot_price = chain.underlying_last_price
                pcr = (total_put_oi / total_call_oi) if total_call_oi > 0 else None

                prev_row = (
                    db.query(OiEodSnapshot)
                    .filter(OiEodSnapshot.symbol == symbol, OiEodSnapshot.snapshot_date < today)
                    .order_by(OiEodSnapshot.snapshot_date.desc())
                    .first()
                )
                previous = (
                    PreviousSnapshot(prev_row.total_call_oi, prev_row.total_put_oi, prev_row.spot_price)
                    if prev_row is not None
                    else None
                )
                result = compute_eod_buildup(total_call_oi, total_put_oi, spot_price, previous)

                # A re-run on the SAME day (e.g. a manual retrigger after an
                # earlier partial failure) updates today's own row in place
                # rather than violating the (symbol, snapshot_date) unique
                # constraint.
                row = (
                    db.query(OiEodSnapshot)
                    .filter(OiEodSnapshot.symbol == symbol, OiEodSnapshot.snapshot_date == today)
                    .first()
                )
                if row is None:
                    row = OiEodSnapshot(symbol=symbol, exchange="NSE", snapshot_date=today)
                    db.add(row)
                row.spot_price = spot_price
                row.total_call_oi = total_call_oi
                row.total_put_oi = total_put_oi
                row.pcr = pcr
                row.call_oi_change_pct = result.call_oi_change_pct
                row.put_oi_change_pct = result.put_oi_change_pct
                row.price_change_pct = result.price_change_pct
                row.call_buildup = result.call_buildup
                row.put_buildup = result.put_buildup
                db.commit()
                tally["written"] += 1
            except Exception:
                tally["failed"] += 1
                logger.exception("scheduled OI EOD snapshot failed for %s", symbol)
                db.rollback()
    finally:
        db.close()
    _log_eod_summary("OI EOD snapshot", len(symbols), tally)


def _record_equity_screener_snapshot() -> None:
    """Writes one market_data.equity_screener_snapshot row per NSE equity
    (DhanProvider.list_nse_equities - ALL ~2000 listed equities, wider
    than the OI job's ~210 F&O-only stocks) once per trading day. Unlike
    _record_oi_eod_snapshot, this fetches a full trailing window (~1
    calendar year) of REAL daily bars from Dhan's own charts/historical
    endpoint every time - see app/domain/equity_screener.py's own module
    docstring for why that endpoint itself is the history store here, so
    there's no day-over-day diffing against our own previous row the way
    the OI job needs.

    Same per-symbol best-effort resilience as _record_oi_eod_snapshot
    (one symbol's fetch failing never aborts the rest of the ~2000-symbol
    batch, commits per-symbol not once at the end) - see that function's
    own docstring for the full reasoning, which applies here unchanged.
    Also NOT run once immediately on boot, same reasoning."""
    now = datetime.now(ZoneInfo(settings.timezone))
    if now.weekday() >= 5:
        return

    try:
        provider = get_provider("NSE")
        symbols = provider.list_nse_equities()
    except Exception:
        logger.exception("scheduled equity screener snapshot: could not list NSE equities")
        return

    today = now.date()
    # ~380 calendar days comfortably covers 252 TRADING days (the 52-week
    # window equity_screener.py needs) even across weekends/holidays.
    from_date = today - timedelta(days=380)
    db = SessionLocal()
    try:
        for symbol in symbols:
            try:
                candles = _retry_when_throttled(provider.get_candle_history, symbol, "daily", from_date, today)
                result = compute_equity_screener_row(candles)
                if result is None:
                    continue  # not enough history yet - see equity_screener.py's own MIN_BARS floor

                row = (
                    db.query(EquityScreenerSnapshot)
                    .filter(EquityScreenerSnapshot.symbol == symbol, EquityScreenerSnapshot.snapshot_date == today)
                    .first()
                )
                if row is None:
                    row = EquityScreenerSnapshot(symbol=symbol, exchange="NSE", snapshot_date=today)
                    db.add(row)
                row.close = result.close
                row.pct_change_5d = result.pct_change_5d
                row.pct_change_20d = result.pct_change_20d
                row.adx = result.adx
                row.regime = result.regime
                row.high_52w = result.high_52w
                row.low_52w = result.low_52w
                row.pct_from_52w_high = result.pct_from_52w_high
                row.pct_from_52w_low = result.pct_from_52w_low
                row.proximity = result.proximity
                db.commit()
            except Exception:
                logger.exception("scheduled equity screener snapshot failed for %s", symbol)
                db.rollback()
    finally:
        db.close()


def _check_price_alerts() -> None:
    """Evaluate every active market_data.price_alerts row against a fresh
    LTP and push the ones that just crossed to Telegram - see
    app/domain/price_alerts.py."""
    from app.domain.price_alerts import dispatch_due

    db = SessionLocal()
    try:
        dispatch_due(db)
    except Exception:
        logger.exception("scheduled price-alert check failed")
        db.rollback()
    finally:
        db.close()


def start_scheduler() -> None:
    _scheduler.add_job(
        _sync_all,
        CronTrigger(hour=settings.instrument_sync_hour, minute=settings.instrument_sync_minute),
        id="instrument-sync-daily",
        replace_existing=True,
    )
    # dhan_token_renew_interval_hours=0 disables this entirely (both the
    # periodic job and the on-boot run below) - dev and test share one
    # physical Dhan account/token, so only one stack should ever renew it
    # automatically; the other would otherwise periodically invalidate
    # whichever token the first is currently using. See config.py/
    # docs/architecture.md.
    if settings.dhan_token_renew_interval_hours > 0:
        _scheduler.add_job(
            _renew_dhan_token,
            IntervalTrigger(hours=settings.dhan_token_renew_interval_hours),
            id="dhan-token-renew",
            replace_existing=True,
        )
    _scheduler.add_job(
        _record_sentiment_history,
        # CronTrigger, not IntervalTrigger - an interval trigger's phase is
        # whatever moment this job happened to be added (i.e. whenever the
        # backend last started), so rows land on an arbitrary offset like
        # :02/:07/:12 instead of a clean :00/:05/:10 - which the OI strip's
        # sparklines (LiveChartPanel.tsx's sentimentSteps) then have to
        # round down to display cleanly. Recording ON that boundary instead
        # means every row already falls on one, no rounding needed downstream.
        CronTrigger(minute=f"*/{settings.sentiment_history_interval_minutes}"),
        id="sentiment-history-record",
        replace_existing=True,
    )
    _scheduler.add_job(
        _record_oi_eod_snapshot,
        CronTrigger(hour=settings.oi_eod_snapshot_hour, minute=settings.oi_eod_snapshot_minute),
        id="oi-eod-snapshot-record",
        replace_existing=True,
    )
    _scheduler.add_job(
        _record_equity_screener_snapshot,
        CronTrigger(hour=settings.equity_screener_snapshot_hour, minute=settings.equity_screener_snapshot_minute),
        id="equity-screener-snapshot-record",
        replace_existing=True,
    )
    _scheduler.add_job(
        _check_price_alerts,
        IntervalTrigger(seconds=settings.price_alert_check_interval_seconds),
        id="price-alert-check",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    _scheduler.start()
    # Run once immediately in the background so quotes work without
    # waiting for the next scheduled run (e.g. right after a restart).
    _scheduler.add_job(_sync_all, id="instrument-sync-initial", replace_existing=True)
    _scheduler.add_job(_record_sentiment_history, id="sentiment-history-record-initial", replace_existing=True)
    if settings.dhan_token_renew_interval_hours > 0:
        # Same reasoning - extends the .env-seeded token's life right away
        # instead of waiting a full dhan_token_renew_interval_hours, minimizing
        # the window where a soon-to-expire seed token could lapse first.
        _scheduler.add_job(_renew_dhan_token, id="dhan-token-renew-initial", replace_existing=True)
