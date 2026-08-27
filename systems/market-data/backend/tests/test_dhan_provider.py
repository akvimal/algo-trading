import json
import time

import responses

from app.config import settings
from app.providers.dhan import LTP_URL, INSTRUMENT_MASTER_URL, DhanCredentials, DhanProvider

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
    provider._last_ltp_call_at[None] = time.monotonic() + 3.0

    try:
        provider.get_ltp("RELIANCE")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "backed up" in str(exc)


@responses.activate
def test_get_ltp_batch_uses_byo_credentials_over_the_platform_default(monkeypatch):
    """Phase 3 (BYO Dhan credentials, see docs/architecture.md) -
    passing a DhanCredentials must authenticate the outbound call with
    THAT client_id/access_token, not the platform-wide
    settings.dhan_client_id/current_access_token()."""
    monkeypatch.setattr(settings, "dhan_client_id", "platform-client")
    monkeypatch.setattr(settings, "dhan_access_token", "platform-token")

    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=FAKE_CSV, status=200)
    responses.add(responses.POST, LTP_URL, json={"data": {"NSE_EQ": {"2885": {"last_price": 2500.5}}}}, status=200)

    provider = DhanProvider()
    creds = DhanCredentials(client_id="user-client", access_token="user-token", throttle_key="user-1")
    price = provider.get_ltp("RELIANCE", credentials=creds)

    assert price == 2500.5
    sent = responses.calls[-1].request
    assert sent.headers["client-id"] == "user-client"
    assert sent.headers["access-token"] == "user-token"


@responses.activate
def test_get_ltp_batch_byo_credentials_have_their_own_throttle_slot(monkeypatch):
    """A backed-up platform-default throttle must not block a BYO user's
    own call, and vice versa - each throttle_key gets an independent
    rate-limit clock (see DhanProvider._throttle/DhanCredentials's own
    docstring), same "independent throttle domains" property
    test_candle_throttle_is_independent_of_ltp_throttle already proves
    for the LTP-vs-candle split."""
    monkeypatch.setattr(settings, "dhan_client_id", "platform-client")
    monkeypatch.setattr(settings, "dhan_access_token", "platform-token")

    responses.add(responses.GET, INSTRUMENT_MASTER_URL, body=FAKE_CSV, status=200)
    responses.add(responses.POST, LTP_URL, json={"data": {"NSE_EQ": {"2885": {"last_price": 2500.5}}}}, status=200)

    provider = DhanProvider()
    provider.sync_instruments()
    # Simulate the PLATFORM-default queue backed up - a BYO user's own
    # call (different throttle_key) must still succeed immediately.
    provider._last_ltp_call_at[None] = time.monotonic() + 3.0

    creds = DhanCredentials(client_id="user-client", access_token="user-token", throttle_key="user-1")
    price = provider.get_ltp("RELIANCE", credentials=creds)

    assert price == 2500.5
