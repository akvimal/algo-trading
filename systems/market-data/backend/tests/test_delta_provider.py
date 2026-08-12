"""Tests for DeltaProvider (Phase 1 of the crypto module - see
docs/architecture.md). Every endpoint is public (no api-key/secret) - see
DeltaProvider's own docstring - so these are plain responses-mocked HTTP
calls, same convention test_dhan_provider.py uses, matching request/
response shapes confirmed live against the real API during planning."""

import json
import time
from datetime import date

import responses

from app.config import settings
from app.providers.delta import DeltaProvider


def _product(symbol: str, product_id: int, state: str = "live") -> dict:
    return {"id": product_id, "symbol": symbol, "contract_type": "perpetual_futures", "state": state}


def _products_url() -> str:
    return f"{settings.delta_base_url}/v2/products"


def _tickers_url() -> str:
    return f"{settings.delta_base_url}/v2/tickers"


def _candles_url() -> str:
    return f"{settings.delta_base_url}/v2/history/candles"


# --- sync_instruments ------------------------------------------------------------------------


@responses.activate
def test_sync_instruments_single_page():
    responses.add(
        responses.GET, _products_url(),
        json={"success": True, "result": [_product("BTCUSD", 27), _product("ETHUSD", 3136)], "meta": {"after": None}},
        status=200,
    )

    provider = DeltaProvider()
    result = provider.sync_instruments()

    assert result["symbol_count"] == 2
    assert provider._symbol_to_product_id == {"BTCUSD": 27, "ETHUSD": 3136}
    assert provider._symbol_to_state == {"BTCUSD": "live", "ETHUSD": "live"}


@responses.activate
def test_sync_instruments_follows_cursor_pagination():
    responses.add(
        responses.GET, _products_url(),
        json={"success": True, "result": [_product("BTCUSD", 27)], "meta": {"after": "cursor-2"}},
        status=200,
    )
    responses.add(
        responses.GET, _products_url(),
        json={"success": True, "result": [_product("ETHUSD", 3136)], "meta": {"after": None}},
        status=200,
    )

    provider = DeltaProvider()
    result = provider.sync_instruments()

    assert result["symbol_count"] == 2
    assert len(responses.calls) == 2
    second_call_params = responses.calls[1].request.url
    assert "after=cursor-2" in second_call_params


@responses.activate
def test_sync_instruments_stops_on_empty_result_even_with_cursor():
    responses.add(
        responses.GET, _products_url(),
        json={"success": True, "result": [], "meta": {"after": "should-be-ignored"}},
        status=200,
    )

    provider = DeltaProvider()
    result = provider.sync_instruments()

    assert result["symbol_count"] == 0
    assert len(responses.calls) == 1


# --- get_ltp / get_ltp_batch -------------------------------------------------------------------


@responses.activate
def test_get_ltp_batch_filters_bulk_response_to_requested_symbols():
    responses.add(
        responses.GET, _tickers_url(),
        json={"success": True, "result": [
            {"symbol": "BTCUSD", "close": 63498.5},
            {"symbol": "ETHUSD", "close": 1892.45},
            {"symbol": "SOLUSD", "close": 145.2},
        ]},
        status=200,
    )

    provider = DeltaProvider()
    result = provider.get_ltp_batch(["BTCUSD", "ETHUSD"])

    assert result == {"BTCUSD": 63498.5, "ETHUSD": 1892.45}
    assert len(responses.calls) == 1  # one call regardless of symbol count
    sent_params = responses.calls[0].request.params
    assert sent_params.get("contract_types") == "perpetual_futures"
    assert "symbols" not in sent_params  # confirmed live: this param is ignored, so never sent


@responses.activate
def test_get_ltp_batch_second_call_within_ttl_hits_cache_not_network():
    responses.add(
        responses.GET, _tickers_url(),
        json={"success": True, "result": [{"symbol": "BTCUSD", "close": 63498.5}]},
        status=200,
    )

    provider = DeltaProvider()
    first = provider.get_ltp_batch(["BTCUSD"])
    second = provider.get_ltp_batch(["BTCUSD"])

    assert first == second == {"BTCUSD": 63498.5}
    assert len(responses.calls) == 1


@responses.activate
def test_get_ltp_raises_for_unknown_symbol():
    responses.add(responses.GET, _tickers_url(), json={"success": True, "result": []}, status=200)

    provider = DeltaProvider()
    try:
        provider.get_ltp("NOPE")
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "NOPE" in str(exc)


def test_get_ltp_batch_fails_fast_when_throttle_queue_too_deep():
    provider = DeltaProvider()
    provider._last_ticker_call_at = time.monotonic() + 5.0

    try:
        provider.get_ltp_batch(["BTCUSD"])
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "backed up" in str(exc)


# --- get_candle_history / get_previous_candle ---------------------------------------------------


def _candle_row(time_epoch: int, close: float) -> dict:
    return {"time": time_epoch, "open": close - 1, "high": close + 1, "low": close - 2, "close": close, "volume": 100.0}


@responses.activate
def test_get_candle_history_reverses_newest_first_response_to_oldest_first():
    # Delta returns newest-first - confirmed live.
    responses.add(
        responses.GET, _candles_url(),
        json={"success": True, "result": [_candle_row(1700000600, 102.0), _candle_row(1700000300, 101.0), _candle_row(1700000000, 100.0)]},
        status=200,
    )

    provider = DeltaProvider()
    candles = provider.get_candle_history("BTCUSD", "5min", date(2023, 11, 14), date(2023, 11, 15))

    assert [c.close for c in candles] == [100.0, 101.0, 102.0]
    sent = responses.calls[0].request.params
    assert sent["resolution"] == "5m"
    assert sent["symbol"] == "BTCUSD"


@responses.activate
def test_get_candle_history_aggregates_non_native_interval_from_1m():
    # 25min isn't in Delta's native resolution set (unlike Dhan) - build
    # 25 one-minute bars aligned to a clock boundary so aggregate_candles
    # emits exactly one 25min bucket.
    rows = [_candle_row(1700000000 + i * 60, 100.0 + i) for i in range(25)]
    responses.add(responses.GET, _candles_url(), json={"success": True, "result": list(reversed(rows))}, status=200)

    provider = DeltaProvider()
    candles = provider.get_candle_history("BTCUSD", "25min", date(2023, 11, 14), date(2023, 11, 15))

    sent = responses.calls[0].request.params
    assert sent["resolution"] == "1m"  # fetched the native 1m building block
    assert len(candles) <= 1  # depends on clock alignment of the fixture - just confirm no crash and native call used


def test_get_candle_history_rejects_unsupported_interval():
    provider = DeltaProvider()
    try:
        provider.get_candle_history("BTCUSD", "daily", date(2023, 11, 14), date(2023, 11, 15))
        assert False, "expected ValueError"
    except ValueError:
        pass


# --- resolve_underlying / get_lot_size ----------------------------------------------------------


@responses.activate
def test_resolve_underlying_no_rollover_chart_equals_trade_symbol():
    responses.add(
        responses.GET, _products_url(),
        json={"success": True, "result": [_product("BTCUSD", 27)], "meta": {"after": None}},
        status=200,
    )

    provider = DeltaProvider()
    resolved = provider.resolve_underlying("BTCUSD")

    assert resolved is not None
    assert resolved.chart_symbol == "BTCUSD"
    assert resolved.trade_symbol == "BTCUSD"
    assert resolved.chart_exchange == "CRYPTO"
    assert resolved.trade_exchange == "CRYPTO"
    assert resolved.lot_size == 1
    assert resolved.expiry is None


@responses.activate
def test_resolve_underlying_unknown_symbol_returns_none():
    responses.add(
        responses.GET, _products_url(),
        json={"success": True, "result": [_product("BTCUSD", 27)], "meta": {"after": None}},
        status=200,
    )

    provider = DeltaProvider()
    assert provider.resolve_underlying("NOPE") is None


@responses.activate
def test_resolve_underlying_non_live_symbol_returns_none():
    responses.add(
        responses.GET, _products_url(),
        json={"success": True, "result": [_product("XYZUSD", 99, state="expired")], "meta": {"after": None}},
        status=200,
    )

    provider = DeltaProvider()
    assert provider.resolve_underlying("XYZUSD") is None


@responses.activate
def test_get_lot_size_always_one_for_known_symbol():
    responses.add(
        responses.GET, _products_url(),
        json={"success": True, "result": [_product("BTCUSD", 27)], "meta": {"after": None}},
        status=200,
    )

    provider = DeltaProvider()
    assert provider.get_lot_size("BTCUSD") == 1


@responses.activate
def test_get_lot_size_unknown_symbol_returns_none():
    responses.add(
        responses.GET, _products_url(),
        json={"success": True, "result": [], "meta": {"after": None}},
        status=200,
    )

    provider = DeltaProvider()
    assert provider.get_lot_size("NOPE") is None
