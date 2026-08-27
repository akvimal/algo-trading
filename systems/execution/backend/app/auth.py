"""Bearer-token auth for this service's routes - verifies a JWT issued by
systems/accounts' POST /auth/login, locally (shared JWT_SECRET, no HTTP
call back to accounts on every request) - see app/config.py's own comment
on that tradeoff.

execution has no accounts.users table of its own (systems/* stay
self-contained, no cross-schema FK) - so unlike accounts' own
get_current_user, this one doesn't look the user up anywhere, it just
decodes the token's claims. A lightweight local User shape (just the id
this service actually needs for row-scoping) stands in for a real
DB-backed model."""

from dataclasses import dataclass
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings

_bearer = HTTPBearer(auto_error=False)


@dataclass
class User:
    id: UUID
    # The raw bearer token itself (not just the decoded id) - Phase 3
    # (BYO Dhan credentials, see docs/architecture.md) forwards this
    # verbatim to market-data on the manual-order/square-off routes, so
    # market-data can independently verify it and resolve THIS user's own
    # Dhan credentials, rather than trusting a bare client-supplied
    # user_id (which would let anyone burn another user's Dhan quota just
    # by guessing a UUID).
    token: str
    # Read straight off the JWT's is_admin claim (accounts' create_access_token
    # already embeds it, market-data's require_admin already reads it) - not
    # looked up anywhere, same stateless design as `id` above. Gates the
    # platform-account routes (app/api/routes/accounts.py) - see require_admin.
    is_admin: bool = False


def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(_bearer)) -> User:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not authenticated")
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token")

    try:
        user_id = UUID(payload["sub"])
    except (KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token payload")

    return User(id=user_id, token=credentials.credentials, is_admin=payload.get("is_admin") is True)


def require_admin(user: User = Depends(get_current_user)) -> User:
    """For the platform-account routes (GET/PUT /accounts/platform*, app/api/
    routes/accounts.py) - the platform operator/broker-config surface, not
    part of the SaaS product. Same 401-then-403 shape as market-data's own
    require_admin, but returns the full User (not a bare UUID) since callers
    here already expect get_current_user's shape."""
    if not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin access required")
    return user
