import pytest

from app.providers import dhan


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
    yield
    dhan._last_ltp_call_at.clear()
    dhan._last_candle_call_at.clear()
    dhan._last_option_chain_call_at.clear()
    dhan._last_order_call_at.clear()
