"""The in-house engine's periodic tick - self-contained in this service,
same reasoning as execution's square-off/exit-monitor jobs
(see execution/backend/app/scheduler.py, docs/architecture.md). Runs
much more often than any one strategy's own `interval` - run_live_tick's
per-strategy last_signal_candle_ts check (not this poll cadence) is what
prevents re-signaling on the same completed bar every tick."""

import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from app.adapters.db.session import SessionLocal
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

logger = logging.getLogger(__name__)

_scheduler = BackgroundScheduler()
_ENGINE_TICK_JOB_ID = "engine-tick"


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


def start_scheduler() -> None:
    _scheduler.add_job(
        run_engine_tick,
        IntervalTrigger(seconds=settings.engine_poll_seconds),
        id=_ENGINE_TICK_JOB_ID,
        replace_existing=True,
    )
    if not _scheduler.running:
        _scheduler.start()
