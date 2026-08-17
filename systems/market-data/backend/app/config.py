from pydantic_settings import BaseSettings


class Settings(BaseSettings):
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


settings = Settings()
