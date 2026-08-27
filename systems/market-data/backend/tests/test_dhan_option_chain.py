"""Tests for DhanProvider.get_expiry_list/get_option_chain (Phase 4a of
the options trading module - see docs/architecture.md). Mocked Dhan
responses match the real, documented shape
(https://docs.dhanhq.co/api/v2/option-chain/get-option-chain), trimmed to
a couple of strikes - same "plain fakes/responses over a real network
call" convention as test_dhan_provider.py."""

import json
import time

import responses

from app.config import settings
from app.providers.dhan import LTP_URL, NSE_INDEX, OPTION_CHAIN_URL, OPTION_EXPIRY_LIST_URL, DhanProvider


def _leg(security_id: str, last_price: float, oi: int, delta: float) -> dict:
    return {
        "security_id": security_id,
        "last_price": last_price,
        "oi": oi,
        "previous_oi": oi - 100,
        "volume": 12345,
        "previous_volume": 11000,
        "average_price": last_price,
        "previous_close_price": last_price - 1,
        "implied_volatility": 14.5,
        "top_bid_price": last_price - 0.5,
        "top_bid_quantity": 50,
        "top_ask_price": last_price + 0.5,
        "top_ask_quantity": 50,
        "greeks": {"delta": delta, "theta": -2.1, "gamma": 0.001, "vega": 3.4},
    }


FAKE_CHAIN_RESPONSE = {
    "data": {
        "last_price": 24000.0,
        "oc": {
            "23950": {"ce": _leg("111", 120.5, 500000, 0.62), "pe": _leg("112", 65.0, 300000, -0.38)},
            "24000": {"ce": _leg("113", 90.0, 800000, 0.50), "pe": _leg("114", 88.0, 750000, -0.50)},
            "24050": {"ce": _leg("115", 65.0, 300000, 0.38), "pe": _leg("116", 118.0, 400000, -0.62)},
        },
    },
    "status": "success",
}


def _provider_with_nifty() -> DhanProvider:
    provider = DhanProvider([NSE_INDEX], name="dhan-nse")
    provider._symbol_to_security_id = {"NIFTY": "13"}
    provider._symbol_to_config = {"NIFTY": NSE_INDEX}
    return provider


@responses.activate
def test_get_expiry_list_success(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    responses.add(responses.POST, OPTION_EXPIRY_LIST_URL, body=json.dumps({"data": ["2026-08-14", "2026-08-21"]}), status=200)

    provider = _provider_with_nifty()
    result = provider.get_expiry_list("NIFTY")

    assert result == ["2026-08-14", "2026-08-21"]
    sent = json.loads(responses.calls[0].request.body)
    assert sent == {"UnderlyingScrip": 13, "UnderlyingSeg": "IDX_I"}


@responses.activate
def test_get_expiry_list_second_call_within_ttl_hits_cache_not_network(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    responses.add(responses.POST, OPTION_EXPIRY_LIST_URL, body=json.dumps({"data": ["2026-08-14", "2026-08-21"]}), status=200)

    provider = _provider_with_nifty()
    first = provider.get_expiry_list("NIFTY")
    second = provider.get_expiry_list("NIFTY")

    assert first == second
    assert len(responses.calls) == 1


def test_get_expiry_list_unknown_symbol_returns_none(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    provider = _provider_with_nifty()
    assert provider.get_expiry_list("NOPE") is None


@responses.activate
def test_get_option_chain_parses_strikes_and_moneyness(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    responses.add(responses.POST, OPTION_CHAIN_URL, body=json.dumps(FAKE_CHAIN_RESPONSE), status=200)

    provider = _provider_with_nifty()
    chain = provider.get_option_chain("NIFTY", "2026-08-14")

    assert chain is not None
    assert chain.underlying_symbol == "NIFTY"
    assert chain.underlying_last_price == 24000.0
    assert [s.strike for s in chain.strikes] == [23950.0, 24000.0, 24050.0]

    atm = chain.strikes[1]
    assert atm.ce.moneyness == "ATM"
    assert atm.pe.moneyness == "ATM"
    itm_call_strike = chain.strikes[0]  # 23950 < spot -> ITM call, OTM put
    assert itm_call_strike.ce.moneyness == "ITM"
    assert itm_call_strike.pe.moneyness == "OTM"
    otm_call_strike = chain.strikes[2]  # 24050 > spot -> OTM call, ITM put
    assert otm_call_strike.ce.moneyness == "OTM"
    assert otm_call_strike.pe.moneyness == "ITM"

    assert atm.ce.greeks.delta == 0.50
    assert atm.ce.oi == 800000
    assert atm.ce.implied_volatility == 14.5


@responses.activate
def test_get_option_chain_sends_resolved_underlying_and_expiry(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    responses.add(responses.POST, OPTION_CHAIN_URL, body=json.dumps(FAKE_CHAIN_RESPONSE), status=200)

    provider = _provider_with_nifty()
    provider.get_option_chain("NIFTY", "2026-08-14")

    sent = json.loads(responses.calls[0].request.body)
    assert sent == {"UnderlyingScrip": 13, "UnderlyingSeg": "IDX_I", "Expiry": "2026-08-14"}


def test_get_option_chain_unknown_symbol_returns_none(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    provider = _provider_with_nifty()
    assert provider.get_option_chain("NOPE", "2026-08-14") is None


@responses.activate
def test_get_option_chain_second_call_within_ttl_hits_cache_not_network(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    responses.add(responses.POST, OPTION_CHAIN_URL, body=json.dumps(FAKE_CHAIN_RESPONSE), status=200)
    # get_option_chain also fetches a fresh, independent LTP to override
    # the optionchain response's own (sometimes stale/wrong - see
    # get_option_chain's own comment) `last_price` - one extra network
    # call on an actual (non-cached) fetch.
    responses.add(
        responses.POST, LTP_URL, body=json.dumps({"data": {"IDX_I": {"13": {"last_price": 24000.0}}}}), status=200
    )

    provider = _provider_with_nifty()
    first = provider.get_option_chain("NIFTY", "2026-08-14")
    second = provider.get_option_chain("NIFTY", "2026-08-14")

    assert first is second
    # 1 optionchain POST + 1 LTP POST for the first (real) fetch; the
    # second call is served entirely from cache, adding none of either.
    assert len(responses.calls) == 2


def test_get_option_chain_without_credentials_raises(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "")
    monkeypatch.setattr(settings, "dhan_access_token", "")

    provider = _provider_with_nifty()
    try:
        provider.get_option_chain("NIFTY", "2026-08-14")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "DHAN_CLIENT_ID" in str(exc)


def test_get_option_chain_fails_fast_when_throttle_queue_too_deep(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    provider = _provider_with_nifty()
    # Simulate a request already in-flight far enough ahead that the
    # implied wait exceeds MAX_THROTTLE_WAIT_SECONDS - should raise
    # immediately rather than block the test for several seconds.
    provider._last_option_chain_call_at[None] = time.monotonic() + 5.0

    try:
        provider.get_option_chain("NIFTY", "2026-08-14")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "backed up" in str(exc)


@responses.activate
def test_get_option_chain_records_oi_history_on_real_fetch_only(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    responses.add(responses.POST, OPTION_CHAIN_URL, body=json.dumps(FAKE_CHAIN_RESPONSE), status=200)
    responses.add(
        responses.POST, LTP_URL, body=json.dumps({"data": {"IDX_I": {"13": {"last_price": 24000.0}}}}), status=200
    )

    provider = _provider_with_nifty()
    provider.get_option_chain("NIFTY", "2026-08-14")
    key = ("NIFTY", "2026-08-14", 24000.0, "CE")
    assert len(provider._oi_history[key]) == 1
    assert provider._oi_history[key][0][1] == 800000
    assert len(provider._price_history[key]) == 1

    # Second call is served from cache (see the TTL test above) - must NOT
    # append a second, redundant sample for the same unchanged OI.
    provider.get_option_chain("NIFTY", "2026-08-14")
    assert len(provider._oi_history[key]) == 1
    assert len(provider._price_history[key]) == 1


def test_get_oi_changes_no_history_returns_none():
    provider = _provider_with_nifty()
    change_5m, change_15m = provider.get_oi_changes("NIFTY", "2026-08-14", 24000.0, "CE", current_oi=800000)
    assert change_5m is None
    assert change_15m is None


def test_get_oi_changes_diffs_against_closest_sample_at_or_before_target(monkeypatch):
    provider = _provider_with_nifty()
    key = ("NIFTY", "2026-08-14", 24000.0, "CE")
    now = time.time()
    # Oldest first, matching how _record_oi_history actually appends.
    provider._oi_history[key] = [
        (now - 20 * 60, 700000),  # 20 min ago - anchor for the 15m window (nothing between this and 14m ago)
        (now - 14 * 60, 750000),  # 14 min ago - too recent for the 15m window
        (now - 6 * 60, 770000),  # 6 min ago - anchor for the 5m window
        (now - 4 * 60, 780000),  # 4 min ago - too recent for the 5m window
    ]
    monkeypatch.setattr(time, "time", lambda: now)

    change_5m, change_15m = provider.get_oi_changes("NIFTY", "2026-08-14", 24000.0, "CE", current_oi=800000)

    assert change_5m == 800000 - 770000
    assert change_15m == 800000 - 700000


def test_get_oi_changes_scoped_to_symbol_expiry_strike_and_option_type():
    provider = _provider_with_nifty()
    now = time.time()
    provider._oi_history[("NIFTY", "2026-08-14", 24000.0, "CE")] = [(now - 20 * 60, 700000)]
    # A PE at the same strike/expiry, and a CE at a different strike -
    # neither should leak into the CE@24000 lookup above.
    provider._oi_history[("NIFTY", "2026-08-14", 24000.0, "PE")] = [(now - 20 * 60, 111111)]
    provider._oi_history[("NIFTY", "2026-08-14", 24050.0, "CE")] = [(now - 20 * 60, 222222)]

    change_5m, change_15m = provider.get_oi_changes("NIFTY", "2026-08-14", 24000.0, "CE", current_oi=900000)

    assert change_5m == 900000 - 700000
    assert change_15m == 900000 - 700000


def test_get_price_changes_no_history_returns_none():
    provider = _provider_with_nifty()
    change_5m, change_15m = provider.get_price_changes("NIFTY", "2026-08-14", 24000.0, "CE", current_price=150.0)
    assert change_5m is None
    assert change_15m is None


def test_get_price_changes_diffs_against_closest_sample_at_or_before_target(monkeypatch):
    provider = _provider_with_nifty()
    key = ("NIFTY", "2026-08-14", 24000.0, "CE")
    now = time.time()
    provider._price_history[key] = [
        (now - 20 * 60, 120.0),  # anchor for the 15m window
        (now - 14 * 60, 130.0),  # too recent for the 15m window
        (now - 6 * 60, 140.0),  # anchor for the 5m window
        (now - 4 * 60, 145.0),  # too recent for the 5m window
    ]
    monkeypatch.setattr(time, "time", lambda: now)

    change_5m, change_15m = provider.get_price_changes("NIFTY", "2026-08-14", 24000.0, "CE", current_price=150.0)

    assert change_5m == 150.0 - 140.0
    assert change_15m == 150.0 - 120.0
