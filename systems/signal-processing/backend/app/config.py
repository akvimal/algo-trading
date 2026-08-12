from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://algotrading:changeme@localhost:5432/algotrading"
    database_schema: str = "signal_processing"
    redis_url: str = "redis://localhost:6379/0"
    redis_stream: str = "orders.resolved"

    signal_generation_base_url: str = "http://signal-generation-backend:8000"
    signal_generation_timeout_seconds: float = 5.0

    # Option-strategy resolution only (Phase 4b of the options trading
    # module - see docs/architecture.md) - app/adapters/market_data/client.py.
    market_data_base_url: str = "http://market-data-backend:8000"
    market_data_timeout_seconds: float = 5.0


settings = Settings()
