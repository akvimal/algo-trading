import os

# These tests must never touch a real database. The default DATABASE_URL points at the dev Postgres that is published on this machine
# (localhost:5433), and a test that runs a job which opens its own session would write to it: on 2026-10-06 a scheduler test, whose job
# now sends a notification when it finishes, queued a real Telegram message in the dev database. Point every test at an address that
# refuses connections, BEFORE the app (and its settings) are imported, so any accidental database use fails loudly instead.
os.environ["DATABASE_URL"] = "postgresql+psycopg://nobody:nothing@127.0.0.1:1/never_a_real_database"

import pytest

from app.domain import job_tracker
from app.domain import ai_models, news_scores
from app.providers import calendar, dhan, news


@pytest.fixture(autouse=True)
def _no_model_settings_db(monkeypatch):
    """app/domain/ai_models.py reads market_data.ai_model_settings; without this every test that reaches an AI call
    site would open a real database session. Tests that want overrides patch ai_models._load_overrides."""
    monkeypatch.setattr(ai_models, "_load_overrides", lambda: {})
    ai_models.invalidate()
    yield
    ai_models.invalidate()


@pytest.fixture(autouse=True)
def _no_notifications_sent(monkeypatch):
    """The jobs call app/domain/notification_jobs when they finish (the OI digest, the pre-market push, the operator check). Nothing a
    test does may send a message or queue one: tests that exercise the notification code replace these with their own."""
    from app.domain import notification_jobs, notifications

    monkeypatch.setattr(notification_jobs, "send_oi_digest", lambda: notifications.Tally())
    monkeypatch.setattr(notification_jobs, "send_premarket", lambda report, day=None: notifications.Tally())
    monkeypatch.setattr(notification_jobs, "check_ops", lambda: notifications.Tally())
    monkeypatch.setattr(notification_jobs, "retry_failed", lambda: notifications.Tally())
    monkeypatch.setattr(notifications, "send_telegram", lambda text, chat=None: pytest.fail("a test tried to send a real Telegram message"))
    monkeypatch.setattr(notifications, "send_telegram_photo", lambda png, caption, chat=None: pytest.fail("a test tried to send a real Telegram picture"))


@pytest.fixture(autouse=True)
def _no_news_scores_db(monkeypatch):
    """app/domain/news_scores.py reads/writes market_data.news_article_scores; by default nothing has been judged yet, which is
    the original send-everything behaviour the older news tests describe. test_news_dedupe.py supplies its own store."""
    monkeypatch.setattr(news_scores, "load", lambda underlying, urls: {})
    monkeypatch.setattr(news_scores, "save", lambda underlying, judged: None)
    monkeypatch.setattr(news_scores, "latest_digest", lambda underlying: None)


@pytest.fixture(autouse=True)
def _reset_calendar_cache():
    """app/providers/calendar.py's cache is a module-level variable
    (shared across every call, not per-request) - same leak risk as
    news'/dhan's below if left dirty between tests."""
    calendar._cache = None
    yield
    calendar._cache = None


@pytest.fixture(autouse=True)
def _reset_news_cache():
    """app/providers/news.py's cache (and its _last_fingerprint change-
    detection map) are module-level, shared across every call, not per-
    request - same leak risk as dhan's throttle clocks below if left dirty
    between tests."""
    news._cache.clear()
    news._last_fingerprint.clear()
    yield
    news._cache.clear()
    news._last_fingerprint.clear()


@pytest.fixture(autouse=True)
def _reset_dhan_throttle_state():
    """app/providers/dhan.py's rate-limit throttle clocks (_last_ltp_call_at
    etc.) moved from per-DhanProvider-instance state to module-level,
    shared by every instance - fixes dhan-nse/dhan-mcx firing near-
    simultaneous real Dhan calls despite each individually honoring its
    OWN 3s throttle (see that module's comment near _token_lock). A side
    effect: a fresh DhanProvider() in one test no longer starts with a
    clean throttle clock of its own - several tests deliberately backdate
    these dicts to simulate "queue already backed up" (see
    test_get_ltp_fails_fast_when_throttle_queue_too_deep and siblings) and,
    without this reset, that would leak into whichever test runs next."""
    dhan._last_ltp_call_at.clear()
    dhan._last_candle_call_at.clear()
    dhan._last_option_chain_call_at.clear()
    dhan._last_order_call_at.clear()
    dhan._last_any_call_at.clear()
    yield
    dhan._last_ltp_call_at.clear()
    dhan._last_candle_call_at.clear()
    dhan._last_option_chain_call_at.clear()
    dhan._last_order_call_at.clear()
    dhan._last_any_call_at.clear()

@pytest.fixture(autouse=True)
def _job_tracker_in_memory():
    """The tracked jobs record their runs; in tests that goes to memory, never a database (and the store is
    reset so one test's runs cannot show up in the next)."""
    store = job_tracker.MemoryStore()
    job_tracker.configure(store)
    yield store
    job_tracker.configure(None)
