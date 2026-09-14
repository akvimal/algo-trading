"""Tests for GET /order-blocks' source=yahoo support (app/api/routes/
order_blocks.py) - added so a "daily" detection timeframe can run
structure detection without a live Dhan/Delta token, mirroring GET
/candles/history's own source=yahoo flag (see fetch_candle_history_cached,
shared by both routes). Calls the route function directly with a
monkeypatched get_provider, same "plain fakes, no TestClient" convention
tests/test_candles_route_cache.py already uses for this backend."""

from datetime import date

import app.api.routes.candles as candles_route
import app.api.routes.order_blocks as order_blocks_route
from app.domain.models import Candle


def _candle(ts: str) -> Candle:
    return Candle(exchange="NSE", symbol="ABB", interval="daily", open=100, high=102, low=99, close=101, volume=1000, timestamp=ts, provider="yahoo")


def test_source_yahoo_never_resolves_a_quote_provider(monkeypatch):
    def fail_get_provider(exchange):
        raise AssertionError("source=yahoo must not call get_provider at all")

    monkeypatch.setattr(order_blocks_route, "get_provider", fail_get_provider)
    monkeypatch.setattr(
        candles_route.yahoo,
        "get_candle_history",
        lambda exchange, symbol, interval, from_date, to_date: [_candle(f"{from_date}T00:00:00"), _candle(f"{to_date}T00:00:00")],
    )
    candles_route._history_cache.clear()

    result = order_blocks_route.get_order_blocks(
        "NSE", "ABB", "daily", from_=date(2026, 1, 1), to=date(2026, 6, 1), source="yahoo",
    )

    assert result.order_blocks == []  # too few bars to detect anything - just checking it didn't error/touch Dhan
    candles_route._history_cache.clear()


def test_no_source_still_resolves_the_quote_provider(monkeypatch):
    calls = []

    class FakeProvider:
        def get_candle_history(self, symbol, interval, from_date, to_date, credentials=None):
            return [_candle(f"{from_date}T09:15:00")]

    def get_provider(exchange):
        calls.append(exchange)
        return FakeProvider()

    monkeypatch.setattr(order_blocks_route, "get_provider", get_provider)
    candles_route._history_cache.clear()

    order_blocks_route.get_order_blocks("NSE", "ABB", "15min", from_=date(2026, 1, 1), to=date(2026, 1, 5))

    assert calls == ["NSE"]
    candles_route._history_cache.clear()
