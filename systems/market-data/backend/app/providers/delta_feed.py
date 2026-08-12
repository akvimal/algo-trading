"""Delta Exchange India's live market feed - a WebSocket connection
carrying plain JSON text frames (confirmed live against
wss://socket.india.delta.exchange - see docs/architecture.md for the
verification note), meaningfully simpler than Dhan's binary protocol
(app/providers/dhan_feed.py) since there's no struct-unpacking and no
token/security-id resolution needed - the public "v2/ticker" channel
subscribes directly by symbol string, no api-key required (see
app/providers/delta.py's own docstring for why this whole module needs
no credentials).

One connection for the whole process, same "genuinely global, not
per-provider-instance" reasoning app/providers/dhan_feed.py already uses
- there's only one DeltaProvider instance anyway (router.py's "CRYPTO"
entry), but the module-level shape is kept consistent with dhan_feed.py
regardless, since a future second crypto provider (Phase 4.5's original
placeholder) would want the same pattern."""

import json
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Optional

import websocket

from app.config import settings
from app.providers.router import get_provider

logger = logging.getLogger(__name__)

TICKER_CHANNEL = "v2/ticker"

# Same exponential-backoff reasoning as dhan_feed.py - a persistent
# failure shouldn't retry the handshake every RECONNECT_DELAY_BASE_SECONDS
# forever. Resets to the base delay once a connection actually opens.
RECONNECT_DELAY_BASE_SECONDS = 5
RECONNECT_DELAY_MAX_SECONDS = 300

# Default sentinel watchlist - just enough to prove the feed is alive
# without needing a real use case yet. Extend via POST /delta/feed/subscribe.
DEFAULT_WATCHLIST: list[tuple[str, str]] = [("CRYPTO", "BTCUSD")]

_lock = threading.Lock()
_connected = False
_connected_at: Optional[datetime] = None
_last_message_at: Optional[datetime] = None
_reconnect_count = 0
_consecutive_failures = 0  # drives exponential backoff - reset in _on_open
_last_error: Optional[str] = None
_last_ticks: dict[tuple[str, str], dict] = {}  # (exchange, symbol) -> {price, received_at}
_subscribed: set[tuple[str, str]] = set()  # (exchange, symbol) ever subscribed - re-sent on reconnect
_ws_app: Optional["websocket.WebSocketApp"] = None


def _backoff_delay(consecutive_failures: int) -> int:
    """Pure, directly unit-testable - identical formula to
    dhan_feed.py's own _backoff_delay."""
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


def parse_ticker_message(message: dict) -> Optional[dict]:
    """A "v2/ticker" push message -> {symbol, price, timestamp} - None
    for anything else (the subscription ack, or an unrelated channel).
    Pure, directly unit-testable - see tests/test_delta_feed.py."""
    if message.get("type") != TICKER_CHANNEL:
        return None
    symbol = message.get("symbol")
    price = message.get("close")
    if symbol is None or price is None:
        return None
    return {"symbol": symbol, "price": float(price), "timestamp": message.get("timestamp")}


def _send_subscribe_message(ws: "websocket.WebSocketApp", symbols: list[str]) -> None:
    ws.send(json.dumps({"type": "subscribe", "payload": {"channels": [{"name": TICKER_CHANNEL, "symbols": symbols}]}}))


def subscribe(exchange: str, symbol: str) -> bool:
    """Subscribes one more symbol - records it (re-sent automatically on
    every future reconnect) and sends the subscribe message immediately
    if already connected. False if `symbol` isn't a known live product on
    `exchange`'s provider (raises ValueError via get_provider for an
    unknown exchange, same as dhan_feed.subscribe). get_lot_size is part
    of every QuoteProvider (not a Delta-specific extension), so no
    duck-typed getattr guard is needed here the way dhan_feed.py's own
    resolve_feed_target check needs one."""
    provider = get_provider(exchange)
    if provider.get_lot_size(symbol) is None:
        return False
    with _lock:
        _subscribed.add((exchange, symbol))
        ws_app, connected = _ws_app, _connected
    if connected and ws_app is not None:
        _send_subscribe_message(ws_app, [symbol])
    return True


def _handle_ticker(exchange: str, tick: dict) -> None:
    with _lock:
        _last_ticks[(exchange, tick["symbol"])] = {
            "price": round(tick["price"], 2),
            "received_at": datetime.now(timezone.utc).isoformat(),
        }


def _on_open(ws: "websocket.WebSocketApp") -> None:
    global _connected, _connected_at, _last_error, _consecutive_failures
    with _lock:
        _connected = True
        _connected_at = datetime.now(timezone.utc)
        _last_error = None
        _consecutive_failures = 0
        watchlist = set(_subscribed) or set(DEFAULT_WATCHLIST)
    logger.info("Delta live feed connected")
    symbols_by_exchange: dict[str, list[str]] = {}
    for exchange, symbol in watchlist:
        symbols_by_exchange.setdefault(exchange, []).append(symbol)
    for exchange, symbols in symbols_by_exchange.items():
        try:
            _send_subscribe_message(ws, symbols)
            with _lock:
                _subscribed.update((exchange, s) for s in symbols)
        except Exception:
            logger.exception("Delta live feed: failed to (re)subscribe %s", symbols)


def _on_message(_ws: "websocket.WebSocketApp", message) -> None:
    global _last_message_at
    with _lock:
        _last_message_at = datetime.now(timezone.utc)
    try:
        parsed = json.loads(message)
    except (TypeError, ValueError):
        logger.warning("Delta live feed: malformed message (not JSON)")
        return
    tick = parse_ticker_message(parsed)
    if tick is not None:
        _handle_ticker("CRYPTO", tick)


def _on_close(_ws: "websocket.WebSocketApp", close_status_code, close_msg) -> None:
    global _connected
    with _lock:
        _connected = False
    logger.warning("Delta live feed closed (code=%s, msg=%s)", close_status_code, close_msg)


def _on_error(_ws: "websocket.WebSocketApp", error) -> None:
    global _last_error
    with _lock:
        _last_error = str(error)
    logger.warning("Delta live feed error: %s", error)


def _run_forever_loop() -> None:
    """Never returns - reconnects after every close/error, same 'never let
    the background job die permanently' philosophy as dhan_feed.py's own
    loop and app/scheduler.py's jobs."""
    global _reconnect_count, _consecutive_failures, _ws_app
    while True:
        app = websocket.WebSocketApp(
            settings.delta_ws_url, on_open=_on_open, on_message=_on_message, on_close=_on_close, on_error=_on_error
        )
        _ws_app = app
        try:
            app.run_forever()
        except Exception:
            logger.exception("Delta live feed connection loop crashed")
        with _lock:
            _connected = False
            _reconnect_count += 1
            _consecutive_failures += 1
            delay = _backoff_delay(_consecutive_failures)
        logger.info("Delta live feed: reconnecting in %ds (consecutive failures: %d)", delay, _consecutive_failures)
        time.sleep(delay)


def start_feed() -> None:
    """Starts the background thread maintaining the live feed connection.
    Unlike dhan_feed.start_feed, there's no credential gate - every
    endpoint this feed uses is public. Call once from app.main's startup
    handler, alongside dhan_feed.start_feed()/app.scheduler.start_scheduler()."""
    threading.Thread(target=_run_forever_loop, daemon=True, name="delta-live-feed").start()
