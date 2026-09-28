import time

import responses

from app.config import settings
from app.providers import dhan
from app.providers.dhan import DhanProvider

LTP_URL = "https://api.dhan.co/v2/marketfeed/ltp"
CANDLE_URL = "https://api.dhan.co/v2/charts/intraday"


def _candle_response(count: int) -> dict:
    now = int(time.time())
    return {
        "open": [100.0] * count, "high": [101.0] * count, "low": [99.0] * count, "close": [100.5] * count,
        "volume": [10] * count, "timestamp": [now - (count - i) * 300 for i in range(count)],
    }


def test_a_burst_of_different_categories_is_staggered_not_simultaneous(monkeypatch):
    """Reproduced live 2026-09-28: opening the Live Chart fires LTP + candle (+ others) at once.
    Each has its own independent throttle clock, so on a page that has called neither recently,
    both fire with zero wait on their OWN clock - this is exactly what let a burst of several
    Dhan calls land in the same instant and get rejected (sometimes as DH-906 "Invalid Token",
    not just a 429). The shared MIN_GLOBAL_CALL_GAP_SECONDS clock must force the second of two
    back-to-back DIFFERENT-category calls to wait, even though neither category's own clock
    would have made it wait at all."""
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    sleeps = []
    monkeypatch.setattr(dhan.time, "sleep", sleeps.append)

    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885"}

    with responses.RequestsMock() as rsps:
        rsps.add(responses.POST, LTP_URL, json={"data": {"NSE_EQ": {"2885": {"last_price": 100.0}}}}, status=200)
        rsps.add(responses.POST, CANDLE_URL, json=_candle_response(5), status=200)
        provider.get_ltp("RELIANCE")  # first call of any category: no wait
        provider.get_previous_candle("RELIANCE", "5min")  # a DIFFERENT category, same instant

    assert len(sleeps) == 1
    assert 0 < sleeps[0] <= dhan.MIN_GLOBAL_CALL_GAP_SECONDS


def test_two_calls_of_the_same_category_are_not_double_charged(monkeypatch):
    """The category's own (larger) interval already covers same-category spacing - the global
    gate must not ALSO impose its own wait on top when the category clock is what is really
    governing (i.e. the category wait is already >= the global gap)."""
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    sleeps = []
    monkeypatch.setattr(dhan.time, "sleep", sleeps.append)

    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885", "TCS": "11536"}

    with responses.RequestsMock() as rsps:
        # Different symbols so the per-symbol quote cache doesn't short-circuit the second call.
        rsps.add(responses.POST, LTP_URL, json={"data": {"NSE_EQ": {"2885": {"last_price": 100.0}}}}, status=200)
        rsps.add(responses.POST, LTP_URL, json={"data": {"NSE_EQ": {"11536": {"last_price": 3500.0}}}}, status=200)
        provider.get_ltp("RELIANCE")
        provider.get_ltp("TCS")

    assert len(sleeps) == 1
    assert sleeps[0] == dhan.MIN_LTP_CALL_INTERVAL_SECONDS  # the category's own (larger) wait, not an extra global one on top


def test_global_gate_is_isolated_per_throttle_key(monkeypatch):
    """A BYO (per-user) credential's calls must not stagger against - or be staggered by - the
    platform default's, same key-isolation the four category clocks already have."""
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    sleeps = []
    monkeypatch.setattr(dhan.time, "sleep", sleeps.append)
    dhan._last_any_call_at["user-1"] = time.monotonic()  # another user's key just called

    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885"}

    with responses.RequestsMock() as rsps:
        rsps.add(responses.POST, LTP_URL, json={"data": {"NSE_EQ": {"2885": {"last_price": 100.0}}}}, status=200)
        provider.get_ltp("RELIANCE")  # no credentials -> platform key (None), unrelated to "user-1"

    assert sleeps == []
