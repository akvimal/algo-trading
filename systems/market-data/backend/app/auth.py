"""Optional per-request caller identity for BYO Dhan credentials (Phase 3
of the manual-trading SaaS, see docs/architecture.md) - mirrors
execution/app/auth.py's local JWT decode against the same shared
JWT_SECRET, but NEVER raises: most routes in this service must keep
serving unauthenticated callers exactly as before this phase (the
"additive, not breaking" scope decision) - a missing, malformed, or
expired token simply means "no BYO credentials for this request", not a
401."""

import hmac
from dataclasses import dataclass
from typing import Optional
from uuid import UUID

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings

_bearer = HTTPBearer(auto_error=False)


def user_id_from_token(token: Optional[str]) -> Optional[UUID]:
    """The user id in a bearer token, or None for a missing/malformed/expired one.
    Never raises. Shared by get_optional_user_id and the quote WebSocket (a browser
    cannot send an Authorization header on a WebSocket handshake, so it passes ?token=)."""
    if not token:
        return None
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        return UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None


def get_optional_user_id(credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> Optional[UUID]:
    return user_id_from_token(credentials.credentials) if credentials is not None else None


@dataclass(frozen=True)
class Caller:
    """Who is asking for market data, for the own-keys policy (app/data_access.py).

    user_id           from a valid bearer token (a signed-in person), else None.
    trusted_service   the request presented INTERNAL_SERVICE_SECRET, i.e. it is one of
                      our own backends (execution, signal-engine), not a browser.
    on_behalf_of      a user a TRUSTED service is fetching data for, so the request
                      runs on THAT user's own keys/rate budget. Ignored unless trusted.
    """

    user_id: Optional[UUID] = None
    trusted_service: bool = False
    on_behalf_of: Optional[UUID] = None


def get_caller(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
    x_internal_secret: Optional[str] = Header(default=None),
    x_on_behalf_of: Optional[str] = Header(default=None),
) -> Caller:
    """Never raises for a missing/bad token (same additive contract as get_optional_user_id),
    but a malformed X-On-Behalf-Of from a trusted service is a 400 rather than silently
    becoming a platform-credential request."""
    user_id = get_optional_user_id(credentials)
    secret = settings.internal_service_secret
    trusted = bool(secret) and bool(x_internal_secret) and hmac.compare_digest(x_internal_secret.encode(), secret.encode())
    on_behalf_of: Optional[UUID] = None
    if trusted and x_on_behalf_of:
        try:
            on_behalf_of = UUID(x_on_behalf_of)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid X-On-Behalf-Of")
    return Caller(user_id=user_id, trusted_service=trusted, on_behalf_of=on_behalf_of)


def require_user_id(credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> UUID:
    """Like require_admin below, but without the is_admin check - for the
    live-broker-adapter's order-placement routes (app/api/routes/dhan.py),
    which unlike every other route in this service (optional auth, falls
    back to the platform-default Dhan credential) must have a real,
    specific person attached to every real order placed. No fallback to
    an anonymous/platform-wide credential is acceptable here - see
    accounts_client.get_user_dhan_credentials_strict, which this pairs
    with."""
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not authenticated")
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        return UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token")


@dataclass(frozen=True)
class User:
    user_id: UUID
    is_admin: bool


def require_user(credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> User:
    """A signed-in person, with their admin flag (read straight off the token, like require_admin). Raises 401 without one."""
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not authenticated")
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        return User(user_id=UUID(payload["sub"]), is_admin=payload.get("is_admin") is True)
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token")


def require_admin(credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> UUID:
    """Unlike get_optional_user_id above, this DOES raise - for the Dhan
    platform-credentials/renew-token/feed-status routes (app/api/routes/
    dhan.py), which are the platform operator's own ops surface, not part
    of the SaaS product (see docs/architecture.md § "Manual Trading SaaS").
    Reads the is_admin claim straight off the already-decoded JWT (no call
    back to accounts - same stateless design get_optional_user_id already
    uses) - accounts embeds it at login/signup time, see that service's
    create_access_token."""
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not authenticated")
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        user_id = UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token")
    if payload.get("is_admin") is not True:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin access required")
    return user_id


def require_operator(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
    x_internal_secret: Optional[str] = Header(default=None),
) -> Optional[UUID]:
    """For the platform's Dhan token routes: a signed-in admin, OR a caller holding the internal service secret (the ops script inside the
    container, which has no browser login). Anyone else is refused. These routes can replace the platform's data credentials, so they must never
    be open to the internet."""
    secret = settings.internal_service_secret
    if secret and x_internal_secret and hmac.compare_digest(x_internal_secret.encode(), secret.encode()):
        return None
    return require_admin(credentials)
