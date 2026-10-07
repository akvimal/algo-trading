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

# "This user has no keys" is cached far more briefly than "here are their keys". Under
# REQUIRE_OWN_DHAN_KEYS a user with no keys is refused (own_dhan_keys_required); if that
# answer stuck for the full 5 minutes, someone who had JUST saved their keys would keep
# being told to add them and it would look broken. 10s still absorbs a burst of calls.
_NEGATIVE_CACHE_TTL_SECONDS = 10.0

_cache_lock = threading.Lock()
# user_id -> (DhanCredentials or None, cached_at) - None is cached too
# (a user with no Dhan credentials saved yet), so a request from them
# doesn't retry accounts on every single call either.
_cache: dict[UUID, tuple[Optional[DhanCredentials], float]] = {}

# Separate small cache for BYO OpenRouter keys (2026-09-16, news.py's AI
# digest) - same TTL/shape reasoning as the Dhan cache above, just keyed
# on a different secret.
_openrouter_cache_lock = threading.Lock()
_openrouter_cache: dict[UUID, tuple[Optional[str], float]] = {}


class CredentialLookupFailed(Exception):
    """accounts could not be reached, so we do NOT know whether the user has keys."""


def get_user_dhan_credentials(user_id: UUID, raise_on_failure: bool = False) -> Optional[DhanCredentials]:
    """None if accounts has nothing stored for this user, or the internal
    call fails for any reason - callers already treat a missing
    DhanCredentials as "fall back to the platform-default credential",
    same as if this user had never been authenticated at all (see
    DhanProvider.get_ltp_batch's own docstring) - a market-data outage
    reaching accounts must never break quote lookups outright."""
    with _cache_lock:
        cached = _cache.get(user_id)
    if cached is not None and (time.monotonic() - cached[1]) < (_CACHE_TTL_SECONDS if cached[0] is not None else _NEGATIVE_CACHE_TTL_SECONDS):
        return cached[0]

    try:
        resp = requests.get(
            f"{settings.accounts_base_url}/internal/credentials/{user_id}/dhan",
            headers={"X-Internal-Secret": settings.internal_service_secret},
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.RequestException as exc:
        if raise_on_failure:
            # The own-keys policy (app/data_access.py) must not mistake an accounts
            # outage for "this user has no keys" - and must not fall back to the platform.
            raise CredentialLookupFailed(str(exc)) from exc
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


def get_user_openrouter_key(user_id: UUID) -> Optional[str]:
    """BYO OpenRouter key (2026-09-16) - the news digest's counterpart to
    get_user_dhan_credentials above. None if accounts has nothing stored,
    or the internal call fails for any reason - news.py already treats a
    missing key as "fall back to the platform OPENROUTER_API_KEY env var,
    or skip the AI step entirely", same graceful-degradation convention
    every other optional credential here uses."""
    with _openrouter_cache_lock:
        cached = _openrouter_cache.get(user_id)
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

    with _openrouter_cache_lock:
        _openrouter_cache[user_id] = (result, time.monotonic())
    return result


def fetch_platform_dhan() -> Optional[dict]:
    """The platform owner's saved Dhan credentials ({has_dhan, owner_user_id, dhan_client_id, dhan_access_token}), or None when accounts cannot be
    reached. Not cached: the caller polls every few minutes and a stale answer would defeat the point."""
    try:
        resp = requests.get(f"{settings.accounts_base_url}/internal/platform/dhan", headers={"X-Internal-Secret": settings.internal_service_secret}, timeout=8)
        resp.raise_for_status()
        return resp.json()
    except (requests.exceptions.RequestException, ValueError) as exc:
        logger.warning("could not read the platform Dhan credentials from accounts: %s", type(exc).__name__)
        return None


def push_platform_dhan(access_token: str, client_id: Optional[str] = None) -> bool:
    """Save a (renewed) Dhan token as the platform owner's, so there is only one copy. True when accounts stored it."""
    try:
        resp = requests.put(
            f"{settings.accounts_base_url}/internal/platform/dhan",
            json={"dhan_access_token": access_token, **({"dhan_client_id": client_id} if client_id else {})},
            headers={"X-Internal-Secret": settings.internal_service_secret},
            timeout=8,
        )
        return resp.ok
    except requests.exceptions.RequestException as exc:
        logger.warning("could not save the platform Dhan token to accounts: %s", type(exc).__name__)
        return False
