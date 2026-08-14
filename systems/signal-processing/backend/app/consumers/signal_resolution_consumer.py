"""Redis consumer group reader for signals.pending_resolution - at-least-
once delivery via XREADGROUP/XACK, so a crash mid-processing redelivers
the message instead of silently dropping a signal. resolve_and_finalize_signal()
is itself safe to re-run (resolve() is a pure computation, and
re-publishing the same signal_id to orders.resolved is a no-op downstream
- execution's open_position/open_option_group are already idempotent on
signal_id). Mirrors execution/backend/app/consumers/orders_consumer.py
exactly - same pattern, different stream.
"""

import logging
import threading
import time as time_module

import redis
from redis.exceptions import ResponseError

from app.adapters.db.session import SessionLocal
from app.config import settings
from app.domain.intake.core import resolve_and_finalize_signal
from app.domain.models import SignalIngest

logger = logging.getLogger(__name__)

_client = redis.Redis.from_url(settings.redis_url, decode_responses=True)


def _ensure_group() -> None:
    try:
        _client.xgroup_create(settings.signal_resolution_stream, settings.signal_resolution_consumer_group, id="0", mkstream=True)
    except ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise


def _process_message(message_id: str, fields: dict) -> None:
    signal_id = fields["signal_id"]
    signal = SignalIngest.model_validate_json(fields["payload"])
    with SessionLocal() as db:
        resolve_and_finalize_signal(db, signal_id, signal)
    _client.xack(settings.signal_resolution_stream, settings.signal_resolution_consumer_group, message_id)


def run(stop_event: threading.Event) -> None:
    _ensure_group()
    logger.info("signal-resolution consumer started (group=%s)", settings.signal_resolution_consumer_group)
    while not stop_event.is_set():
        try:
            response = _client.xreadgroup(
                settings.signal_resolution_consumer_group,
                settings.signal_resolution_consumer_name,
                {settings.signal_resolution_stream: ">"},
                count=10,
                block=5000,
            )
        except Exception:
            logger.exception("error reading from %s, retrying in 5s", settings.signal_resolution_stream)
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
    thread = threading.Thread(target=run, args=(stop_event,), daemon=True, name="signal-resolution-consumer")
    thread.start()
    return stop_event
