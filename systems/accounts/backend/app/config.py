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

    # Protects GET /internal/credentials/{user_id}/dhan (Phase 3 of the
    # manual-trading SaaS, see docs/architecture.md) - the one route that
    # DOES return a decrypted secret, since market-data needs the real
    # value to call Dhan on a user's behalf. A shared secret header, not a
    # user JWT - the caller here is a trusted service (market-data), not
    # a person. Known only to accounts and market-data, not execution or
    # any frontend.
    internal_service_secret: str = "change-me-in-production"

    # Whose saved Dhan credentials the PLATFORM uses (market-data's background jobs, shared feed and option-chain reads). Empty: the first admin
    # ever created. See app/api/routes/internal.py's platform_owner.
    platform_dhan_owner_email: str = ""

    # Browser origins allowed by CORS, comma-separated. "*" (the default) is
    # for local dev only; docker-compose.prod.yml sets the real origins. See
    # app/secure_config.py.
    cors_allow_origins: str = "*"
    # When true the service refuses to start with placeholder secrets or
    # wildcard CORS (set by docker-compose.prod.yml). Off by default.
    require_secure_config: bool = False

    # Auth rate limits (app/rate_limit.py). Failed logins are counted per
    # email and per client IP over the window; signups per IP.
    login_max_failures_per_email: int = 10
    login_max_failures_per_ip: int = 20
    login_window_seconds: int = 15 * 60
    signup_max_per_ip: int = 10
    signup_window_seconds: int = 60 * 60
    # Read the client IP from X-Forwarded-For (first hop). Only turn on behind
    # a proxy that sets it (Caddy on the VPS) - otherwise the header is
    # attacker-controlled and would let anyone dodge the per-IP limits.
    trust_forwarded_for: bool = False


settings = Settings()
