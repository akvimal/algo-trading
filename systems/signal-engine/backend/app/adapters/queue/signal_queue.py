import redis

from app.config import settings
from app.domain.processing.models import SignalIngest

_client = redis.Redis.from_url(settings.redis_url, decode_responses=True)


def publish_pending_signal(signal_id: str, signal: SignalIngest) -> None:
    """XADD to signals.pending_resolution - consumed by
    app/consumers/signal_resolution_consumer.py, which calls
    resolve_and_finalize_signal() for real off the request/response cycle.
    See app/config.py's signal_resolution_stream for why this is a
    separate stream from orders.resolved (publisher.py)."""
    _client.xadd(settings.signal_resolution_stream, {"signal_id": signal_id, "payload": signal.model_dump_json()})
