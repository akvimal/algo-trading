"""Fetches a user's own decrypted Dhan credentials from systems/accounts,
for BYO-credentials support (Phase 3 of the manual-trading SaaS, see
docs/architecture.md) - the counterpart to app/auth.py's
get_optional_user_id (which only ever gives a user id, never a
credential). Cached briefly in-memory to avoid a round trip to accounts
on every single quote/candle/option-chain call - matches this service's
own "in-memory cache, cheap to rebuild" philosophy (see its README) for
every other cache it already keeps."""

import logging
import threading
import time
from typing import Optional
from uuid import UUID

import requests

from app.config import settings
from app.providers.dhan import DhanCredentials

logger = logging.getLogger(__name__)

# Short enough that a user who just saved new Dhan credentials (PUT
# /credentials on accounts) sees them take effect within this window
# without needing to restart anything; long enough that a burst of
# quote/candle/option-chain calls for the same user within one request
# doesn't each pay their own round trip to accounts.
_CACHE_TTL_SECONDS = 300.0

_cache_lock = threading.Lock()
# user_id -> (DhanCredentials or None, cached_at) - None is cached too
# (a user with no Dhan credentials saved yet), so a request from them
# doesn't retry accounts on every single call either.
_cache: dict[UUID, tuple[Optional[DhanCredentials], float]] = {}


def get_user_dhan_credentials(user_id: UUID) -> Optional[DhanCredentials]:
    """None if accounts has nothing stored for this user, or the internal
    call fails for any reason - callers already treat a missing
    DhanCredentials as "fall back to the platform-default credential",
    same as if this user had never been authenticated at all (see
    DhanProvider.get_ltp_batch's own docstring) - a market-data outage
    reaching accounts must never break quote lookups outright."""
    with _cache_lock:
        cached = _cache.get(user_id)
    if cached is not None and (time.monotonic() - cached[1]) < _CACHE_TTL_SECONDS:
        return cached[0]

    try:
        resp = requests.get(
            f"{settings.accounts_base_url}/internal/credentials/{user_id}/dhan",
            headers={"X-Internal-Secret": settings.internal_service_secret},
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.RequestException:
        logger.warning("could not fetch Dhan credentials for user %s from accounts - falling back to platform default", user_id)
        return None

    result: Optional[DhanCredentials] = None
    if data.get("has_dhan"):
        result = DhanCredentials(
            client_id=data["dhan_client_id"], access_token=data["dhan_access_token"], throttle_key=str(user_id)
        )

    with _cache_lock:
        _cache[user_id] = (result, time.monotonic())
    return result


def get_user_dhan_credentials_strict(user_id: UUID) -> DhanCredentials:
    """For the live-broker-adapter's order-placement routes ONLY (see
    app/auth.py's require_user_id) - unlike get_user_dhan_credentials
    above, this NEVER falls back to the platform-default credential and
    NEVER returns None. A real order must always run on the specific
    person's own broker account it's attributed to; silently using the
    platform-wide default (or another user's cached credential) for a
    real trade would be a serious mistake a quote lookup's "degrade
    gracefully" convention must not carry over to. Deliberately bypasses
    the cache above too - a real order is worth one extra round trip to
    accounts to get the freshest possible answer, and a stale
    has_dhan=False cached during an accounts blip must never block a
    legitimate order once accounts recovers."""
    try:
        resp = requests.get(
            f"{settings.accounts_base_url}/internal/credentials/{user_id}/dhan",
            headers={"X-Internal-Secret": settings.internal_service_secret},
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.RequestException as exc:
        raise RuntimeError(f"could not reach accounts to resolve Dhan credentials for user {user_id}") from exc

    if not data.get("has_dhan"):
        raise RuntimeError(f"user {user_id} has no Dhan credentials configured - cannot place a real order on their behalf")
    return DhanCredentials(client_id=data["dhan_client_id"], access_token=data["dhan_access_token"], throttle_key=str(user_id))
