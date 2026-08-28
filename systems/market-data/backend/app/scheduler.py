import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.adapters.db.models import SentimentHistory
from app.adapters.db.session import SessionLocal
from app.config import settings
from app.domain.sentiment import SENTIMENT_UNDERLYINGS
from app.domain.sentiment_fetch import fetch_underlying_sentiment
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


def _record_sentiment_history() -> None:
    """Writes one market_data.sentiment_history row per SENTIMENT_UNDERLYINGS
    symbol - always the platform-default Dhan credential (credentials=None),
    since this is a background job with no caller to attribute a BYO
    credential to, unlike GET /options/sentiment itself. Same cadence as
    that route's own frontend pollers (5 minutes, see SentimentBadges.tsx/
    shell/index.html) - no value recording more often than the OI-change
    windows the score itself is computed over (5m/15m) actually shift."""
    db = SessionLocal()
    try:
        for exchange, symbols in SENTIMENT_UNDERLYINGS.items():
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
                        error=sentiment.error,
                    )
                )
        db.commit()
    except Exception:
        logger.exception("scheduled sentiment history recording failed")
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
        IntervalTrigger(minutes=settings.sentiment_history_interval_minutes),
        id="sentiment-history-record",
        replace_existing=True,
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
