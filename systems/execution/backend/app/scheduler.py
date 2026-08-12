"""Two independent periodic jobs, self-contained in this service (not
n8n) so neither depends on a second service being up at a safety-critical
moment - see docs/architecture.md.

square-off used to be a single daily CronTrigger fired at
execution.settings.square_off_time. Now that a Strategy can override
square_off_time per-strategy (signal-generation), a single fire time no
longer covers every position - square_off_due_positions instead checks,
every square_off_poll_seconds, whether local time has passed EACH OPEN
position's own stored square_off_time (resolved and stored once at open
time - see position_manager.open_position). This also means settings/
strategy changes never need an explicit reschedule anymore: both jobs run
on a fixed interval and read current settings/position data fresh each
run.

The exit-monitor job (stop-loss/target/trailing) runs the same way, on
its own independent interval - see position_manager.check_exits.
"""

import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from app.adapters.db.session import SessionLocal
from app.adapters.quotes.client import get_ltp_batch, get_previous_candle
from app.config import settings
from app.domain.position_manager import check_exits, square_off_due_positions

logger = logging.getLogger(__name__)

_scheduler = BackgroundScheduler()
_SQUARE_OFF_JOB_ID = "square-off-due"
_EXIT_MONITOR_JOB_ID = "exit-monitor"


def run_square_off_due() -> dict:
    with SessionLocal() as db:
        result = square_off_due_positions(db, get_ltp_batch)
    if result["closed"] or result["failed"]:
        logger.info("square-off run: %s", result)
    return result


def run_check_exits() -> dict:
    with SessionLocal() as db:
        result = check_exits(db, get_ltp_batch, get_previous_candle)
    if result["closed_stop_loss"] or result["closed_target"] or result["trailed"]:
        logger.info("exit-monitor run: %s", result)
    return result


def start_scheduler() -> None:
    _scheduler.add_job(
        run_square_off_due,
        IntervalTrigger(seconds=settings.square_off_poll_seconds),
        id=_SQUARE_OFF_JOB_ID,
        replace_existing=True,
    )
    _scheduler.add_job(
        run_check_exits,
        IntervalTrigger(seconds=settings.exit_monitor_poll_seconds),
        id=_EXIT_MONITOR_JOB_ID,
        replace_existing=True,
    )
    if not _scheduler.running:
        _scheduler.start()
