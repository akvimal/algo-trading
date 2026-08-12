from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://algotrading:changeme@localhost:5433/algotrading"
    database_schema: str = "signal_generation"

    # market-data owns provider credentials/instrument master and
    # candle/underlying resolution - the in-house engine only ever talks
    # to it over HTTP, same as execution does for quotes.
    market_data_base_url: str = "http://market-data-backend:8000"
    market_data_timeout_seconds: float = 25.0

    # signal-processing is where a signal actually gets resolved/queued -
    # the engine posts to it exactly like n8n does for webhook providers.
    signal_processing_base_url: str = "http://signal-processing-backend:8000"
    signal_processing_timeout_seconds: float = 10.0

    # How often the live engine tick checks every `live`/`in_house`
    # Strategy for a fresh completed bar - deliberately much shorter than
    # any one strategy's own `interval`; run_live_tick's per-strategy
    # last_signal_candle_ts check is what prevents re-signaling on the
    # same bar every tick, not this poll cadence.
    engine_poll_seconds: int = 60


settings = Settings()
