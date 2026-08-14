from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    timezone: str = "Asia/Kolkata"
    # Scheduled instrument-master resync, before market open.
    instrument_sync_hour: int = 8
    instrument_sync_minute: int = 0

    dhan_client_id: str = ""
    dhan_access_token: str = ""
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
    # for MCX commodities - a real executed order showed GOLDM/CRUDEOILM's
    # true lot multiplier is 10, not the 1 both the compact and detailed
    # Dhan instrument-master CSVs report (no alternate Dhan field carries
    # the correct value). "underlying:qty" pairs, comma-separated - see
    # app/providers/dhan.py's _parse_lot_size_overrides/sync_instruments.
    mcx_lot_size_overrides: str = "GOLD:10,GOLDM:10,CRUDEOIL:10,CRUDEOILM:10"


settings = Settings()
