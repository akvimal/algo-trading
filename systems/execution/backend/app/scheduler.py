"""Two independent periodic jobs, self-contained in this service so
neither depends on a second service being up at a safety-critical
moment - see docs/architecture.md.

square-off used to be a single daily CronTrigger fired at
execution.settings.square_off_time. Now that square_off_time is
per-segment (execution.accounts.square_off_time, possibly NULL - e.g.
CRYPTO never squares off), a single fire time no longer covers every
position - square_off_due_positions instead checks, every
square_off_poll_seconds, whether local time has passed EACH OPEN
position's own stored square_off_time (copied from its segment's account
row once at open time - see position_manager.open_position). This also
means account/settings changes never need an explicit reschedule
anymore: both jobs run on a fixed interval and read current
settings/position data fresh each run.

The exit-monitor job (stop-loss/target/trailing) runs the same way, on
its own independent interval - see position_manager.check_exits.
"""

import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from app.adapters.db.session import SessionLocal
from app.adapters.quotes.client import get_candle_history, get_ltp_batch, get_previous_candle
from app.config import settings
from app.domain.broker_reconciliation import reconcile_stuck_broker_orders
from app.domain.option_position_manager import check_option_group_exits, record_option_group_pnl_snapshots, square_off_due_option_groups
from app.domain.position_manager import check_exits, record_position_pnl_snapshots, square_off_due_positions

logger = logging.getLogger(__name__)

_scheduler = BackgroundScheduler()
_SQUARE_OFF_JOB_ID = "square-off-due"
_EXIT_MONITOR_JOB_ID = "exit-monitor"
_BROKER_RECONCILIATION_JOB_ID = "broker-order-reconciliation"


def run_square_off_due() -> dict:
    with SessionLocal() as db:
        result = square_off_due_positions(db, get_ltp_batch)
        # Multi-leg option groups (Phase 4d) run on the same poll interval
        # - no separate job/setting needed, see docs/architecture.md.
        option_result = square_off_due_option_groups(db, get_ltp_batch)
    if result["closed"] or result["failed"]:
        logger.info("square-off run: %s", result)
    if option_result["closed"] or option_result["failed"]:
        logger.info("option-group square-off run: %s", option_result)
    return result


def run_check_exits() -> dict:
    with SessionLocal() as db:
        result = check_exits(db, get_ltp_batch, get_previous_candle, get_candle_history)
        option_result = check_option_group_exits(db, get_ltp_batch, get_candle_history)
        # P&L history snapshots - piggybacks on this same 30s tick, but
        # against EVERY open position/group (not just the stop-loss/
        # target/liquidation-having subset check_exits itself scopes its
        # own candidate query to) - see position_manager.
        # record_position_pnl_snapshots' own docstring.
        record_position_pnl_snapshots(db, get_ltp_batch)
        record_option_group_pnl_snapshots(db, get_ltp_batch)
    if result["closed_stop_loss"] or result["closed_target"] or result.get("closed_exit_condition") or result["trailed"]:
        logger.info("exit-monitor run: %s", result)
    if option_result["closed_stop_loss"] or option_result["closed_target"] or option_result["trailed"]:
        logger.info("option-group exit-monitor run: %s", option_result)
    return result


def run_broker_reconciliation() -> dict:
    with SessionLocal() as db:
        return reconcile_stuck_broker_orders(db)


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
    _scheduler.add_job(
        run_broker_reconciliation,
        IntervalTrigger(seconds=settings.broker_order_reconciliation_poll_seconds),
        id=_BROKER_RECONCILIATION_JOB_ID,
        replace_existing=True,
    )
    if not _scheduler.running:
        _scheduler.start()
