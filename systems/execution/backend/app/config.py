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

    # Balance/equity history (app/domain/equity_history.py): how often the
    # scheduled job samples every user account, and the timezone that decides
    # which calendar day a sample belongs to. 0 disables the job (resets still
    # record their own marker).
    equity_snapshot_poll_seconds: int = 300

    # Own-keys data model, execution side (docs/architecture.md, "Own-keys data model"). When
    # true, the automated jobs that mark or watch users' positions fetch quotes in one batch
    # PER OWNER on that owner's own Dhan keys (market-data's X-On-Behalf-Of) instead of one
    # batch for everyone on the shared platform credential. Off by default.
    job_quotes_use_owner_keys: bool = False
    # ...and when an owner's own batch comes back empty (no keys saved, or an expired Dhan
    # token, which lasts 24h), fall back to the platform credential for that batch so their
    # stop-losses and square-offs keep being enforced. Turn off to be strict.
    job_quotes_platform_fallback: bool = True

    # Server-side pending (limit) orders (app/domain/pending_orders.py). How often the
    # watcher checks armed orders against the underlying's price (0 disables the job),
    # how long an order lives if the caller gives no expiry, the longest expiry allowed,
    # and how many a user may have armed at once. Paper accounts only.
    pending_order_poll_seconds: int = 10
    pending_order_default_ttl_minutes: int = 1440
    pending_order_max_ttl_minutes: int = 10080
    max_pending_orders_per_user: int = 20

    # Paper track-record gate on turning live trading ON (app/domain/track_record.py).
    # Off unless REQUIRE_PAPER_TRACK_RECORD=true. The thresholds are product judgments,
    # not measurements - tune them.
    require_paper_track_record: bool = False
    track_record_min_trades: int = 30
    track_record_min_days: int = 14
    track_record_min_discipline: int = 60
    track_record_max_drawdown_pct: float = 20.0
    track_record_min_slippage_bps: float = 3.0
    equity_history_timezone: str = "Asia/Kolkata"

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

    # accounts service - only used by the live-trading gate
    # (app/domain/live_gate.py) to check that a user has saved broker
    # credentials before real orders can be enabled for them.
    accounts_base_url: str = "http://accounts-backend:8000"

    # signal-engine, asked (with the caller's own token) whether a user may see
    # a strategy and who created it - see app/adapters/signal_engine/client.py.
    # Used when creating a dedicated per-strategy account.
    signal_engine_base_url: str = "http://signal-engine-backend:8000"

    # How often the reconciliation job (scheduler.py) checks for
    # broker_orders rows stuck in SUBMITTING past broker_order_submit_timeout_seconds -
    # a crash between writing that row and recording Dhan's place_order
    # response leaves it there; the job resolves it against Dhan's own
    # order book (GET /dhan/order-book, matched by client_order_id) rather
    # than ever retrying the submission blind.
    broker_order_reconciliation_poll_seconds: int = 30
    broker_order_submit_timeout_seconds: int = 60

    # Browser origins allowed by CORS, comma-separated. "*" (the default) is
    # for local dev only; docker-compose.prod.yml sets the real origins. See
    # app/secure_config.py.
    cors_allow_origins: str = "*"
    # When true the service refuses to start with placeholder secrets or
    # wildcard CORS (set by docker-compose.prod.yml). Off by default.
    require_secure_config: bool = False


settings = Settings()
