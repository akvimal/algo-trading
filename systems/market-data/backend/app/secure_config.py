"""Refuse to run production with placeholder secrets or wildcard CORS
(Phase 0 of docs/redesign-rollout-plan.md).

Every service used to ship with `change-me-in-production` defaults and
`allow_origins=["*"]`, with nothing stopping a real deployment from running
that way. The check is opt-in so local dev is untouched: it only refuses to
start when REQUIRE_SECURE_CONFIG=true (set by docker-compose.prod.yml);
otherwise it logs one warning listing what is insecure.

Duplicated per service on purpose (systems/* share no code)."""

import logging

from app.config import settings

logger = logging.getLogger(__name__)

# The settings that hold a secret in THIS service: (env-style name, value).
SECRETS = lambda: {"JWT_SECRET": settings.jwt_secret, "INTERNAL_SERVICE_SECRET": settings.internal_service_secret, "DHAN_POSTBACK_SECRET": settings.dhan_postback_secret}

MIN_SECRET_LENGTH = 16


def _weak_secret(value: str) -> bool:
    v = (value or "").strip()
    return v == "" or "change-me" in v.lower() or len(v) < MIN_SECRET_LENGTH


def cors_origins() -> list[str]:
    """The allowed browser origins from CORS_ALLOW_ORIGINS (comma-separated).
    "*" (the local-dev default) means any origin."""
    return [o.strip() for o in settings.cors_allow_origins.split(",") if o.strip()]


def insecure_settings() -> list[str]:
    problems = [f"{name} is empty, a placeholder or shorter than {MIN_SECRET_LENGTH} characters" for name, value in SECRETS().items() if _weak_secret(value)]
    if "*" in cors_origins():
        problems.append("CORS_ALLOW_ORIGINS is '*' (any website may call this API from a browser)")
    return problems


def enforce_secure_config() -> None:
    problems = insecure_settings()
    if not problems:
        return
    if settings.require_secure_config:
        raise RuntimeError(
            "refusing to start with REQUIRE_SECURE_CONFIG=true: " + "; ".join(problems) + ". "
            "Set real values in .env (node scripts/generate-secrets.js --write) and CORS_ALLOW_ORIGINS."
        )
    logger.warning("insecure configuration (fine for local dev, refused when REQUIRE_SECURE_CONFIG=true): %s", "; ".join(problems))
