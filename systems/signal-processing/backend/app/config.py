from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://algotrading:changeme@localhost:5432/algotrading"
    database_schema: str = "signal_processing"
    redis_url: str = "redis://localhost:6379/0"
    redis_stream: str = "orders.resolved"

    # A second, separate Redis stream (NOT orders.resolved above) - moves
    # resolve()'s Dhan-throttled option-chain calls off the webhook/POST
    # /signals request-response cycle, onto a background consumer
    # (app/consumers/signal_resolution_consumer.py), mirroring execution's
    # own orders_consumer.py pattern exactly. Purely internal to this
    # system (producer and consumer both live here) - not a cross-system
    # contract like orders.resolved is, so no docs/contracts/*.schema.json
    # entry needed. See app/domain/intake/core.py's
    # create_signal_from_ingest/resolve_and_finalize_signal split.
    signal_resolution_stream: str = "signals.pending_resolution"
    signal_resolution_consumer_group: str = "signal-processing-resolver"
    signal_resolution_consumer_name: str = "signal-processing-resolver-1"

    signal_generation_base_url: str = "http://signal-generation-backend:8000"
    signal_generation_timeout_seconds: float = 5.0

    # Option-strategy resolution only (Phase 4b of the options trading
    # module - see docs/architecture.md) - app/adapters/market_data/client.py.
    market_data_base_url: str = "http://market-data-backend:8000"
    # 10s, not the more typical 5s a plain LTP/candle call would use:
    # market-data's own provider-side option-chain/expiry throttle can
    # legitimately queue a request for up to ~4s (MAX_THROTTLE_WAIT_SECONDS
    # in dhan.py/delta.py) before it even starts the live provider call, so
    # a tighter budget here risked timing out on nothing but that internal
    # queueing - not a sign anything was actually down. Found live: two
    # real BTCUSD signals got rejected with "could not resolve option
    # expiries ... Read timed out (read timeout=5.0)" even though the same
    # call succeeded in ~2.3s moments later on retry.
    market_data_timeout_seconds: float = 10.0


settings = Settings()
