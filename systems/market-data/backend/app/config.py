from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # market-data's first-ever DB dependency (it was in-memory-cache-only
    # by design otherwise, see its README/CLAUDE.md) - added specifically
    # for sentiment_history (app/adapters/db/models.py), a persisted log
    # of the sentiment badges' own OI-based reads plus the underlying's
    # spot price at that moment, so a past bullish/bearish read can later
    # be checked against what price actually did. Nothing else here uses
    # the DB - the instrument-master cache and everything else stays
    # exactly as in-memory as before.
    database_url: str = "postgresql+psycopg://algotrading:changeme@localhost:5433/algotrading"
    database_schema: str = "market_data"
    # Same cadence SentimentBadges.tsx/shell/index.html already poll GET
    # /options/sentiment at - see app/scheduler.py's _record_sentiment_history.
    sentiment_history_interval_minutes: int = 5

    timezone: str = "Asia/Kolkata"
    # Scheduled instrument-master resync, before market open.
    instrument_sync_hour: int = 8
    instrument_sync_minute: int = 0

    dhan_client_id: str = ""
    dhan_access_token: str = ""
    # PUT /dhan/credentials persists here (a Docker-volume-backed file, not
    # a DB - matches this service's own "in-memory cache, cheap to rebuild"
    # design instead of adding one) so a UI-submitted token survives a
    # container restart - previously it lived only in the in-memory
    # _renewed_token slot (app/providers/dhan.py) and silently reverted to
    # this same dhan_access_token seed value on every restart, which is
    # exactly what caused a real outage (see docs/architecture.md). The
    # env var above is now only a first-boot seed for a brand new volume;
    # once anyone's used the UI once, this file is authoritative.
    dhan_credentials_file_path: str = "/data/dhan-credentials.json"
    # Dhan tokens are valid 24h - renewing at this cadence leaves comfortable
    # margin even if a run is briefly delayed. See app/providers/dhan.py's
    # renew_access_token / app/scheduler.py. 0 disables the scheduled+on-boot
    # renewal job entirely (no periodic run, no immediate run on startup) -
    # an escape hatch for a setup sharing one Dhan token across multiple
    # auto-renewing processes (they'd otherwise race and invalidate each
    # other's copy - confirmed live). dev and test each use their OWN
    # separate token instead (Dhan allows multiple concurrent active
    # tokens per account), so both stay at the default here - see
    # docs/architecture.md.
    dhan_token_renew_interval_hours: int = 20

    # Delta Exchange India (CRYPTO segment) - see app/providers/delta.py.
    # Every endpoint this provider calls is public (no api-key/secret
    # needed at all), unlike Dhan - see docs/architecture.md.
    delta_base_url: str = "https://api.india.delta.exchange"
    delta_ws_url: str = "wss://socket.india.delta.exchange"

    # Manual escape hatch for Dhan's own SEM_LOT_UNITS being confirmed wrong
    # for MCX commodities - every MCX FUTCOM row in a live download reports
    # SEM_LOT_UNITS=1 regardless of the real contract size (no alternate
    # Dhan field carries the correct value); a real executed GOLDM order
    # confirmed the true multiplier is 10, not 1. Values below are each
    # commodity's real trading-unit / quotation-unit ratio, confirmed via
    # MCX contract specs (groww.in/blog/lot-size-for-commodity, dhan.co/
    # commodities-lot-size, and others, 2026-08-14) - a mini/micro variant
    # is NOT automatically the same multiplier as its full-size sibling,
    # each pair must be checked independently:
    #   GOLD 1kg / GOLDM 100g, both quoted per 10g -> 100 / 10
    #   CRUDEOIL 100bbl / CRUDEOILM 10bbl, both quoted per barrel -> 100 / 10
    #   SILVER 30kg / SILVERM 5kg / SILVERMIC 1kg, all quoted per kg -> 30 / 5 / 1
    #   SILVER100 100g, quoted per 10g (same quotation unit as GOLD) -> 10
    #   NATURALGAS 1250mmBtu / NATGASMINI 250mmBtu, both quoted per mmBtu -> 1250 / 250
    # "underlying:qty" pairs, comma-separated - see app/providers/dhan.py's
    # _parse_lot_size_overrides/sync_instruments.
    mcx_lot_size_overrides: str = (
        "GOLD:100,GOLDM:10,CRUDEOIL:100,CRUDEOILM:10,"
        "SILVER:30,SILVERM:5,SILVERMIC:1,SILVER100:10,"
        "NATURALGAS:1250,NATGASMINI:250"
    )

    # BYO Dhan credentials (Phase 3 of the manual-trading SaaS, see
    # docs/architecture.md) - jwt_secret verifies the same bearer tokens
    # systems/accounts issues (must match its own JWT_SECRET exactly),
    # used ONLY to optionally identify a caller (app/auth.py's
    # get_optional_user_id never raises - most routes here still serve
    # unauthenticated callers on the platform-default Dhan credential
    # exactly as before this phase). internal_service_secret/
    # accounts_base_url are for the outbound call to accounts' own
    # internal, decrypted-credential-returning route (see
    # app/adapters/accounts_client.py) - must match accounts' identical
    # INTERNAL_SERVICE_SECRET.
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    internal_service_secret: str = "change-me-in-production"
    accounts_base_url: str = "http://accounts-backend:8000"

    # Live-broker-adapter P0 (see docs/architecture.md) - order-placement
    # routes require a real logged-in user (app/auth.py's require_user_id,
    # unlike the optional-auth quote/candle/option-chain routes above) and
    # strictly their OWN BYO Dhan credentials (never the platform-default
    # fallback - see accounts_client.get_user_dhan_credentials_strict).
    # dhan_postback_secret is a shared-secret PATH segment for Dhan's own
    # order-update postback (Dhan doesn't cryptographically sign postback
    # requests, so this is the only thing keeping the URL from being
    # spoofable by anyone who guesses it) - register
    # https://<this-host>/dhan/order-update/<dhan_postback_secret> with
    # Dhan as the postback URL, never the bare /dhan/order-update path.
    # execution_base_url is where the validated postback gets relayed to -
    # market-data holds no order state of its own (see broker_orders'
    # own "each system owns its own schema" placement in execution).
    dhan_postback_secret: str = "change-me-in-production"
    execution_base_url: str = "http://execution-backend:8000"

    # Standalone price alerts (see app/domain/price_alerts.py + scheduler).
    # A single Telegram bot + chat receives every fired alert. Create a bot
    # via @BotFather for the token; get your chat id from
    # https://api.telegram.org/bot<token>/getUpdates after messaging it.
    # Both blank -> alerts still evaluate and get marked triggered, but
    # nothing is sent (app/domain/notify.py logs a warning once).
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    # How often the scheduler polls the LTP for every active alert.
    price_alert_check_interval_seconds: int = 60


settings = Settings()
