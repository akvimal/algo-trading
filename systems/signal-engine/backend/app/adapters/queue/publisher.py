import json

import redis

from app.config import settings

_client = redis.Redis.from_url(settings.redis_url, decode_responses=True)


def publish_resolved_order(order: dict) -> None:
    """XADD to the orders.resolved stream - see docs/contracts/resolved-order.schema.json.
    Consumed by the (not yet built) execution system."""
    _client.xadd(settings.redis_stream, {"payload": json.dumps(order)})
