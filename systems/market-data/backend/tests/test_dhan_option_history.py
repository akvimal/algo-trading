"""Tests for DhanProvider.get_option_leg_history (Phase 4c of the options
trading module - backtesting data source, see docs/architecture.md).
Mocked Dhan responses match the documented rollingoption shape - same
"plain fakes/responses over a real network call" convention as
test_dhan_option_chain.py."""

import json
import time
from datetime import date

import responses

from app.config import settings
from app.providers.dhan import MCX_FUTCOM, NSE_EQ, NSE_INDEX, ROLLING_OPTION_URL, DhanProvider


def _ce_response(closes: list[float], timestamps: list[int]) -> dict:
    return {
        "data": {
            "ce": {
                "open": closes,
                "high": closes,
                "low": closes,
                "close": closes,
                "timestamp": timestamps,
            },
            "pe": None,
        }
    }


def _provider_with_nifty() -> DhanProvider:
    provider = DhanProvider([NSE_INDEX], name="dhan-nse")
    provider._symbol_to_security_id = {"NIFTY": "13"}
    provider._symbol_to_config = {"NIFTY": NSE_INDEX}
    return provider


def _provider_with_reliance() -> DhanProvider:
    provider = DhanProvider([NSE_EQ], name="dhan-nse")
    provider._symbol_to_security_id = {"RELIANCE": "500"}
    provider._symbol_to_config = {"RELIANCE": NSE_EQ}
    return provider


def _provider_with_goldm() -> DhanProvider:
    provider = DhanProvider([MCX_FUTCOM], name="dhan-mcx")
    provider._symbol_to_security_id = {"GOLDM-04Sep2026-FUT": "700"}
    provider._symbol_to_config = {"GOLDM-04Sep2026-FUT": MCX_FUTCOM}
    return provider


@responses.activate
def test_get_option_leg_history_sends_correct_request_for_index(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    responses.add(responses.POST, ROLLING_OPTION_URL, body=json.dumps(_ce_response([100.0], [1755000000])), status=200)

    provider = _provider_with_nifty()
    result = provider.get_option_leg_history("NIFTY", "CE", "ATM", "WEEK", 0, "5", date(2026, 8, 1), date(2026, 8, 5))

    assert result is not None
    assert len(result) == 1
    assert result[0].close == 100.0
    sent = json.loads(responses.calls[0].request.body)
    assert sent == {
        "securityId": 13,
        "exchangeSegment": "NSE_FNO",
        "instrument": "OPTIDX",
        "expiryFlag": "WEEK",
        "expiryCode": 0,
        "strike": "ATM",
        "drvOptionType": "CALL",
        "requiredData": ["open", "high", "low", "close"],
        "fromDate": "2026-08-01",
        "toDate": "2026-08-05",
        "interval": "5",
    }


@responses.activate
def test_get_option_leg_history_uses_optstk_for_equity(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    responses.add(responses.POST, ROLLING_OPTION_URL, body=json.dumps(_ce_response([], [])), status=200)

    provider = _provider_with_reliance()
    provider.get_option_leg_history("RELIANCE", "PE", "ATM-2", "MONTH", 0, "5", date(2026, 8, 1), date(2026, 8, 5))

    sent = json.loads(responses.calls[0].request.body)
    assert sent["instrument"] == "OPTSTK"
    assert sent["exchangeSegment"] == "NSE_FNO"
    assert sent["drvOptionType"] == "PUT"


def test_get_option_leg_history_returns_none_for_mcx(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    provider = _provider_with_goldm()
    result = provider.get_option_leg_history(
        "GOLDM-04Sep2026-FUT", "CE", "ATM", "MONTH", 0, "5", date(2026, 8, 1), date(2026, 8, 5)
    )
    assert result is None


def test_get_option_leg_history_unknown_symbol_returns_none(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    provider = _provider_with_nifty()
    result = provider.get_option_leg_history("NOPE", "CE", "ATM", "WEEK", 0, "5", date(2026, 8, 1), date(2026, 8, 5))
    assert result is None


@responses.activate
def test_get_option_leg_history_chunks_ranges_over_30_days(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    responses.add(responses.POST, ROLLING_OPTION_URL, body=json.dumps(_ce_response([100.0], [1755000000])), status=200)
    responses.add(responses.POST, ROLLING_OPTION_URL, body=json.dumps(_ce_response([110.0], [1757700000])), status=200)

    provider = _provider_with_nifty()
    # 45-day range -> two chunks (<=30 days each).
    result = provider.get_option_leg_history(
        "NIFTY", "CE", "ATM", "WEEK", 0, "5", date(2026, 8, 1), date(2026, 9, 14)
    )

    assert result is not None
    assert len(result) == 2
    assert len(responses.calls) == 2
    first_body = json.loads(responses.calls[0].request.body)
    second_body = json.loads(responses.calls[1].request.body)
    assert first_body["fromDate"] == "2026-08-01"
    assert first_body["toDate"] == "2026-08-30"
    assert second_body["fromDate"] == "2026-08-31"
    assert second_body["toDate"] == "2026-09-14"


def test_get_option_leg_history_without_credentials_raises(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "")
    monkeypatch.setattr(settings, "dhan_access_token", "")

    provider = _provider_with_nifty()
    try:
        provider.get_option_leg_history("NIFTY", "CE", "ATM", "WEEK", 0, "5", date(2026, 8, 1), date(2026, 8, 5))
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "DHAN_CLIENT_ID" in str(exc)


def test_get_option_leg_history_fails_fast_when_throttle_queue_too_deep(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    provider = _provider_with_nifty()
    provider._last_option_chain_call_at[None] = time.monotonic() + 5.0
    try:
        provider.get_option_leg_history("NIFTY", "CE", "ATM", "WEEK", 0, "5", date(2026, 8, 1), date(2026, 8, 5))
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "backed up" in str(exc)
