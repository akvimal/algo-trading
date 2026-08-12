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


settings = Settings()
