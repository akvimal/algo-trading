"""Which credential may a market-data request use? The own-keys policy.

Every user-facing data route used to do
    credentials = get_user_dhan_credentials(user_id) if user_id else None
where None silently meant "the shared PLATFORM Dhan credential". At 100+ users that
one shared rate budget is the first thing to break (a 429 blocks every user).
Decision 1 in docs/redesign-rollout-plan.md: users bring their own Dhan keys for live
data, and the platform credential serves only the scheduled end-of-day jobs.

REQUIRE_OWN_DHAN_KEYS (off by default, so nothing changes until it is flipped):
  * flag off        exactly the old behaviour (a user's keys if signed in, else platform).
  * flag on, Dhan-backed data (anything but CRYPTO, which is public Delta data):
      - a signed-in user       their own saved keys, or 403 own_dhan_keys_required
      - a trusted service      (presents INTERNAL_SERVICE_SECRET) with X-On-Behalf-Of: that
                               user's keys (or 403, same as above); without it, the platform
                               credential - the residual for automation, see below
      - anyone else            401, never the platform credential
  * accounts unreachable while checking keys  503, never "no keys", never platform.

RESIDUAL, on purpose and documented: automated jobs that watch many users' positions in
one batch (execution's exit monitor, square-off, P&L snapshots, equity snapshots, the
pending-order watcher; signal-engine's in-house engine) still use the platform credential
through the trusted-service path. Moving them to each owner's keys (X-On-Behalf-Of, one
batch per user) is the follow-up; this change already stops every BROWSER from spending
the shared budget, which is where the 429s came from.
"""

from typing import Optional
from uuid import UUID

from fastapi import HTTPException, status

from app.adapters.accounts_client import CredentialLookupFailed, get_user_dhan_credentials
from app.auth import Caller
from app.config import settings
from app.providers.dhan import DhanCredentials

KEYS_REQUIRED_CODE = "own_dhan_keys_required"


def keys_required() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=f"{KEYS_REQUIRED_CODE}: add your own Dhan API keys (Market Data > Data provider keys) to see live market data",
        headers={"X-Error-Code": KEYS_REQUIRED_CODE},
    )


def is_dhan_exchange(exchange: Optional[str]) -> bool:
    """CRYPTO is public Delta data and needs no Dhan keys; everything else (and an
    unspecified exchange, e.g. the sentiment badge that spans several) is Dhan-backed."""
    return (exchange or "").strip().upper() != "CRYPTO"


def data_credentials(caller: Caller, exchange: Optional[str] = None) -> Optional[DhanCredentials]:
    """The DhanCredentials this request must run on, or None for "the platform
    credential" (only ever returned when the policy allows it). Raises HTTPException
    (401 / 403 / 503) when it does not."""
    effective_user = caller.user_id or (caller.on_behalf_of if caller.trusted_service else None)

    if not settings.require_own_dhan_keys or not is_dhan_exchange(exchange):
        return get_user_dhan_credentials(effective_user) if effective_user else None

    if effective_user is not None:
        try:
            credentials = get_user_dhan_credentials(effective_user, raise_on_failure=True)
        except CredentialLookupFailed:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="could not verify your Dhan keys right now - try again shortly"
            )
        if credentials is None:
            raise keys_required()
        return credentials

    if caller.trusted_service:
        return None  # automation / EOD: the platform credential (the documented residual)
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="sign in to see live market data")


def ws_dhan_allowed(user_id: Optional[UUID]) -> bool:
    """May this WebSocket connection subscribe to Dhan-backed symbols? With the flag
    off, anyone (as before). With it on, only a signed-in user with their own saved
    keys: the socket is fed by the shared platform connection, so serving it to anyone
    would hand out live data without the own-keys requirement. Crypto (public Delta
    data) is always allowed; the caller checks that. accounts unreachable = not allowed
    (fail closed)."""
    if not settings.require_own_dhan_keys:
        return True
    if user_id is None:
        return False
    try:
        return get_user_dhan_credentials(user_id, raise_on_failure=True) is not None
    except CredentialLookupFailed:
        return False
