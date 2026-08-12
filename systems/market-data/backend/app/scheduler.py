import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.config import settings
from app.providers import nse_indices
from app.providers.dhan import renew_access_token
from app.providers.router import all_providers

logger = logging.getLogger(__name__)
_scheduler = BackgroundScheduler(timezone=settings.timezone)


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


def start_scheduler() -> None:
    _scheduler.add_job(
        _sync_all,
        CronTrigger(hour=settings.instrument_sync_hour, minute=settings.instrument_sync_minute),
        id="instrument-sync-daily",
        replace_existing=True,
    )
    _scheduler.add_job(
        _renew_dhan_token,
        IntervalTrigger(hours=settings.dhan_token_renew_interval_hours),
        id="dhan-token-renew",
        replace_existing=True,
    )
    _scheduler.start()
    # Run once immediately in the background so quotes work without
    # waiting for the next scheduled run (e.g. right after a restart).
    _scheduler.add_job(_sync_all, id="instrument-sync-initial", replace_existing=True)
    # Same reasoning - extends the .env-seeded token's life right away
    # instead of waiting a full dhan_token_renew_interval_hours, minimizing
    # the window where a soon-to-expire seed token could lapse first.
    _scheduler.add_job(_renew_dhan_token, id="dhan-token-renew-initial", replace_existing=True)
