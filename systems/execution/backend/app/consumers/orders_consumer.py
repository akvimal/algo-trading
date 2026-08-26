"""Redis consumer group reader for orders.resolved - at-least-once
delivery via XREADGROUP/XACK, so a crash mid-processing redelivers the
message instead of silently dropping a signal. open_position() is itself
idempotent on signal_id, so redelivery is safe.

XREADGROUP's own ">" id only ever returns messages never before delivered
to this group - it does NOT redeliver a message that was already handed
to a consumer and then failed (that message just sits in the group's
pending entries list, PEL). The run() loop below's except branch used to
just log "leaving unacked for retry" without anything that actually
retried it - confirmed live 2026-08-18: a transient market-data 502 during
open_option_group left a signal stuck in the PEL for hours with zero
automatic recovery, discovered only because a second, unrelated signal had
been stuck the same way for ~4h already. _reclaim_stale_pending below
closes that gap with XAUTOCLAIM, run once per loop iteration."""

import logging
import threading
import time as time_module

import redis
from redis.exceptions import ResponseError

from app.adapters.db.session import SessionLocal
from app.adapters.quotes.client import (
    get_candle_history,
    get_lot_size,
    get_ltp_batch,
    get_previous_candle,
    resolve_symbol_by_security_id,
    resolve_underlying,
)
from app.config import settings
from app.domain.models import ResolvedOrder
from app.domain.option_position_manager import open_option_group
from app.domain.position_manager import load_settings, open_position

logger = logging.getLogger(__name__)

_client = redis.Redis.from_url(settings.redis_url, decode_responses=True)


def _ensure_group() -> None:
    try:
        _client.xgroup_create(settings.redis_stream, settings.redis_consumer_group, id="0", mkstream=True)
    except ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise


def _process_message(message_id: str, fields: dict) -> None:
    order = ResolvedOrder.model_validate_json(fields["payload"])
    with SessionLocal() as db:
        exec_settings = load_settings(db)
        if order.instrument_type == "option":
            # Multi-leg (Phase 4d of the options trading module - see
            # docs/architecture.md) - completely separate open path from
            # spot/future below, so position_manager.is_supported/
            # open_position never need to know about options at all.
            open_option_group(
                order, exec_settings, db, get_ltp_batch, resolve_symbol_by_security_id, get_lot_size,
                resolve_underlying, get_candle_history,
            )
        else:
            open_position(order, exec_settings, db, get_previous_candle, get_lot_size, get_candle_history)
    _client.xack(settings.redis_stream, settings.redis_consumer_group, message_id)


# How long a message can sit claimed-but-unacked before it's considered
# abandoned (crashed consumer, or an exception that left it unacked) and
# fair game to reclaim. Comfortably longer than any single message should
# ever take to process (option chain fetch + Dhan-throttled quote calls,
# worst case a few seconds) so a message still legitimately in flight is
# never yanked out from under its own consumer.
RECLAIM_MIN_IDLE_MS = 60_000


def _reclaim_stale_pending() -> None:
    """XAUTOCLAIM every PEL entry idle longer than RECLAIM_MIN_IDLE_MS onto
    this consumer and retry it - the actual retry _process_message's
    except branch only ever claimed to do (see module docstring). Safe to
    reclaim onto the SAME consumer name even with only one consumer
    process: XAUTOCLAIM's idle-time tracking is wall-clock based against
    the message's last-delivered time, so this also self-heals a
    crash-and-restart, not just an in-process exception. Walks the whole
    PEL each call (cursor loops back to "0-0" when exhausted) rather than
    claiming one page and stopping, so a backlog from an extended outage
    doesn't linger across multiple poll cycles."""
    cursor = "0-0"
    while True:
        cursor, claimed, _deleted = _client.xautoclaim(
            settings.redis_stream,
            settings.redis_consumer_group,
            settings.redis_consumer_name,
            min_idle_time=RECLAIM_MIN_IDLE_MS,
            start_id=cursor,
            count=10,
        )
        for message_id, fields in claimed:
            try:
                _process_message(message_id, fields)
            except Exception:
                logger.exception("failed to reprocess reclaimed message %s, will retry again next reclaim pass", message_id)
        if cursor == "0-0":
            break


def run(stop_event: threading.Event) -> None:
    _ensure_group()
    logger.info("execution consumer started (group=%s)", settings.redis_consumer_group)
    while not stop_event.is_set():
        try:
            _reclaim_stale_pending()
            response = _client.xreadgroup(
                settings.redis_consumer_group,
                settings.redis_consumer_name,
                {settings.redis_stream: ">"},
                count=10,
                block=5000,
            )
        except Exception:
            logger.exception("error reading from %s, retrying in 5s", settings.redis_stream)
            time_module.sleep(5)
            continue

        for _stream_name, messages in response or []:
            for message_id, fields in messages:
                try:
                    _process_message(message_id, fields)
                except Exception:
                    logger.exception("failed to process message %s, leaving unacked for retry", message_id)


def start_background() -> threading.Event:
    stop_event = threading.Event()
    thread = threading.Thread(target=run, args=(stop_event,), daemon=True, name="orders-consumer")
    thread.start()
    return stop_event
