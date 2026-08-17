"""Tests for GET /candles/history's own caching (app/api/routes/candles.py)
- added so repeated backtest re-runs against the same (exchange, symbol,
interval, from, to) don't re-fetch from the real provider every time a
caller changes only an exit-config knob that doesn't affect what candles
get fetched at all. Calls the route function directly with a monkeypatched
get_provider, same "plain fakes, no real HTTP/TestClient" convention
signal-generation's own route tests already use - this backend has no
TestClient-based route test layer either (confirmed: no conftest.py, no
TestClient usage anywhere in tests/)."""

from datetime import date, timedelta

import pytest

import app.api.routes.candles as candles_route
from app.domain.models import Candle


class FakeProvider:
    def __init__(self):
        self.call_count = 0

    def get_candle_history(self, symbol, interval, from_date, to_date):
        self.call_count += 1
        return [Candle(exchange="NSE", symbol=symbol, interval=interval, open=1, high=1, low=1, close=1, timestamp=f"{from_date}T09:15:00", provider="fake")]


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


def test_history_cache_ttl_historical_range_is_long():
    yesterday = date.today() - timedelta(days=1)
    assert candles_route._history_cache_ttl_seconds("15min", yesterday) == candles_route._HISTORICAL_RANGE_TTL_SECONDS


def test_history_cache_ttl_range_including_today_scoped_to_interval():
    today = date.today()
    assert candles_route._history_cache_ttl_seconds("15min", today) == 15 * 60
    assert candles_route._history_cache_ttl_seconds("60min", today) == 60 * 60


def test_history_cache_ttl_daily_interval_gets_a_long_fallback():
    assert candles_route._history_cache_ttl_seconds("daily", date.today()) == 1440 * 60


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
