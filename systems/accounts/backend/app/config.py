from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://algotrading:changeme@localhost:5432/algotrading"
    database_schema: str = "accounts"

    # Signs/verifies the bearer tokens issued by POST /auth/login - shared
    # with execution/market-data in later phases so they can validate a
    # token locally (fast, no per-request call back to this service)
    # instead of treating accounts as a hard runtime dependency for every
    # request across the platform. Rotating this invalidates every session.
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expiry_minutes: int = 60 * 24 * 7  # 7 days - no refresh-token flow yet, MVP scope

    # Fernet key (32 url-safe base64 bytes) encrypting the four broker
    # credential fields at rest in accounts.broker_credentials - see
    # app/domain/security.py. Never logged, never returned by any route.
    credentials_encryption_key: str = "change-me-in-production-32-bytes-min"


settings = Settings()
