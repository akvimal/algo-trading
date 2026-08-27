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
from fastapi import Depends
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
