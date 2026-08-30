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

    # Live-broker-adapter P0 (see docs/architecture.md) - protects
    # POST /internal/dhan/order-update, the route market-data relays Dhan's
    # own order-status postback to (market-data holds no order state of its
    # own - see broker_orders' "each system owns its own schema" placement
    # here instead). Must match market-data's/accounts' identical
    # INTERNAL_SERVICE_SECRET.
    internal_service_secret: str = "change-me-in-production"

    # Platform-wide kill switch for real order submission - an env var
    # (not a DB row) so it can be flipped instantly, with no DB write in
    # the loop, to stop every account's real trading at once. True BLOCKS
    # all real submission regardless of any account's own
    # execution.accounts.live_trading_enabled opt-in (checked first, before
    # that per-account flag, in position_manager's submission path) - the
    # per-account flag is a separate, independent gate on top, not
    # something this switch's default state grants. Defaults false (not
    # killed) - real trading still requires each account to separately opt
    # in via its own live_trading_enabled.
    live_trading_kill_switch: bool = False

    # How often the reconciliation job (scheduler.py) checks for
    # broker_orders rows stuck in SUBMITTING past broker_order_submit_timeout_seconds -
    # a crash between writing that row and recording Dhan's place_order
    # response leaves it there; the job resolves it against Dhan's own
    # order book (GET /dhan/order-book, matched by client_order_id) rather
    # than ever retrying the submission blind.
    broker_order_reconciliation_poll_seconds: int = 30
    broker_order_submit_timeout_seconds: int = 60


settings = Settings()
