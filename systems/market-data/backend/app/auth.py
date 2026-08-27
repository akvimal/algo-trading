"""Optional per-request caller identity for BYO Dhan credentials (Phase 3
of the manual-trading SaaS, see docs/architecture.md) - mirrors
execution/app/auth.py's local JWT decode against the same shared
JWT_SECRET, but NEVER raises: most routes in this service must keep
serving unauthenticated callers exactly as before this phase (the
"additive, not breaking" scope decision) - a missing, malformed, or
expired token simply means "no BYO credentials for this request", not a
401."""

from typing import Optional
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings

_bearer = HTTPBearer(auto_error=False)


def get_optional_user_id(credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> Optional[UUID]:
    if credentials is None:
        return None
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        return UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None


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
