"""Execution's calls into market-data must present INTERNAL_SERVICE_SECRET, so that
with market-data's REQUIRE_OWN_DHAN_KEYS on it recognises them as a trusted service
(app/adapters/quotes/client.py, _auth_headers). Without this, flipping that flag would
lock out the exit monitor, square-off, the equity job and the pending-order watcher."""

from datetime import date
from types import SimpleNamespace

import pytest

from app.adapters.quotes import client as qc
from app.config import settings

SECRET = "a-real-shared-secret-value"


class Resp:
    status_code = 200

    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


@pytest.fixture
def captured(monkeypatch):
    monkeypatch.setattr(settings, "internal_service_secret", SECRET)
    seen = []

    def fake(url, **kw):
        seen.append(kw.get("headers"))
        if "ltp/batch" in url:
            return Resp({"prices": {"TCS": 1.0}})
        if "expiries" in url:
            return Resp({"expiries": []})
        if url.endswith("/quotes/ltp"):
            return Resp({"ltp": 1.0})
        return Resp([] if "history" in url else {})

    monkeypatch.setattr(qc.requests, "get", fake)
    monkeypatch.setattr(qc.requests, "post", fake)
    return seen


DATA_CALLS = {
    "ltp": lambda: qc.get_ltp("NSE", "TCS"),
    "ltp_batch": lambda: qc.get_ltp_batch("NSE", ["TCS"]),
    "previous_candle": lambda: qc.get_previous_candle("NSE", "TCS", "15min"),
    "candle_history": lambda: qc.get_candle_history("NSE", "TCS", "15min", date(2026, 1, 1), date(2026, 1, 2)),
    "expiries": lambda: qc.get_expiry_list("NSE", "NIFTY"),
    "option_chain": lambda: qc.get_option_chain("NSE", "NIFTY", "2026-09-29"),
}


@pytest.mark.parametrize("name", sorted(DATA_CALLS))
def test_every_data_call_presents_the_internal_secret(captured, name):
    DATA_CALLS[name]()
    assert captured == [{"X-Internal-Secret": SECRET}]  # a service call with no user: no Authorization header


@pytest.mark.parametrize("name", ["ltp_batch", "previous_candle", "candle_history", "expiries", "option_chain"])
def test_a_forwarded_user_token_travels_alongside_the_secret(captured, name):
    fn = {
        "ltp_batch": lambda: qc.get_ltp_batch("NSE", ["TCS"], token="user-jwt"),
        "previous_candle": lambda: qc.get_previous_candle("NSE", "TCS", "15min", token="user-jwt"),
        "candle_history": lambda: qc.get_candle_history("NSE", "TCS", "15min", date(2026, 1, 1), date(2026, 1, 2), token="user-jwt"),
        "expiries": lambda: qc.get_expiry_list("NSE", "NIFTY", token="user-jwt"),
        "option_chain": lambda: qc.get_option_chain("NSE", "NIFTY", "2026-09-29", token="user-jwt"),
    }[name]
    fn()
    assert captured == [{"X-Internal-Secret": SECRET, "Authorization": "Bearer user-jwt"}]  # market-data lets the user's own keys win


def test_an_unset_secret_sends_no_blank_header(monkeypatch):
    monkeypatch.setattr(settings, "internal_service_secret", "")
    assert qc._auth_headers(None) == {} and qc._auth_headers("t") == {"Authorization": "Bearer t"}
