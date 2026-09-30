"""Tests for app/api/routes/quotes_ws.py - the client-facing LTP push
endpoint. Same "plain fakes, no TestClient" convention this test suite
already uses elsewhere (see test_candles_route_cache.py's own comment) -
quotes_ws() and _dispatch_tick() are plain async functions, called
directly (via asyncio.run) with a FakeWebSocket double rather than
through a real ASGI/WS handshake - no pytest-asyncio needed.

Module-level state (_subscribers, _redis, _pubsub_task) is shared across
the whole test session, so every test resets it first via monkeypatch -
same pattern test_dhan_feed.py's _reset() already establishes."""

import asyncio
import json

from fastapi import WebSocketDisconnect

from app.api.routes import quotes_ws
from app.providers import dhan_feed


class FakeWebSocket:
    def __init__(self, messages=(), query_params=None):
        self._messages = list(messages)
        self.sent: list[dict] = []
        self.accepted = False
        self.query_params = query_params or {}  # a real WebSocket always has these (the ?token=)

    async def accept(self):
        self.accepted = True

    async def receive_json(self):
        if not self._messages:
            raise WebSocketDisconnect()
        return self._messages.pop(0)

    async def send_json(self, data):
        self.sent.append(data)


class DeadWebSocket:
    """A socket whose send always fails - simulates a client that
    disconnected without the server noticing yet."""

    async def send_json(self, data):
        raise RuntimeError("connection closed")


class FakeAsyncRedis:
    def __init__(self, get_values: dict | None = None):
        self._get_values = get_values or {}

    async def get(self, key):
        return self._get_values.get(key)


async def _noop_ensure_started() -> None:
    pass


def _reset(monkeypatch, redis_values: dict | None = None):
    monkeypatch.setattr(quotes_ws, "_subscribers", {})
    monkeypatch.setattr(quotes_ws, "_redis", FakeAsyncRedis(redis_values))
    monkeypatch.setattr(quotes_ws, "_pubsub_task", None)
    # Route-level tests don't exercise the real pubsub listen loop (that's
    # covered separately by the _dispatch_tick tests below) - avoid
    # spawning a background task that would try to reach a real Redis.
    monkeypatch.setattr(quotes_ws, "_ensure_pubsub_started", _noop_ensure_started)
    monkeypatch.setattr(dhan_feed, "start_feed", lambda: None)
    monkeypatch.setattr(dhan_feed, "subscribe", lambda exchange, symbol: True)


def run(coro):
    return asyncio.run(coro)


# --- quotes_ws(): the WS route handler ------------------------------------------------------


def test_subscribe_sends_snapshot_when_cached(monkeypatch):
    cached = {"exchange": "NSE", "symbol": "NIFTY", "price": 24500.5}
    _reset(monkeypatch, redis_values={"md:ltp:NSE:NIFTY": json.dumps(cached)})
    ws = FakeWebSocket([{"action": "subscribe", "exchange": "NSE", "symbol": "NIFTY"}])

    run(quotes_ws.quotes_ws(ws))

    assert ws.accepted is True
    assert ws.sent == [{"type": "snapshot", **cached}]


def test_subscribe_sends_no_snapshot_when_uncached(monkeypatch):
    _reset(monkeypatch)
    ws = FakeWebSocket([{"action": "subscribe", "exchange": "NSE", "symbol": "NIFTY"}])

    run(quotes_ws.quotes_ws(ws))

    assert ws.sent == []


def test_subscribe_calls_dhan_feed_subscribe_and_start_feed(monkeypatch):
    _reset(monkeypatch)
    subscribed = []
    started = []
    monkeypatch.setattr(dhan_feed, "subscribe", lambda exchange, symbol: subscribed.append((exchange, symbol)) or True)
    monkeypatch.setattr(dhan_feed, "start_feed", lambda: started.append(True))
    ws = FakeWebSocket([{"action": "subscribe", "exchange": "NSE", "symbol": "NIFTY"}])

    run(quotes_ws.quotes_ws(ws))

    assert subscribed == [("NSE", "NIFTY")]
    assert started == [True]


def test_sixth_distinct_symbol_gets_error_frame_not_disconnect(monkeypatch):
    _reset(monkeypatch)
    messages = [{"action": "subscribe", "exchange": "NSE", "symbol": f"SYM{i}"} for i in range(6)]
    ws = FakeWebSocket(messages)

    run(quotes_ws.quotes_ws(ws))

    # The connection disconnects (messages exhausted) right after the error
    # frame, which is enough to exercise the finally-cleanup path too - see
    # test_disconnect_cleans_up_every_symbol_the_connection_joined for that
    # behavior in isolation; this test is only about the cap itself.
    assert ws.sent[-1] == {"type": "error", "detail": "max 5 symbols per connection"}
    assert sum(1 for v in ws.sent if v.get("type") == "error") == 1


def test_subscribe_preserves_a_mixed_case_expiry_symbol(monkeypatch):
    """Reproduced live 2026-09-28: any expiry-dated contract (GOLDM-05Oct2026-FUT,
    NIFTY-24800-16Oct2026-CE, ...) is genuinely mixed-case in Dhan's own symbol format - a plain
    index/equity symbol (NIFTY, RELIANCE) is already all-uppercase, which is exactly why this
    went unnoticed: only instruments with an expiry ever needed the casing preserved. Uppercasing
    here used to register the WRONG dict key - dhan_feed.subscribe/publish always use the
    ORIGINAL casing (never uppercased), so a real tick could never match an uppercased
    registration, silently forcing every future/option onto REST polling's slower fallback
    forever."""
    _reset(monkeypatch)
    subscribed = []
    monkeypatch.setattr(dhan_feed, "subscribe", lambda exchange, symbol: subscribed.append((exchange, symbol)) or True)
    ws = FakeWebSocket([{"action": "subscribe", "exchange": "mcx", "symbol": "GOLDM-05Oct2026-FUT"}])

    run(quotes_ws.quotes_ws(ws))

    # exchange is normalized (dhan_feed's own exchange codes are always plain uppercase); the
    # symbol's case must reach dhan_feed.subscribe untouched, or its resolver (keyed by the
    # instrument master's own casing) silently fails to find a real security id at all.
    assert subscribed == [("MCX", "GOLDM-05Oct2026-FUT")]


def test_dispatch_tick_reaches_a_mixed_case_expiry_symbol(monkeypatch):
    """The other half of the regression above: a real tick (published under Dhan's own casing)
    must actually reach a subscriber registered under that same casing."""
    _reset(monkeypatch)
    ws = FakeWebSocket([])
    quotes_ws._subscribers[("MCX", "GOLDM-05Oct2026-FUT")] = {ws}
    payload = {"exchange": "MCX", "symbol": "GOLDM-05Oct2026-FUT", "price": 146500.0}

    run(quotes_ws._dispatch_tick(payload))

    assert ws.sent == [{"type": "tick", **payload}]


def test_unsubscribe_removes_from_registry_immediately(monkeypatch):
    _reset(monkeypatch)
    ws = FakeWebSocket(
        [
            {"action": "subscribe", "exchange": "NSE", "symbol": "NIFTY"},
            {"action": "unsubscribe", "exchange": "NSE", "symbol": "NIFTY"},
        ]
    )

    run(quotes_ws.quotes_ws(ws))

    assert quotes_ws._subscribers == {}


def test_disconnect_cleans_up_every_symbol_the_connection_joined(monkeypatch):
    _reset(monkeypatch)
    other_ws = FakeWebSocket([])  # a second, still-subscribed connection on the same symbol
    quotes_ws._subscribers[("NSE", "NIFTY")] = {other_ws}
    ws = FakeWebSocket(
        [
            {"action": "subscribe", "exchange": "NSE", "symbol": "NIFTY"},
            {"action": "subscribe", "exchange": "NSE", "symbol": "BANKNIFTY"},
        ]
    )

    run(quotes_ws.quotes_ws(ws))

    # This connection's own membership is gone from both symbols...
    assert ws not in quotes_ws._subscribers.get(("NSE", "NIFTY"), set())
    assert ("NSE", "BANKNIFTY") not in quotes_ws._subscribers  # no one else was subscribed - the whole entry is pruned
    # ...but the OTHER connection sharing NIFTY is untouched.
    assert quotes_ws._subscribers[("NSE", "NIFTY")] == {other_ws}


# --- _dispatch_tick(): the pubsub -> WebSocket relay -------------------------------------------


def test_dispatch_tick_relays_to_every_subscribed_socket(monkeypatch):
    _reset(monkeypatch)
    ws = FakeWebSocket([])
    quotes_ws._subscribers[("NSE", "NIFTY")] = {ws}
    payload = {"exchange": "NSE", "symbol": "NIFTY", "price": 24500.5}

    run(quotes_ws._dispatch_tick(payload))

    assert ws.sent == [{"type": "tick", **payload}]


def test_dispatch_tick_is_a_noop_for_a_symbol_nobody_subscribed_to(monkeypatch):
    _reset(monkeypatch)

    run(quotes_ws._dispatch_tick({"exchange": "NSE", "symbol": "BANKNIFTY", "price": 51000.0}))  # must not raise


def test_dispatch_tick_swallows_a_dead_sockets_send_error(monkeypatch):
    _reset(monkeypatch)
    quotes_ws._subscribers[("NSE", "NIFTY")] = {DeadWebSocket()}

    run(quotes_ws._dispatch_tick({"exchange": "NSE", "symbol": "NIFTY", "price": 1.0}))  # must not raise
