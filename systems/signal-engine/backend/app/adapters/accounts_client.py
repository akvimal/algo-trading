"""Fetches a user's own decrypted OpenRouter key from systems/accounts, for
BYO-key support on Weekly Advisor fundamentals (screener_fetch.py,
2026-09-16) - mirrors market-data's own app/adapters/accounts_client.py
(same internal route, same shared-secret header, same "degrade to
platform default rather than fail" convention), just scoped to the one
credential this service needs. Cached briefly in-memory for the same
reason that module gives: a batch weekly-advisor run can touch many
symbols in one request, and each one would otherwise pay its own round
trip to accounts for the same user's key."""

import logging
import threading
import time
from typing import Optional
from uuid import UUID

import requests

from app.config import settings

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 300.0

_cache_lock = threading.Lock()
_cache: dict[UUID, tuple[Optional[str], float]] = {}


def get_user_openrouter_key(user_id: UUID) -> Optional[str]:
    """None if accounts has nothing stored for this user, accounts is
    unreachable (e.g. this stack is up without the "execution" profile,
    which accounts-backend sits behind - see docker-compose.yml), or the
    internal call fails for any other reason. Callers already treat a
    missing key as "fall back to the platform OPENROUTER_API_KEY env var,
    or skip the AI read" - see screener_fetch.py's _analyze_via_ai."""
    with _cache_lock:
        cached = _cache.get(user_id)
    if cached is not None and (time.monotonic() - cached[1]) < _CACHE_TTL_SECONDS:
        return cached[0]

    try:
        resp = requests.get(
            f"{settings.accounts_base_url}/internal/credentials/{user_id}/openrouter",
            headers={"X-Internal-Secret": settings.internal_service_secret},
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.RequestException:
        logger.warning("could not fetch OpenRouter key for user %s from accounts - falling back to platform default", user_id)
        return None

    result: Optional[str] = data.get("openrouter_api_key") if data.get("has_openrouter") else None

    with _cache_lock:
        _cache[user_id] = (result, time.monotonic())
    return result
