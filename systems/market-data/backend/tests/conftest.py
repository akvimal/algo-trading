import pytest

from app.domain import job_tracker
from app.domain import ai_models
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
