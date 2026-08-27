from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://algotrading:changeme@localhost:5433/algotrading"
    database_schema: str = "execution"

    redis_url: str = "redis://localhost:6379/0"
    redis_stream: str = "orders.resolved"
    redis_consumer_group: str = "execution-service"
    redis_consumer_name: str = "execution-worker-1"

    # market-data owns provider credentials/instrument master - execution
    # only ever talks to it over HTTP, never embeds a broker SDK directly.
    market_data_base_url: str = "http://market-data-backend:8000"
    # execution calls POST /quotes/ltp/batch once per exchange (not once
    # per symbol - see position_manager._quotes_by_exchange), so this only
    # needs to cover market-data's own worst-case: its throttle wait
    # (MAX_THROTTLE_WAIT_SECONDS=4s) plus its own Dhan request timeout
    # (15s) = ~19s. 25s leaves margin above that single worst case, not
    # margin per-symbol like before. Real long-term fix is a Dhan
    # WebSocket feed in market-data (ticks cached in memory, no
    # per-request outbound call at all) - see docs/architecture.md.
    market_data_timeout_seconds: float = 25.0

    # How often the exit-monitor job (stop-loss/target/trailing) polls -
    # independent of the square-off job below. Only positions with a
    # stop_loss_price or target_price set are checked each run, so this
    # can run more often than square-off without scanning every position.
    exit_monitor_poll_seconds: int = 30

    # How often the square-off job checks each OPEN position's own
    # stored square_off_time (copied from its segment's execution.accounts
    # row at open time) against local time. Replaced a single daily
    # CronTrigger fired at one global time - different segments can
    # configure different times (or none at all, e.g. CRYPTO), so this
    # has to be a periodic check across potentially-distinct times
    # instead of one fixed fire time.
    square_off_poll_seconds: int = 30

    # Verifies bearer tokens issued by systems/accounts' POST /auth/login -
    # same secret, shared via env var (not an HTTP call back to accounts
    # on every request - see app/auth.py's own comment). Must match
    # accounts' own JWT_SECRET exactly.
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"


settings = Settings()
