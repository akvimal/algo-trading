"""Tests for app/auth.py's get_optional_user_id/require_admin - both
verify a JWT issued by systems/accounts against this service's own
JWT_SECRET, entirely locally (no HTTP call, no DB - see that module's own
docstrings). Calls the dependency functions directly with a hand-built
HTTPAuthorizationCredentials, same "pure function" testing convention
execution/backend/tests/test_auth.py already uses for its own
get_current_user."""

import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app.auth import get_optional_user_id, require_admin
from app.config import settings


def _token(sub: str, **overrides) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": sub, "email": "trader@example.com", "iat": now, "exp": now + timedelta(hours=1), **overrides}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def _creds(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


def test_get_optional_user_id_returns_none_without_credentials():
    assert get_optional_user_id(None) is None


def test_get_optional_user_id_returns_none_for_invalid_token():
    assert get_optional_user_id(_creds("not-a-jwt")) is None


def test_get_optional_user_id_returns_the_user_id_for_a_valid_token():
    user_id = str(uuid.uuid4())
    assert get_optional_user_id(_creds(_token(user_id))) == uuid.UUID(user_id)


def test_require_admin_rejects_missing_credentials():
    with pytest.raises(HTTPException) as exc:
        require_admin(None)
    assert exc.value.status_code == 401


def test_require_admin_rejects_invalid_token():
    with pytest.raises(HTTPException) as exc:
        require_admin(_creds("not-a-jwt"))
    assert exc.value.status_code == 401


def test_require_admin_rejects_a_valid_non_admin_token():
    with pytest.raises(HTTPException) as exc:
        require_admin(_creds(_token(str(uuid.uuid4()), is_admin=False)))
    assert exc.value.status_code == 403


def test_require_admin_rejects_a_token_with_no_is_admin_claim_at_all():
    # A token issued before this feature existed, or before a promotion -
    # see app/auth.py's own docstring on this tradeoff.
    with pytest.raises(HTTPException) as exc:
        require_admin(_creds(_token(str(uuid.uuid4()))))
    assert exc.value.status_code == 403


def test_require_admin_accepts_a_valid_admin_token():
    user_id = str(uuid.uuid4())
    result = require_admin(_creds(_token(user_id, is_admin=True)))
    assert result == uuid.UUID(user_id)
