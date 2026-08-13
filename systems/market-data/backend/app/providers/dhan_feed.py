"""Dhan's live market feed - a real binary WebSocket connection
(https://docs.dhanhq.co/api/v2/guides/live-market-feed), confirmed against
the official dhan-oss/DhanHQ-py client source (marketfeed.py) for the exact
wire details the docs page alone doesn't fully spell out (request codes,
struct formats, numeric exchange-segment codes). Ticker mode only (LTP +
last-trade-time) - enough to prove the feed is genuinely live; Quote/OI/
Full/Depth packets exist on the wire but aren't parsed here (see
docs/architecture.md).

One connection for the whole process, not one per DhanProvider instance -
same "genuinely global, not per-provider" reasoning as app/providers/
dhan.py's token-renewal state, since every Dhan segment shares one
account's connection/instrument budget (5 connections/user, 5000
instruments/connection)."""

import json
import logging
import struct
import threading
import time
from datetime import datetime, timezone
from typing import Optional

import websocket

from app.config import settings
from app.providers.dhan import current_access_token
from app.providers.router import get_provider

logger = logging.getLogger(__name__)

FEED_URL = "wss://api-feed.dhan.co"
REQUEST_CODE_TICKER_SUBSCRIBE = 15
# Exponential backoff, not a fixed delay - a broken/expired token (or any
# other persistent failure) would otherwise retry the handshake every
# RECONNECT_DELAY_BASE_SECONDS forever, and Dhan rate-limits/blocks a
# client ID that does this too much (observed live: "Too many requests
# from this IP hence client id is blocked" after repeated rapid
# handshake failures - this is account-wide, not per-token, so it also
# affects a *different* stack sharing the same DHAN_CLIENT_ID). Resets
# back to the base delay once a connection actually opens (_on_open).
RECONNECT_DELAY_BASE_SECONDS = 5
RECONNECT_DELAY_MAX_SECONDS = 300

# Default sentinel watchlist - just enough to prove the feed is alive
# without needing a real use case yet. Extend via POST /dhan/feed/subscribe.
DEFAULT_WATCHLIST: list[tuple[str, str]] = [("NSE", "NIFTY")]

# Numeric ExchangeSegment codes used in the BINARY response header, reverse-
# mapped to the same string segment keys DhanProvider.resolve_feed_target
# already returns (its ltp_segment_key vocabulary - "NSE_EQ", "IDX_I", ...)
# so an incoming tick can be correlated back to (exchange, symbol). Source:
# dhan-oss/DhanHQ-py's get_exchange_segment, reversed.
NUMERIC_SEGMENT_TO_KEY = {
    0: "IDX_I",
    1: "NSE_EQ",
    2: "NSE_FNO",
    3: "NSE_CURRENCY",
    4: "BSE_EQ",
    5: "MCX_COMM",
    7: "BSE_CURRENCY",
    8: "BSE_FNO",
}

_DISCONNECT_REASONS = {
    805: "too many active WebSocket connections",
    806: "not subscribed to Data APIs",
    807: "access token expired",
    808: "invalid client ID",
    809: "authentication failed",
}


def parse_ticker(data: bytes) -> dict:
    """Ticker packet (feed response code 2) - LTP + last-trade-time. Pure,
    directly unit-testable - see tests/test_dhan_feed.py."""
    _code, _length, segment, security_id, ltp, ltt = struct.unpack("<BHBIfI", data[0:16])
    return {"type": "ticker", "segment": segment, "security_id": security_id, "ltp": ltp, "ltt": ltt}


def parse_prev_close(data: bytes) -> dict:
    """Previous-close packet (feed response code 6) - same byte shape as
    Ticker, different meaning for the float/int fields. Parsed for
    completeness/future use - not currently surfaced in feed_status()."""
    _code, _length, segment, security_id, prev_close, prev_oi = struct.unpack("<BHBIfI", data[0:16])
    return {"type": "prev_close", "segment": segment, "security_id": security_id, "prev_close": prev_close, "prev_oi": prev_oi}


def parse_disconnect(data: bytes) -> dict:
    """Server disconnect packet (feed response code 50)."""
    _code, _length, _segment, _security_id, reason_code = struct.unpack("<BHBIH", data[0:10])
    return {"type": "disconnect", "reason_code": reason_code, "reason": _DISCONNECT_REASONS.get(reason_code, f"unknown ({reason_code})")}


_lock = threading.Lock()
_feed_thread_started = False
_connected = False
_connected_at: Optional[datetime] = None
_last_message_at: Optional[datetime] = None
_reconnect_count = 0
_consecutive_failures = 0  # drives exponential backoff - reset in _on_open
_last_error: Optional[str] = None
_last_ticks: dict[tuple[str, str], dict] = {}  # (exchange, symbol) -> {price, ltt, received_at}
_subscribed: set[tuple[str, str]] = set()  # (exchange, symbol) ever subscribed - re-sent on reconnect
_symbol_by_segment_security: dict[tuple[str, str], tuple[str, str]] = {}  # (segment_key, security_id) -> (exchange, symbol)
_ws_app: Optional["websocket.WebSocketApp"] = None


def _backoff_delay(consecutive_failures: int) -> int:
    """Seconds to wait before the next reconnect attempt - doubles per
    consecutive failure since the last successful connection, capped at
    RECONNECT_DELAY_MAX_SECONDS. Pure, directly unit-testable."""
    return min(RECONNECT_DELAY_BASE_SECONDS * (2 ** max(consecutive_failures - 1, 0)), RECONNECT_DELAY_MAX_SECONDS)


def feed_status() -> dict:
    with _lock:
        return {
            "connected": _connected,
            "connected_at": _connected_at.isoformat() if _connected_at else None,
            "last_message_at": _last_message_at.isoformat() if _last_message_at else None,
            "reconnect_count": _reconnect_count,
            "last_error": _last_error,
            "ticks": {f"{exchange}:{symbol}": tick for (exchange, symbol), tick in _last_ticks.items()},
        }


def _resolve_target(exchange: str, symbol: str) -> Optional[tuple[str, str]]:
    """(segment_key, security_id) via the provider's own Dhan-specific
    resolver - duck-typed (getattr, not isinstance) so a future non-Dhan
    provider (Delta Exchange) simply isn't subscribable here rather than
    breaking anything, without this module needing to know about it."""
    provider = get_provider(exchange)  # raises ValueError for an unknown exchange - callers decide how to surface that
    resolver = getattr(provider, "resolve_feed_target", None)
    if resolver is None:
        return None
    return resolver(symbol)


def _send_subscribe_message(ws: "websocket.WebSocketApp", segment_key: str, security_id: str) -> None:
    message = {
        "RequestCode": REQUEST_CODE_TICKER_SUBSCRIBE,
        "InstrumentCount": 1,
        "InstrumentList": [{"ExchangeSegment": segment_key, "SecurityId": security_id}],
    }
    ws.send(json.dumps(message))


def subscribe(exchange: str, symbol: str) -> bool:
    """Subscribes one more symbol - records it (re-sent automatically on
    every future reconnect) and sends the subscribe message immediately if
    already connected. False if `symbol` doesn't resolve on `exchange`'s
    provider (unknown symbol, or a provider with no live-feed support)."""
    target = _resolve_target(exchange, symbol)
    if target is None:
        return False
    segment_key, security_id = target
    with _lock:
        _symbol_by_segment_security[(segment_key, security_id)] = (exchange, symbol)
        _subscribed.add((exchange, symbol))
        ws_app, connected = _ws_app, _connected
    if connected and ws_app is not None:
        _send_subscribe_message(ws_app, segment_key, security_id)
    return True


def _handle_ticker(parsed: dict) -> None:
    key = (NUMERIC_SEGMENT_TO_KEY.get(parsed["segment"]), str(parsed["security_id"]))
    with _lock:
        target = _symbol_by_segment_security.get(key)
        if target is None:
            return  # a tick for something we don't recognize - ignore rather than guess
        _last_ticks[target] = {
            "price": round(parsed["ltp"], 2),
            "ltt": datetime.fromtimestamp(parsed["ltt"], tz=timezone.utc).isoformat(),
            "received_at": datetime.now(timezone.utc).isoformat(),
        }


def _on_open(ws: "websocket.WebSocketApp") -> None:
    global _connected, _connected_at, _last_error, _consecutive_failures
    with _lock:
        _connected = True
        _connected_at = datetime.now(timezone.utc)
        _last_error = None  # clear whatever caused the previous reconnect - it's healthy now
        _consecutive_failures = 0  # a real connection opened - back off from scratch next time
        watchlist = set(_subscribed) or set(DEFAULT_WATCHLIST)
    logger.info("Dhan live feed connected")
    for exchange, symbol in watchlist:
        try:
            subscribe(exchange, symbol)
        except Exception:
            logger.exception("Dhan live feed: failed to (re)subscribe %s:%s", exchange, symbol)


def _on_message(_ws: "websocket.WebSocketApp", message) -> None:
    global _last_message_at
    if not isinstance(message, (bytes, bytearray)) or len(message) < 1:
        return
    with _lock:
        _last_message_at = datetime.now(timezone.utc)
    code = message[0]
    try:
        if code == 2:
            _handle_ticker(parse_ticker(message))
        elif code == 50:
            info = parse_disconnect(message)
            logger.warning("Dhan live feed: server sent disconnect (%s)", info["reason"])
        # Quote(4)/OI(5)/PrevClose(6)/Status(7)/Full(8)/Depth(3) are on the
        # wire but intentionally unparsed here - see docs/architecture.md.
    except struct.error:
        logger.exception("Dhan live feed: malformed packet (code=%s, %d bytes)", code, len(message))


def _on_close(_ws: "websocket.WebSocketApp", close_status_code, close_msg) -> None:
    global _connected
    with _lock:
        _connected = False
    logger.warning("Dhan live feed closed (code=%s, msg=%s)", close_status_code, close_msg)


def _on_error(_ws: "websocket.WebSocketApp", error) -> None:
    global _last_error
    with _lock:
        _last_error = str(error)
    logger.warning("Dhan live feed error: %s", error)


def _run_forever_loop() -> None:
    """Never returns - reconnects after every close/error, same 'never let
    the background job die permanently' philosophy as app/scheduler.py's
    jobs. Rebuilds the connection URL fresh each attempt so a renewed
    access token (app/providers/dhan.py's current_access_token) is always
    what's actually used, not whatever was current at process start."""
    global _reconnect_count, _consecutive_failures, _ws_app
    while True:
        token = current_access_token()
        url = f"{FEED_URL}?version=2&token={token}&clientId={settings.dhan_client_id}&authType=2"
        app = websocket.WebSocketApp(url, on_open=_on_open, on_message=_on_message, on_close=_on_close, on_error=_on_error)
        _ws_app = app
        try:
            app.run_forever()
        except Exception:
            logger.exception("Dhan live feed connection loop crashed")
        with _lock:
            _connected = False
            _reconnect_count += 1
            _consecutive_failures += 1
            delay = _backoff_delay(_consecutive_failures)
        logger.info("Dhan live feed: reconnecting in %ds (consecutive failures: %d)", delay, _consecutive_failures)
        time.sleep(delay)


def start_feed() -> None:
    """Starts the background thread maintaining the live feed connection -
    no-op if Dhan credentials aren't configured. No longer called
    unconditionally from app.main's startup handler (its reconnect-on-
    every-restart behavior was hammering Dhan's own account-wide rate
    limit, which also blocks the plain REST quote API - reproduced live)
    - now a deliberate opt-in via POST /dhan/feed/subscribe instead.
    Idempotent - a second call while the thread's already running is a
    no-op rather than spawning a duplicate connection (which would make
    the exact rate-limit problem this change addresses worse, not
    better)."""
    global _feed_thread_started
    if not settings.dhan_client_id or not settings.dhan_access_token:
        logger.info("Dhan live feed not started - DHAN_CLIENT_ID/DHAN_ACCESS_TOKEN not configured")
        return
    with _lock:
        if _feed_thread_started:
            return
        _feed_thread_started = True
    threading.Thread(target=_run_forever_loop, daemon=True, name="dhan-live-feed").start()
