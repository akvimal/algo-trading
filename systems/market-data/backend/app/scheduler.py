import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from app.config import settings
from app.providers.router import all_providers

logger = logging.getLogger(__name__)
_scheduler = BackgroundScheduler(timezone=settings.timezone)


def _sync_all() -> None:
    for provider in all_providers():
        try:
            provider.sync_instruments()
        except Exception:
            logger.exception("scheduled instrument sync failed for provider %s", provider.name)


def start_scheduler() -> None:
    _scheduler.add_job(
        _sync_all,
        CronTrigger(hour=settings.instrument_sync_hour, minute=settings.instrument_sync_minute),
        id="instrument-sync-daily",
        replace_existing=True,
    )
    _scheduler.start()
    # Run once immediately in the background so quotes work without
    # waiting for the next scheduled run (e.g. right after a restart).
    _scheduler.add_job(_sync_all, id="instrument-sync-initial", replace_existing=True)
