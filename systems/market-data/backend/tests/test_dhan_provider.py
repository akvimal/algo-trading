import json
import time

import responses

from app.config import settings
from app.providers.dhan import LTP_URL, INSTRUMENT_MASTER_URL, DhanProvider

FAKE_CSV = (
    "SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,"
    "SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,"
    "SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME\n"
    "NSE,E,2885,EQUITY,0,RELIANCE,1.0,Reliance Industries,,,,10.0000,NA,ES,EQ,RELIANCE INDUSTRIES LTD\n"
    # non-equity / non-NSE rows must be filtered out
    "NSE,D,824088,OPTSTK,0,RELIANCE,500.0,RELIANCE OPT,2026-08-27,1320.0,CE,5.0,M,OPTSTK,,RELIANCE\n"
    "BSE,E,999,EQUITY,0,RELIANCE,1.0,Reliance,,,,10.0,NA,ES,EQ,RELIANCE INDUSTRIES LTD\n"
)


@responses.activate
def test_sync_instruments_filters_to_nse_cash_equity():
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=FAKE_CSV, status=200)

    provider = DhanProvider()
    result = provider.sync_instruments()

    assert result["symbol_count"] == 1
    assert provider._symbol_to_security_id == {"RELIANCE": "2885"}


@responses.activate
def test_get_ltp_success(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=FAKE_CSV, status=200)
    responses.add(
        responses.POST,
        LTP_URL,
        body=json.dumps({"data": {"NSE_EQ": {"2885": {"last_price": 2500.5}}}}, ),
        status=200,
    )

    provider = DhanProvider()
    price = provider.get_ltp("RELIANCE")

    assert price == 2500.5


@responses.activate
def test_get_ltp_unknown_symbol_raises(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")
    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=FAKE_CSV, status=200)

    provider = DhanProvider()
    try:
        provider.get_ltp("NOPE")
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "no LTP available" in str(exc)


def test_get_ltp_without_credentials_raises(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "")
    monkeypatch.setattr(settings, "dhan_access_token", "")

    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885"}  # skip the sync call
    try:
        provider.get_ltp("RELIANCE")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "DHAN_CLIENT_ID" in str(exc)


@responses.activate
def test_get_ltp_second_call_within_ttl_hits_cache_not_network(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=FAKE_CSV, status=200)
    # Only one LTP response registered - a second network call would raise
    # ConnectionError from `responses`, proving the cache was used instead.
    responses.add(
        responses.POST,
        LTP_URL,
        json={"data": {"NSE_EQ": {"2885": {"last_price": 2500.5}}}},
        status=200,
    )

    provider = DhanProvider()
    first = provider.get_ltp("RELIANCE")
    second = provider.get_ltp("RELIANCE")

    assert first == second == 2500.5


def test_get_ltp_fails_fast_when_throttle_queue_too_deep(monkeypatch):
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "test-token")

    provider = DhanProvider()
    provider._symbol_to_security_id = {"RELIANCE": "2885"}  # skip the sync call
    # Simulate several requests already queued ahead - implied wait ends
    # up well past MAX_THROTTLE_WAIT_SECONDS, so this should raise
    # immediately rather than block the test (or a real request) for
    # several seconds.
    provider._last_ltp_call_at = time.monotonic() + 3.0

    try:
        provider.get_ltp("RELIANCE")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "backed up" in str(exc)
