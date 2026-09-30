"""signal-engine's data calls into market-data must present INTERNAL_SERVICE_SECRET so
market-data (REQUIRE_OWN_DHAN_KEYS on) recognises the in-house engine, the Weekly
Advisor and the backtests as a trusted service instead of refusing them with a 401
(app/adapters/market_data/client.py, _service_headers). They carry no user, so they run
on the platform credential - the documented residual for automated jobs."""

from datetime import date

import pytest

from app.adapters.market_data import client as md
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
        if url.endswith("/quotes/ltp"):
            return Resp({"ltp": 1.0})
        if "expiries" in url:
            return Resp({"expiries": []})
        if "order-blocks" in url:
            return Resp({"order_blocks": []})
        return Resp([])

    monkeypatch.setattr(md.requests, "get", fake)
    return seen


CALLS = {
    "ltp": lambda: md.get_ltp("NSE", "TCS"),
    "candle_history": lambda: md.get_candle_history("NSE", "TCS", "15min", date(2026, 1, 1), date(2026, 1, 2)),
    "option_leg_history": lambda: md.get_option_leg_history("NSE", "NIFTY", "CALL", "ATM", "WEEK", 1, "15min", date(2026, 1, 1), date(2026, 1, 2)),
    "expiries": lambda: md.get_expiry_list("NSE", "NIFTY"),
    "order_blocks": lambda: md.get_order_blocks("NSE", "TCS", "15min", date(2026, 1, 1), date(2026, 1, 2)),
    "option_chain": lambda: md.get_option_chain("NSE", "NIFTY", "2026-09-29"),
}


@pytest.mark.parametrize("name", sorted(CALLS))
def test_every_data_call_presents_the_internal_secret(captured, name):
    CALLS[name]()
    assert captured == [{"X-Internal-Secret": SECRET}]


def test_an_unset_secret_sends_no_blank_header(monkeypatch):
    monkeypatch.setattr(settings, "internal_service_secret", "")
    assert md._service_headers() == {}
