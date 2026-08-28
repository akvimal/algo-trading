from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://algotrading:changeme@localhost:5433/algotrading"
    # signal-engine is the merger of the old signal-generation and
    # signal-processing services (2026-08-28, see docs/architecture.md) -
    # each kept its own Postgres schema rather than merging tables, so
    # there are still two schema names here, not one. No data migration:
    # both schemas already lived in the same shared `algotrading` database
    # before the merge, just addressed from two separate services.
    generation_database_schema: str = "signal_generation"
    processing_database_schema: str = "signal_processing"

    redis_url: str = "redis://localhost:6379/0"
    redis_stream: str = "orders.resolved"

    # A second, separate Redis stream (NOT redis_stream above) - moves
    # resolve()'s Dhan-throttled option-chain calls off the webhook/POST
    # /signals request-response cycle, onto a background consumer
    # (app/consumers/signal_resolution_consumer.py), mirroring execution's
    # own orders_consumer.py pattern exactly. Purely internal to this
    # service (producer and consumer both live here) - not a cross-system
    # contract like orders.resolved is, so no docs/contracts/*.schema.json
    # entry needed. See app/domain/processing/intake/core.py's
    # create_signal_from_ingest/resolve_and_finalize_signal split.
    signal_resolution_stream: str = "signals.pending_resolution"
    signal_resolution_consumer_group: str = "signal-processing-resolver"
    signal_resolution_consumer_name: str = "signal-processing-resolver-1"

    # market-data owns provider credentials/instrument master and
    # candle/underlying resolution - the in-house engine and option-
    # strategy resolution only ever talk to it over HTTP, same as
    # execution does for quotes.
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
    market_data_timeout_seconds: float = 25.0
    # GET /options/leg-history can internally chunk into several throttled
    # (3s-apart) Dhan calls server-side for a wide date range (Phase 4c's
    # option backtesting, MAX_OPTION_BACKTEST_DAYS=180 -> up to 6 chunks) -
    # a longer timeout than the general market_data_timeout_seconds above,
    # not shared with it, since every other market-data call here is a
    # single fast request.
    option_history_timeout_seconds: float = 60.0

    # How often the live engine tick checks every `live`/`in_house`
    # Strategy for a fresh completed bar - deliberately much shorter than
    # any one strategy's own `interval`; run_live_tick's per-strategy
    # last_signal_candle_ts check is what prevents re-signaling on the
    # same bar every tick, not this poll cadence.
    engine_poll_seconds: int = 60

    # A breakout rule's LTF trigger candle must be at least this many
    # seconds past its own scheduled close before the engine will act on
    # it - a real-world settle buffer against the provider's own
    # publishing lag (its API can still be finalizing a candle's OHLC a
    # few seconds after our own timestamp math says it "should" be
    # complete). engine_poll_seconds' 60s cadence already absorbs most of
    # this in practice, but a tick landing right at the boundary has no
    # such cushion - see app/domain/generation/engine.py's _run_one_breakout.
    breakout_ltf_settle_seconds: int = 5


settings = Settings()
