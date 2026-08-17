from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://algotrading:changeme@localhost:5433/algotrading"
    database_schema: str = "signal_generation"

    # market-data owns provider credentials/instrument master and
    # candle/underlying resolution - the in-house engine only ever talks
    # to it over HTTP, same as execution does for quotes.
    market_data_base_url: str = "http://market-data-backend:8000"
    market_data_timeout_seconds: float = 25.0
    # GET /options/leg-history can internally chunk into several throttled
    # (3s-apart) Dhan calls server-side for a wide date range (Phase 4c's
    # option backtesting, MAX_OPTION_BACKTEST_DAYS=180 -> up to 6 chunks) -
    # a longer timeout than the general market_data_timeout_seconds above,
    # not shared with it, since every other market-data call here is a
    # single fast request.
    option_history_timeout_seconds: float = 60.0

    # signal-processing is where a signal actually gets resolved/queued -
    # the engine posts to it via the exact same POST /signals contract
    # every webhook provider's intake route also uses.
    signal_processing_base_url: str = "http://signal-processing-backend:8000"
    signal_processing_timeout_seconds: float = 10.0

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
    # such cushion - see app/domain/engine.py's _run_one_breakout.
    breakout_ltf_settle_seconds: int = 5


settings = Settings()
