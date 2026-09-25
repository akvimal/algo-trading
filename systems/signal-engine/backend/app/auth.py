"""Caller identity for signal-engine's routes.

Two layers, kept separate on purpose:

- `get_optional_user_id` (2026-08-30, Strategy ownership attribution) never
  raises - a missing, malformed or expired token simply means "attribute
  this to no one". Still used by routes that only want attribution.
- `get_caller` (login + per-user ownership) is what the core routes use. It
  decodes the same bearer token (same shared JWT_SECRET as accounts /
  execution / market-data) into a `Caller`, and raises 401 only when
  `settings.require_auth` is on. With the flag off it never raises, so
  turning this code on changes nothing until the flag is flipped.

`is_admin` is read from the JWT claim, so a demotion or promotion only takes
effect at the user's next login (same tradeoff accounts / execution already
accept)."""

from dataclasses import dataclass
from typing import Optional
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings

_bearer = HTTPBearer(auto_error=False)


def _decode(credentials: Optional[HTTPAuthorizationCredentials]) -> tuple[Optional[UUID], bool]:
    """(user_id, is_admin) from a bearer token, or (None, False) for a
    missing / malformed / expired / wrongly-signed one."""
    if credentials is None:
        return None, False
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        return UUID(payload["sub"]), bool(payload.get("is_admin", False))
    except (jwt.PyJWTError, KeyError, ValueError, TypeError):
        return None, False


def get_optional_user_id(credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> Optional[UUID]:
    return _decode(credentials)[0]


@dataclass(frozen=True)
class Caller:
    """Who is calling, and whether their view of the data is restricted.

    `enforced` mirrors settings.require_auth at request time. `scope_user_id`
    is the one thing route code needs: None means "unrestricted" (auth is not
    enforced, or the caller is an admin), a UUID means "only rows created by
    this user"."""

    user_id: Optional[UUID]
    is_admin: bool
    enforced: bool

    @property
    def scope_user_id(self) -> Optional[UUID]:
        if not self.enforced or self.is_admin:
            return None
        return self.user_id


def get_caller(credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> Caller:
    user_id, is_admin = _decode(credentials)
    if settings.require_auth and user_id is None:
        raise HTTPException(
            status_code=401,
            detail="authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return Caller(user_id=user_id, is_admin=is_admin, enforced=settings.require_auth)
