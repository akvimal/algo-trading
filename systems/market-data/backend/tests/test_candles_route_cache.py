"""Tests for GET /candles/history's own caching (app/api/routes/candles.py)
- added so repeated backtest re-runs against the same (exchange, symbol,
interval, from, to) don't re-fetch from the real provider every time a
caller changes only an exit-config knob that doesn't affect what candles
get fetched at all. Calls the route function directly with a monkeypatched
get_provider, same "plain fakes, no real HTTP/TestClient" convention
signal-generation's own route tests already use - this backend has no
TestClient-based route test layer either (confirmed: no conftest.py, no
TestClient usage anywhere in tests/)."""

import time
from datetime import date, datetime, timedelta, timezone

import pytest

import app.api.routes.candles as candles_route
from app.domain.models import Candle


class FakeProvider:
    def __init__(self):
        self.call_count = 0

    def get_candle_history(self, symbol, interval, from_date, to_date, credentials=None):
        self.call_count += 1
        return [Candle(exchange="NSE", symbol=symbol, interval=interval, open=1, high=1, low=1, close=1, volume=1, timestamp=f"{from_date}T09:15:00", provider="fake")]


@pytest.fixture(autouse=True)
def _clear_cache():
    candles_route._history_cache.clear()
    yield
    candles_route._history_cache.clear()


def test_get_candle_history_second_identical_call_hits_cache(monkeypatch):
    provider = FakeProvider()
    monkeypatch.setattr(candles_route, "get_provider", lambda exchange: provider)

    from_date, to_date = date(2026, 1, 1), date(2026, 1, 5)
    candles_route.get_candle_history("NSE", "RELIANCE", "15min", from_date, to_date)
    candles_route.get_candle_history("NSE", "RELIANCE", "15min", from_date, to_date)

    assert provider.call_count == 1


def test_get_candle_history_different_range_is_a_cache_miss(monkeypatch):
    provider = FakeProvider()
    monkeypatch.setattr(candles_route, "get_provider", lambda exchange: provider)

    candles_route.get_candle_history("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 5))
    candles_route.get_candle_history("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 6))

    assert provider.call_count == 2


def test_get_candle_history_different_symbol_is_a_cache_miss(monkeypatch):
    provider = FakeProvider()
    monkeypatch.setattr(candles_route, "get_provider", lambda exchange: provider)

    candles_route.get_candle_history("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 5))
    candles_route.get_candle_history("NSE", "TCS", "15min", date(2026, 1, 1), date(2026, 1, 5))

    assert provider.call_count == 2


def test_get_candle_history_cache_returns_the_same_data(monkeypatch):
    provider = FakeProvider()
    monkeypatch.setattr(candles_route, "get_provider", lambda exchange: provider)

    first = candles_route.get_candle_history("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 5))
    second = candles_route.get_candle_history("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 5))
    assert first == second


def test_history_cache_fresh_for_historical_range_within_ttl():
    yesterday = date.today() - timedelta(days=1)
    fetched_at_monotonic = time.monotonic() - 60  # 1 minute ago
    assert candles_route._is_cache_fresh("15min", yesterday, fetched_at_monotonic, datetime.now(timezone.utc)) is True


def test_history_cache_stale_for_historical_range_past_ttl():
    yesterday = date.today() - timedelta(days=1)
    fetched_at_monotonic = time.monotonic() - candles_route._HISTORICAL_RANGE_TTL_SECONDS - 1
    assert candles_route._is_cache_fresh("15min", yesterday, fetched_at_monotonic, datetime.now(timezone.utc)) is False


def test_history_cache_fresh_for_live_range_within_same_bar():
    today = date.today()
    fetched_at_wall = datetime.now(timezone.utc)
    assert candles_route._is_cache_fresh("15min", today, time.monotonic(), fetched_at_wall) is True
    assert candles_route._is_cache_fresh("60min", today, time.monotonic(), fetched_at_wall) is True


def test_history_cache_stale_for_live_range_once_bar_boundary_crossed():
    # A fetch from well over one bar ago must be treated as stale even
    # though a flat elapsed-seconds TTL might not have expired yet - this
    # is exactly the bug being fixed (a mid-bar fetch staying "valid"
    # past the next bar's actual close).
    today = date.today()
    fetched_at_wall = datetime.now(timezone.utc) - timedelta(minutes=20)
    assert candles_route._is_cache_fresh("15min", today, time.monotonic(), fetched_at_wall) is False


def test_history_cache_fresh_for_daily_interval_within_same_day():
    today = date.today()
    fetched_at_wall = datetime.now(timezone.utc)
    assert candles_route._is_cache_fresh("daily", today, time.monotonic(), fetched_at_wall) is True


# --- GET /candles/cache-status / POST /candles/cache/clear -------------------------------------


def test_cache_status_reports_uncached_before_any_fetch():
    status = candles_route.get_candle_cache_status("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 5))
    assert status.cached is False
    assert status.fetched_at is None


def test_cache_status_reports_cached_with_a_timestamp_after_a_fetch(monkeypatch):
    provider = FakeProvider()
    monkeypatch.setattr(candles_route, "get_provider", lambda exchange: provider)

    candles_route.get_candle_history("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 5))
    status = candles_route.get_candle_cache_status("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 5))

    assert status.cached is True
    assert status.fetched_at is not None


def test_cache_status_different_range_is_still_uncached(monkeypatch):
    provider = FakeProvider()
    monkeypatch.setattr(candles_route, "get_provider", lambda exchange: provider)

    candles_route.get_candle_history("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 5))
    status = candles_route.get_candle_cache_status("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 6))

    assert status.cached is False


def test_clear_candle_cache_entry_forces_a_real_refetch(monkeypatch):
    provider = FakeProvider()
    monkeypatch.setattr(candles_route, "get_provider", lambda exchange: provider)

    candles_route.get_candle_history("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 5))
    candles_route.clear_candle_cache_entry("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 5))
    status = candles_route.get_candle_cache_status("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 5))
    candles_route.get_candle_history("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 5))

    assert status.cached is False  # confirmed gone before the re-fetch
    assert provider.call_count == 2  # first fetch + the forced re-fetch after clear


def test_clear_candle_cache_entry_is_a_noop_when_nothing_cached():
    candles_route.clear_candle_cache_entry("NSE", "RELIANCE", "15min", date(2026, 1, 1), date(2026, 1, 5))  # no error


# --- source=yahoo -------------------------------------------------------


def test_source_yahoo_never_resolves_a_quote_provider(monkeypatch):
    def fail_get_provider(exchange):
        raise AssertionError("source=yahoo must not call get_provider at all")

    monkeypatch.setattr(candles_route, "get_provider", fail_get_provider)
    monkeypatch.setattr(
        candles_route.yahoo,
        "get_candle_history",
        lambda exchange, symbol, interval, from_date, to_date: [
            Candle(exchange=exchange, symbol=symbol, interval=interval, open=1, high=1, low=1, close=1, volume=1, timestamp=f"{from_date}T00:00:00", provider="yahoo")
        ],
    )

    candles = candles_route.get_candle_history("NSE", "ABB", "daily", date(2026, 1, 1), date(2026, 6, 1), source="yahoo")

    assert candles[0].provider == "yahoo"


def test_source_yahoo_and_default_source_are_separate_cache_entries(monkeypatch):
    provider = FakeProvider()
    yahoo_calls = []
    monkeypatch.setattr(candles_route, "get_provider", lambda exchange: provider)
    monkeypatch.setattr(
        candles_route.yahoo,
        "get_candle_history",
        lambda exchange, symbol, interval, from_date, to_date: yahoo_calls.append(1)
        or [Candle(exchange=exchange, symbol=symbol, interval=interval, open=1, high=1, low=1, close=1, volume=1, timestamp=f"{from_date}T00:00:00", provider="yahoo")],
    )

    from_date, to_date = date(2026, 1, 1), date(2026, 6, 1)
    candles_route.get_candle_history("NSE", "ABB", "daily", from_date, to_date, source="yahoo")
    candles_route.get_candle_history("NSE", "ABB", "daily", from_date, to_date)  # no source - Dhan path

    assert len(yahoo_calls) == 1
    assert provider.call_count == 1


def test_cache_status_and_clear_are_source_scoped(monkeypatch):
    monkeypatch.setattr(
        candles_route.yahoo,
        "get_candle_history",
        lambda exchange, symbol, interval, from_date, to_date: [
            Candle(exchange=exchange, symbol=symbol, interval=interval, open=1, high=1, low=1, close=1, volume=1, timestamp=f"{from_date}T00:00:00", provider="yahoo")
        ],
    )

    from_date, to_date = date(2026, 1, 1), date(2026, 6, 1)
    candles_route.get_candle_history("NSE", "ABB", "daily", from_date, to_date, source="yahoo")

    assert candles_route.get_candle_cache_status("NSE", "ABB", "daily", from_date, to_date, source="yahoo").cached is True
    assert candles_route.get_candle_cache_status("NSE", "ABB", "daily", from_date, to_date).cached is False  # no source - different key

    candles_route.clear_candle_cache_entry("NSE", "ABB", "daily", from_date, to_date)  # clearing the no-source key...
    assert candles_route.get_candle_cache_status("NSE", "ABB", "daily", from_date, to_date, source="yahoo").cached is True  # ...leaves yahoo's untouched
