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

    return User(id=user_id)
