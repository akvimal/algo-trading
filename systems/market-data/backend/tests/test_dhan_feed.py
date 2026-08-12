"""Tests for app/providers/dhan_feed.py - the pure binary-packet parsers
(parse_ticker/parse_prev_close/parse_disconnect) against hand-built
struct.pack'ed fixtures matching Dhan's documented wire format
(https://docs.dhanhq.co/api/v2/guides/live-market-feed, cross-checked
against dhan-oss/DhanHQ-py's marketfeed.py), plus subscribe()/
_handle_ticker()'s in-memory bookkeeping.

Module-level state (_connected, _subscribed, _last_ticks,
_symbol_by_segment_security, _ws_app) is shared across the whole test
session, so every test that touches it resets first via monkeypatch -
same pattern test_dhan_auth.py already established for dhan.py's
_renewed_token."""

import struct

import pytest

from app.providers import dhan_feed


def _reset(monkeypatch):
    monkeypatch.setattr(dhan_feed, "_connected", False)
    monkeypatch.setattr(dhan_feed, "_connected_at", None)
    monkeypatch.setattr(dhan_feed, "_last_message_at", None)
    monkeypatch.setattr(dhan_feed, "_reconnect_count", 0)
    monkeypatch.setattr(dhan_feed, "_consecutive_failures", 0)
    monkeypatch.setattr(dhan_feed, "_last_error", None)
    monkeypatch.setattr(dhan_feed, "_last_ticks", {})
    monkeypatch.setattr(dhan_feed, "_subscribed", set())
    monkeypatch.setattr(dhan_feed, "_symbol_by_segment_security", {})
    monkeypatch.setattr(dhan_feed, "_ws_app", None)


# --- parse_ticker / parse_prev_close / parse_disconnect: pure byte decoding -------------------


def test_parse_ticker_decodes_known_bytes():
    # code=2, length=16, segment=1 (NSE), security_id=2885, ltp=2500.5, ltt=1700000000
    data = struct.pack("<BHBIfI", 2, 16, 1, 2885, 2500.5, 1700000000)

    result = dhan_feed.parse_ticker(data)

    assert result == {"type": "ticker", "segment": 1, "security_id": 2885, "ltp": pytest.approx(2500.5), "ltt": 1700000000}


def test_parse_prev_close_decodes_known_bytes():
    data = struct.pack("<BHBIfI", 6, 16, 5, 100, 152.25, 12345)

    result = dhan_feed.parse_prev_close(data)

    assert result == {"type": "prev_close", "segment": 5, "security_id": 100, "prev_close": pytest.approx(152.25), "prev_oi": 12345}


def test_parse_disconnect_decodes_known_reason():
    data = struct.pack("<BHBIH", 50, 10, 0, 0, 807)

    result = dhan_feed.parse_disconnect(data)

    assert result == {"type": "disconnect", "reason_code": 807, "reason": "access token expired"}


def test_parse_disconnect_unknown_reason_code():
    data = struct.pack("<BHBIH", 50, 10, 0, 0, 999)

    result = dhan_feed.parse_disconnect(data)

    assert result["reason"] == "unknown (999)"


def test_parse_ticker_raises_on_short_buffer():
    with pytest.raises(struct.error):
        dhan_feed.parse_ticker(b"\x02\x00")


# --- feed_status ---------------------------------------------------------------------------


def test_feed_status_before_any_connection(monkeypatch):
    _reset(monkeypatch)

    status = dhan_feed.feed_status()

    assert status == {
        "connected": False,
        "connected_at": None,
        "last_message_at": None,
        "reconnect_count": 0,
        "last_error": None,
        "ticks": {},
    }


# --- _on_open ------------------------------------------------------------------------------


def test_on_open_clears_last_error_from_a_previous_reconnect(monkeypatch):
    _reset(monkeypatch)
    monkeypatch.setattr(dhan_feed, "_last_error", "Connection to remote host was lost.")
    monkeypatch.setattr(dhan_feed, "get_provider", lambda exchange: FakeProvider(None))  # default watchlist won't resolve - fine, not under test here

    dhan_feed._on_open(FakeWs())

    status = dhan_feed.feed_status()
    assert status["connected"] is True
    assert status["last_error"] is None


def test_on_open_resets_consecutive_failures(monkeypatch):
    _reset(monkeypatch)
    monkeypatch.setattr(dhan_feed, "_consecutive_failures", 4)
    monkeypatch.setattr(dhan_feed, "get_provider", lambda exchange: FakeProvider(None))

    dhan_feed._on_open(FakeWs())

    assert dhan_feed._consecutive_failures == 0


# --- _backoff_delay: exponential backoff between reconnect attempts ------------------------
# Guards against hammering Dhan's WS handshake on a persistent failure - observed live to get
# a client ID rate-limited/blocked ("Too many requests from this IP hence client id is
# blocked") after repeated rapid retries, which is account-wide (keyed by DHAN_CLIENT_ID, not
# the token), so it can affect a completely different stack sharing the same client ID too.


def test_backoff_delay_doubles_per_consecutive_failure():
    assert dhan_feed._backoff_delay(1) == 5
    assert dhan_feed._backoff_delay(2) == 10
    assert dhan_feed._backoff_delay(3) == 20
    assert dhan_feed._backoff_delay(4) == 40


def test_backoff_delay_caps_at_max():
    assert dhan_feed._backoff_delay(20) == dhan_feed.RECONNECT_DELAY_MAX_SECONDS


def test_backoff_delay_zero_failures_is_base_delay():
    assert dhan_feed._backoff_delay(0) == dhan_feed.RECONNECT_DELAY_BASE_SECONDS


# --- subscribe / _resolve_target -----------------------------------------------------------


class FakeProvider:
    def __init__(self, target):
        self._target = target

    def resolve_feed_target(self, symbol):
        return self._target


class FakeWs:
    def __init__(self):
        self.sent = []

    def send(self, message):
        self.sent.append(message)


def test_subscribe_returns_false_when_symbol_unresolvable(monkeypatch):
    _reset(monkeypatch)
    monkeypatch.setattr(dhan_feed, "get_provider", lambda exchange: FakeProvider(None))

    assert dhan_feed.subscribe("NSE", "NOPE") is False


def test_subscribe_records_but_does_not_send_when_not_connected(monkeypatch):
    _reset(monkeypatch)
    monkeypatch.setattr(dhan_feed, "get_provider", lambda exchange: FakeProvider(("NSE_EQ", "2885")))

    result = dhan_feed.subscribe("NSE", "RELIANCE")

    assert result is True
    assert ("NSE", "RELIANCE") in dhan_feed._subscribed
    assert dhan_feed._symbol_by_segment_security[("NSE_EQ", "2885")] == ("NSE", "RELIANCE")


def test_subscribe_sends_message_when_connected(monkeypatch):
    _reset(monkeypatch)
    fake_ws = FakeWs()
    monkeypatch.setattr(dhan_feed, "_connected", True)
    monkeypatch.setattr(dhan_feed, "_ws_app", fake_ws)
    monkeypatch.setattr(dhan_feed, "get_provider", lambda exchange: FakeProvider(("IDX_I", "13")))

    dhan_feed.subscribe("NSE", "NIFTY")

    assert len(fake_ws.sent) == 1
    import json

    sent = json.loads(fake_ws.sent[0])
    assert sent["RequestCode"] == dhan_feed.REQUEST_CODE_TICKER_SUBSCRIBE
    assert sent["InstrumentList"] == [{"ExchangeSegment": "IDX_I", "SecurityId": "13"}]


# --- _handle_ticker: correlating an incoming tick back to (exchange, symbol) -------------------


def test_handle_ticker_updates_last_ticks_for_known_symbol(monkeypatch):
    _reset(monkeypatch)
    monkeypatch.setattr(dhan_feed, "_symbol_by_segment_security", {("IDX_I", "13"): ("NSE", "NIFTY")})

    dhan_feed._handle_ticker({"segment": 0, "security_id": 13, "ltp": 24500.123, "ltt": 1700000000})

    status = dhan_feed.feed_status()
    assert "NSE:NIFTY" in status["ticks"]
    assert status["ticks"]["NSE:NIFTY"]["price"] == 24500.12


def test_handle_ticker_ignores_unknown_segment_security(monkeypatch):
    _reset(monkeypatch)
    monkeypatch.setattr(dhan_feed, "_symbol_by_segment_security", {})

    dhan_feed._handle_ticker({"segment": 0, "security_id": 999, "ltp": 100.0, "ltt": 1700000000})

    assert dhan_feed.feed_status()["ticks"] == {}
