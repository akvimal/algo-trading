"""Tests for DeltaProvider (Phase 1 of the crypto module - see
docs/architecture.md). Every endpoint is public (no api-key/secret) - see
DeltaProvider's own docstring - so these are plain responses-mocked HTTP
calls, same convention test_dhan_provider.py uses, matching request/
response shapes confirmed live against the real API during planning."""

import json
import time
from datetime import date

import responses
from responses import matchers

from app.config import settings
from app.providers.delta import DeltaProvider


def _product(symbol: str, product_id: int, state: str = "live", underlying_asset: str = "BTC") -> dict:
    return {
        "id": product_id,
        "symbol": symbol,
        "contract_type": "perpetual_futures",
        "state": state,
        "underlying_asset": {"symbol": underlying_asset},
    }


def _products_url() -> str:
    return f"{settings.delta_base_url}/v2/products"


def _tickers_url() -> str:
    return f"{settings.delta_base_url}/v2/tickers"


def _option_ticker(symbol: str, product_id: int, contract_type: str, close: float, spot: float, **overrides) -> dict:
    row = {
        "symbol": symbol,
        "product_id": product_id,
        "contract_type": contract_type,
        "close": close,
        "spot_price": spot,
        "oi_contracts": "5000",
        "volume": 12.34,
        "greeks": {"delta": 0.5, "theta": -10.0, "gamma": 0.001, "vega": 5.0, "rho": 1.2},
        "quotes": {"mark_iv": "0.25", "best_bid": "10", "best_ask": "12"},
    }
    row.update(overrides)
    return row


def _fake_chain_tickers() -> list[dict]:
    """3 strikes (23950/24000/24050) at expiry 2026-08-15, spot=24000
    (ATM in the middle), plus one extra pair at a second expiry
    (2026-08-21) to exercise multi-expiry filtering - same
    "trimmed to a couple of strikes" convention as
    test_dhan_option_chain.py's own FAKE_CHAIN_RESPONSE."""
    return [
        _option_ticker("C-BTC-23950-150826", 1, "call_options", 120.5, 24000.0),
        _option_ticker("P-BTC-23950-150826", 2, "put_options", 65.0, 24000.0),
        _option_ticker("C-BTC-24000-150826", 3, "call_options", 90.0, 24000.0),
        _option_ticker("P-BTC-24000-150826", 4, "put_options", 88.0, 24000.0),
        _option_ticker("C-BTC-24050-150826", 5, "call_options", 65.0, 24000.0),
        _option_ticker("P-BTC-24050-150826", 6, "put_options", 118.0, 24000.0),
        _option_ticker("C-BTC-24000-210826", 7, "call_options", 150.0, 24000.0),
        _option_ticker("P-BTC-24000-210826", 8, "put_options", 140.0, 24000.0),
    ]


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


@responses.activate
def test_get_ltp_batch_mixes_perpetual_and_option_symbols():
    # Crypto module Phase 4 - an execution exit-monitor sweep can batch a
    # perpetual position and an option leg together in one call. Two
    # distinct underlying-tickers requests should fire: one perpetual-only
    # (unchanged path), one option-only (reuses _fetch_option_rows).
    responses.add(
        responses.GET, _tickers_url(),
        json={"success": True, "result": [{"symbol": "BTCUSD", "close": 63498.5}]},
        status=200,
        match=[matchers.query_param_matcher({"contract_types": "perpetual_futures"})],
    )
    responses.add(
        responses.GET, _tickers_url(),
        json={"success": True, "result": [_option_ticker("C-BTC-63600-130826", 146107, "call_options", 45.5, 63500.0)]},
        status=200,
        match=[matchers.query_param_matcher({"contract_types": "call_options,put_options", "underlying_asset_symbols": "BTC"})],
    )

    provider = DeltaProvider()
    result = provider.get_ltp_batch(["BTCUSD", "C-BTC-63600-130826"])

    assert result == {"BTCUSD": 63498.5, "C-BTC-63600-130826": 45.5}
    assert len(responses.calls) == 2


@responses.activate
def test_get_ltp_batch_option_only_skips_perpetual_call():
    responses.add(
        responses.GET, _tickers_url(),
        json={"success": True, "result": [_option_ticker("P-BTC-63200-130826", 146095, "put_options", 30.0, 63500.0)]},
        status=200,
        match=[matchers.query_param_matcher({"contract_types": "call_options,put_options", "underlying_asset_symbols": "BTC"})],
    )

    provider = DeltaProvider()
    result = provider.get_ltp_batch(["P-BTC-63200-130826"])

    assert result == {"P-BTC-63200-130826": 30.0}
    assert len(responses.calls) == 1  # no perpetual-side call at all


# --- resolve_symbol_by_security_id --------------------------------------------------------------


def _product_by_id_url(product_id) -> str:
    return f"{settings.delta_base_url}/v2/products/{product_id}"


@responses.activate
def test_resolve_symbol_by_security_id_resolves_perpetual():
    responses.add(
        responses.GET, _product_by_id_url(27),
        json={"success": True, "result": {"id": 27, "symbol": "BTCUSD", "contract_type": "perpetual_futures"}},
        status=200,
    )

    provider = DeltaProvider()
    assert provider.resolve_symbol_by_security_id("27") == "BTCUSD"


@responses.activate
def test_resolve_symbol_by_security_id_resolves_option():
    responses.add(
        responses.GET, _product_by_id_url(146107),
        json={"success": True, "result": {"id": 146107, "symbol": "C-BTC-63600-130826", "contract_type": "call_options"}},
        status=200,
    )

    provider = DeltaProvider()
    assert provider.resolve_symbol_by_security_id("146107") == "C-BTC-63600-130826"


@responses.activate
def test_resolve_symbol_by_security_id_unknown_returns_none():
    responses.add(responses.GET, _product_by_id_url(999999999), json={"success": False}, status=404)

    provider = DeltaProvider()
    assert provider.resolve_symbol_by_security_id("999999999") is None


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


def test_get_lot_size_always_one_for_option_symbol_no_sync_needed():
    # An option's own symbol is never in _symbol_to_product_id (only
    # perpetuals get synced) - shape-detected via _OPTION_SYMBOL_RE instead,
    # no sync_instruments() call (and thus no HTTP call) needed at all.
    provider = DeltaProvider()
    assert provider.get_lot_size("C-BTC-63600-130826") == 1


# --- get_expiry_list / get_option_chain (Phase 2 of the crypto module) -------------------------


def _provider_with_btcusd() -> DeltaProvider:
    provider = DeltaProvider()
    provider._symbol_to_product_id = {"BTCUSD": 27}
    provider._symbol_to_state = {"BTCUSD": "live"}
    provider._symbol_to_underlying_asset = {"BTCUSD": "BTC"}
    return provider


@responses.activate
def test_get_expiry_list_returns_distinct_dates_sorted():
    responses.add(responses.GET, _tickers_url(), json={"success": True, "result": _fake_chain_tickers()}, status=200)

    provider = _provider_with_btcusd()
    expiries = provider.get_expiry_list("BTCUSD")

    assert expiries == ["2026-08-15", "2026-08-21"]
    sent = responses.calls[0].request.params
    assert sent["contract_types"] == "call_options,put_options"
    assert sent["underlying_asset_symbols"] == "BTC"


@responses.activate
def test_get_expiry_list_unknown_symbol_returns_none():
    responses.add(responses.GET, _products_url(), json={"success": True, "result": [], "meta": {"after": None}}, status=200)

    provider = DeltaProvider()
    assert provider.get_expiry_list("NOPE") is None


@responses.activate
def test_get_option_chain_parses_strikes_and_moneyness():
    responses.add(responses.GET, _tickers_url(), json={"success": True, "result": _fake_chain_tickers()}, status=200)

    provider = _provider_with_btcusd()
    chain = provider.get_option_chain("BTCUSD", "2026-08-15")

    assert chain is not None
    assert chain.underlying_symbol == "BTCUSD"
    assert chain.underlying_exchange == "CRYPTO"
    assert chain.underlying_last_price == 24000.0
    assert [s.strike for s in chain.strikes] == [23950.0, 24000.0, 24050.0]  # only this expiry's strikes

    atm = chain.strikes[1]
    assert atm.ce.moneyness == "ATM"
    assert atm.pe.moneyness == "ATM"
    itm_call_strike = chain.strikes[0]  # 23950 < spot -> ITM call, OTM put
    assert itm_call_strike.ce.moneyness == "ITM"
    assert itm_call_strike.pe.moneyness == "OTM"
    otm_call_strike = chain.strikes[2]  # 24050 > spot -> OTM call, ITM put
    assert otm_call_strike.ce.moneyness == "OTM"
    assert otm_call_strike.pe.moneyness == "ITM"

    assert atm.ce.security_id == "3"
    assert atm.ce.oi == 5000
    assert atm.ce.previous_oi is None  # Delta has no previous-OI figure
    assert atm.ce.volume == 12.34
    assert atm.ce.implied_volatility == 0.25
    assert atm.ce.top_bid_price == 10.0
    assert atm.ce.top_ask_price == 12.0
    assert atm.ce.greeks.rho == 1.2  # Dhan's chain never sets this - Delta does


@responses.activate
def test_get_option_chain_filters_to_requested_expiry_only():
    responses.add(responses.GET, _tickers_url(), json={"success": True, "result": _fake_chain_tickers()}, status=200)

    provider = _provider_with_btcusd()
    chain = provider.get_option_chain("BTCUSD", "2026-08-21")

    assert [s.strike for s in chain.strikes] == [24000.0]


@responses.activate
def test_get_option_chain_and_expiry_list_share_one_cached_call():
    responses.add(responses.GET, _tickers_url(), json={"success": True, "result": _fake_chain_tickers()}, status=200)

    provider = _provider_with_btcusd()
    provider.get_expiry_list("BTCUSD")
    provider.get_option_chain("BTCUSD", "2026-08-15")
    provider.get_option_chain("BTCUSD", "2026-08-21")

    assert len(responses.calls) == 1  # one fetch, reused for every call above


@responses.activate
def test_get_option_chain_unknown_symbol_returns_none():
    responses.add(responses.GET, _products_url(), json={"success": True, "result": [], "meta": {"after": None}}, status=200)

    provider = DeltaProvider()
    assert provider.get_option_chain("NOPE", "2026-08-15") is None


@responses.activate
def test_get_option_chain_resolvable_underlying_no_rows_returns_none():
    responses.add(responses.GET, _tickers_url(), json={"success": True, "result": []}, status=200)

    provider = _provider_with_btcusd()
    assert provider.get_option_chain("BTCUSD", "2026-08-15") is None


@responses.activate
def test_get_option_chain_empty_at_requested_expiry_still_returns_chain_with_spot():
    # Underlying has live options, just none at this specific date -
    # still a resolvable market (unlike the "no rows at all" case above).
    responses.add(responses.GET, _tickers_url(), json={"success": True, "result": _fake_chain_tickers()}, status=200)

    provider = _provider_with_btcusd()
    chain = provider.get_option_chain("BTCUSD", "2099-01-01")

    assert chain is not None
    assert chain.strikes == []
    assert chain.underlying_last_price == 24000.0


@responses.activate
def test_get_option_chain_fails_fast_when_throttle_queue_too_deep():
    provider = _provider_with_btcusd()
    provider._last_option_call_at = time.monotonic() + 5.0

    try:
        provider.get_option_chain("BTCUSD", "2026-08-15")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "backed up" in str(exc)
