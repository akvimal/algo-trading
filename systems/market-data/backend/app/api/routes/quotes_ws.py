"""Client-facing LTP push (2026-09-16, Phase 1 of the SaaS scaling work -
see docs/architecture.md) - fans out app/providers/dhan_feed.py's ticks
(via the Redis cache/pub-sub that module now also writes to, see its
_publish_tick) to any number of browser sessions without each one polling
GET /quotes/ltp. Deliberately a separate route module from quotes.py,
which keeps its own BYO-Dhan-credential REST behavior completely
untouched - this endpoint has no such branch, see quotes_ws's own
docstring below for why.

One shared async Redis connection PSUBSCRIBEs to every md:ltp-updates:*
channel for this process's whole lifetime (started lazily on the first WS
connection, idempotent) rather than one Redis subscription per browser
tab - ticks are dispatched in-process to whichever WebSocket connections
actually asked for that (exchange, symbol) via the _subscribers registry.
"""

import asyncio
import json
import logging
from typing import Optional

import redis.asyncio as aioredis
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import settings
from app.providers import dhan_feed

logger = logging.getLogger(__name__)

router = APIRouter()

# Generous over what one Live Chart tab actually needs (its own underlying
# symbol, maybe one more) - bounds a misbehaving/leaking client without
# getting in the way of legitimate use. Exceeding it returns an error
# frame rather than closing the socket.
MAX_SYMBOLS_PER_CONNECTION = 5

_subscribers: dict[tuple[str, str], set[WebSocket]] = {}
_registry_lock = asyncio.Lock()
_redis: Optional["aioredis.Redis"] = None
_pubsub_task: Optional[asyncio.Task] = None
_pubsub_started_lock = asyncio.Lock()


async def _ensure_pubsub_started() -> None:
    """Idempotent - same "deliberate, safe to call repeatedly" spirit as
    dhan_feed.start_feed(), which this also lazily triggers (see
    quotes_ws() below) now that a WS subscribe is what actually starts
    the upstream Dhan connection in production, not an unconditional
    on-boot start (see that module's own history)."""
    global _redis, _pubsub_task
    async with _pubsub_started_lock:
        if _pubsub_task is not None:
            return
        _redis = aioredis.Redis.from_url(settings.redis_url, decode_responses=True)
        _pubsub_task = asyncio.create_task(_pubsub_loop())


async def _dispatch_tick(payload: dict) -> None:
    """The relay half of a pubsub message, split out from _pubsub_loop
    below purely so it's independently testable without a real/fake
    pubsub listen loop - same "factor out the testable piece" convention
    dhan_feed.py already uses for parse_ticker vs _handle_ticker."""
    key = (payload.get("exchange"), payload.get("symbol"))
    async with _registry_lock:
        sockets = list(_subscribers.get(key, ()))
    for ws in sockets:
        try:
            await ws.send_json({"type": "tick", **payload})
        except Exception:
            pass  # a dead socket is cleaned up by its own disconnect handler, not here


async def _pubsub_loop() -> None:
    """Never returns under normal operation - same "background job must
    not die permanently" philosophy as dhan_feed.py's own reconnect loop,
    though a crash here only loses live pushes (REST polling is always
    the armed fallback client-side, see LiveChartPanel.tsx), never data."""
    assert _redis is not None
    pubsub = _redis.pubsub()
    await pubsub.psubscribe("md:ltp-updates:*")
    try:
        async for message in pubsub.listen():
            if message.get("type") != "pmessage":
                continue
            try:
                payload = json.loads(message["data"])
            except (TypeError, ValueError):
                continue
            await _dispatch_tick(payload)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("quotes_ws: pubsub loop crashed")


async def _snapshot(exchange: str, symbol: str) -> Optional[dict]:
    assert _redis is not None
    raw = await _redis.get(f"md:ltp:{exchange}:{symbol}")
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


async def _unjoin(websocket: WebSocket, key: tuple[str, str]) -> None:
    async with _registry_lock:
        subs = _subscribers.get(key)
        if subs is None:
            return
        subs.discard(websocket)
        if not subs:
            del _subscribers[key]


@router.websocket("/ws/quotes")
async def quotes_ws(websocket: WebSocket) -> None:
    """Subscribe-by-message so one connection can switch symbols (e.g. a
    chart tab changing its underlying) without reconnecting:
    {"action": "subscribe"|"unsubscribe", "exchange": "NSE", "symbol": "NIFTY"}
    -> {"type": "snapshot", ...} once, if a cached value exists, then
    {"type": "tick", ...} on every update; {"type": "error", "detail": ...}
    if MAX_SYMBOLS_PER_CONNECTION is exceeded.

    No auth - deliberate, not an oversight. This is exclusively the
    platform account's shared global feed (see docs/architecture.md's
    Phase 1 note) - there is no per-user BYO-Dhan-credential branch here
    the way GET /quotes/ltp has (app/api/routes/quotes.py, untouched by
    this route), and a browser WebSocket handshake can't attach an
    Authorization header anyway. GET /quotes/ltp itself already tolerates
    a fully anonymous caller, so an anonymous broadcast of the same
    numbers over this socket isn't a new exposure. A `?token=` query
    param + get_optional_user_id-style decode (app/auth.py) can be added
    later, additively, if per-connection identity/rate-limiting is ever
    needed - not required for this phase."""
    await websocket.accept()
    await _ensure_pubsub_started()
    joined: set[tuple[str, str]] = set()
    try:
        while True:
            raw = await websocket.receive_json()
            action = raw.get("action")
            exchange = str(raw.get("exchange") or "").strip().upper()
            symbol = str(raw.get("symbol") or "").strip().upper()
            if not exchange or not symbol:
                continue
            key = (exchange, symbol)

            if action == "unsubscribe":
                joined.discard(key)
                await _unjoin(websocket, key)
                continue

            if action != "subscribe":
                continue
            if key not in joined and len(joined) >= MAX_SYMBOLS_PER_CONNECTION:
                await websocket.send_json({"type": "error", "detail": f"max {MAX_SYMBOLS_PER_CONNECTION} symbols per connection"})
                continue

            joined.add(key)
            async with _registry_lock:
                _subscribers.setdefault(key, set()).add(websocket)

            # Cheap, GIL-bound dict/set bookkeeping plus at most one send on
            # the upstream Dhan socket - not an HTTP call - so safe to call
            # directly from this async handler, same as the existing sync
            # POST /dhan/feed/subscribe route already does.
            dhan_feed.start_feed()
            dhan_feed.subscribe(exchange, symbol)

            snapshot = await _snapshot(exchange, symbol)
            if snapshot is not None:
                await websocket.send_json({"type": "snapshot", **snapshot})
    except WebSocketDisconnect:
        pass
    finally:
        for key in joined:
            await _unjoin(websocket, key)
