"""Redis consumer group reader for orders.resolved - at-least-once
delivery via XREADGROUP/XACK, so a crash mid-processing redelivers the
message instead of silently dropping a signal. open_position() is itself
idempotent on signal_id, so redelivery is safe.
"""

import logging
import threading
import time as time_module

import redis
from redis.exceptions import ResponseError

from app.adapters.db.session import SessionLocal
from app.adapters.quotes.client import get_lot_size, get_ltp_batch, get_previous_candle, resolve_symbol_by_security_id
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
            open_option_group(order, exec_settings, db, get_ltp_batch, resolve_symbol_by_security_id, get_lot_size)
        else:
            open_position(order, exec_settings, db, get_previous_candle, get_lot_size)
    _client.xack(settings.redis_stream, settings.redis_consumer_group, message_id)


def run(stop_event: threading.Event) -> None:
    _ensure_group()
    logger.info("execution consumer started (group=%s)", settings.redis_consumer_group)
    while not stop_event.is_set():
        try:
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
