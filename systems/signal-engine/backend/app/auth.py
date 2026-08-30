"""Optional per-request caller identity, for Strategy ownership attribution
(2026-08-30 - see StrategyOut.created_by) - mirrors market-data's own
app/auth.py's get_optional_user_id against the same shared JWT_SECRET, but
NEVER raises: this service enforces no auth of its own on any route (every
route here has always been open, that's unchanged by this file) - a
missing, malformed, or expired token simply means "attribute this Strategy
to no one", not a 401."""

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
