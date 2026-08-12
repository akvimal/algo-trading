"""Tests for app/providers/delta_feed.py - parse_ticker_message (pure
JSON-message parsing, confirmed live against wss://socket.india.delta.exchange
- see docs/architecture.md), plus subscribe()/_handle_ticker()'s in-memory
bookkeeping and the shared _backoff_delay formula (same as dhan_feed.py's).

Module-level state is shared across the whole test session, so every test
that touches it resets first - same pattern test_dhan_feed.py already
established."""

import json

from app.providers import delta_feed


def _reset(monkeypatch):
    monkeypatch.setattr(delta_feed, "_connected", False)
    monkeypatch.setattr(delta_feed, "_connected_at", None)
    monkeypatch.setattr(delta_feed, "_last_message_at", None)
    monkeypatch.setattr(delta_feed, "_reconnect_count", 0)
    monkeypatch.setattr(delta_feed, "_consecutive_failures", 0)
    monkeypatch.setattr(delta_feed, "_last_error", None)
    monkeypatch.setattr(delta_feed, "_last_ticks", {})
    monkeypatch.setattr(delta_feed, "_subscribed", set())
    monkeypatch.setattr(delta_feed, "_ws_app", None)


# --- parse_ticker_message: pure JSON parsing ------------------------------------------------


def test_parse_ticker_message_extracts_symbol_price_timestamp():
    message = {"type": "v2/ticker", "symbol": "BTCUSD", "close": 63498.5, "timestamp": 1786549275795437, "mark_price": "63500.8"}

    result = delta_feed.parse_ticker_message(message)

    assert result == {"symbol": "BTCUSD", "price": 63498.5, "timestamp": 1786549275795437}


def test_parse_ticker_message_ignores_non_ticker_types():
    message = {"type": "subscriptions", "channels": [{"name": "v2/ticker", "symbols": ["BTCUSD"]}]}

    assert delta_feed.parse_ticker_message(message) is None


def test_parse_ticker_message_missing_fields_returns_none():
    assert delta_feed.parse_ticker_message({"type": "v2/ticker"}) is None


# --- feed_status ---------------------------------------------------------------------------


def test_feed_status_before_any_connection(monkeypatch):
    _reset(monkeypatch)

    status = delta_feed.feed_status()

    assert status == {
        "connected": False,
        "connected_at": None,
        "last_message_at": None,
        "reconnect_count": 0,
        "last_error": None,
        "ticks": {},
    }


# --- _on_open --------------------------------------------------------------------------------


class FakeWs:
    def __init__(self):
        self.sent = []

    def send(self, message):
        self.sent.append(message)


def test_on_open_clears_last_error_from_a_previous_reconnect(monkeypatch):
    _reset(monkeypatch)
    monkeypatch.setattr(delta_feed, "_last_error", "Connection to remote host was lost.")

    delta_feed._on_open(FakeWs())

    status = delta_feed.feed_status()
    assert status["connected"] is True
    assert status["last_error"] is None


def test_on_open_resets_consecutive_failures(monkeypatch):
    _reset(monkeypatch)
    monkeypatch.setattr(delta_feed, "_consecutive_failures", 4)

    delta_feed._on_open(FakeWs())

    assert delta_feed._consecutive_failures == 0


def test_on_open_subscribes_default_watchlist_when_nothing_subscribed_yet(monkeypatch):
    _reset(monkeypatch)
    fake_ws = FakeWs()

    delta_feed._on_open(fake_ws)

    assert len(fake_ws.sent) == 1
    sent = json.loads(fake_ws.sent[0])
    assert sent["type"] == "subscribe"
    assert sent["payload"]["channels"][0]["name"] == delta_feed.TICKER_CHANNEL
    assert sent["payload"]["channels"][0]["symbols"] == ["BTCUSD"]


# --- _backoff_delay: same exponential-backoff formula dhan_feed.py uses --------------------


def test_backoff_delay_doubles_per_consecutive_failure():
    assert delta_feed._backoff_delay(1) == 5
    assert delta_feed._backoff_delay(2) == 10
    assert delta_feed._backoff_delay(3) == 20
    assert delta_feed._backoff_delay(4) == 40


def test_backoff_delay_caps_at_max():
    assert delta_feed._backoff_delay(20) == delta_feed.RECONNECT_DELAY_MAX_SECONDS


def test_backoff_delay_zero_failures_is_base_delay():
    assert delta_feed._backoff_delay(0) == delta_feed.RECONNECT_DELAY_BASE_SECONDS


# --- subscribe -------------------------------------------------------------------------------


class FakeProvider:
    def __init__(self, lot_size):
        self._lot_size = lot_size

    def get_lot_size(self, symbol):
        return self._lot_size


def test_subscribe_returns_false_when_symbol_unresolvable(monkeypatch):
    _reset(monkeypatch)
    monkeypatch.setattr(delta_feed, "get_provider", lambda exchange: FakeProvider(None))

    assert delta_feed.subscribe("CRYPTO", "NOPE") is False


def test_subscribe_records_but_does_not_send_when_not_connected(monkeypatch):
    _reset(monkeypatch)
    monkeypatch.setattr(delta_feed, "get_provider", lambda exchange: FakeProvider(1))

    result = delta_feed.subscribe("CRYPTO", "ETHUSD")

    assert result is True
    assert ("CRYPTO", "ETHUSD") in delta_feed._subscribed


def test_subscribe_sends_message_when_connected(monkeypatch):
    _reset(monkeypatch)
    fake_ws = FakeWs()
    monkeypatch.setattr(delta_feed, "_connected", True)
    monkeypatch.setattr(delta_feed, "_ws_app", fake_ws)
    monkeypatch.setattr(delta_feed, "get_provider", lambda exchange: FakeProvider(1))

    delta_feed.subscribe("CRYPTO", "ETHUSD")

    assert len(fake_ws.sent) == 1
    sent = json.loads(fake_ws.sent[0])
    assert sent["payload"]["channels"] == [{"name": "v2/ticker", "symbols": ["ETHUSD"]}]


# --- _handle_ticker ----------------------------------------------------------------------------


def test_handle_ticker_updates_last_ticks(monkeypatch):
    _reset(monkeypatch)

    delta_feed._handle_ticker("CRYPTO", {"symbol": "BTCUSD", "price": 63498.567, "timestamp": 1786549275795437})

    status = delta_feed.feed_status()
    assert "CRYPTO:BTCUSD" in status["ticks"]
    assert status["ticks"]["CRYPTO:BTCUSD"]["price"] == 63498.57
