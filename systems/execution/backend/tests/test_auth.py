"""Tests for app/auth.py's get_current_user - verifies a JWT issued by
systems/accounts against this service's own JWT_SECRET, entirely locally
(no HTTP call, no DB - see that module's own docstring). Calls the
dependency function directly with a hand-built HTTPAuthorizationCredentials,
bypassing the FastAPI request cycle, same "pure function" testing
convention test_position_manager.py already uses."""

import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app.auth import get_current_user
from app.config import settings


def _token(sub: str, **overrides) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": sub, "email": "trader@example.com", "iat": now, "exp": now + timedelta(hours=1), **overrides}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def _creds(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


def test_get_current_user_accepts_a_valid_token():
    user_id = str(uuid.uuid4())
    user = get_current_user(_creds(_token(user_id)))
    assert str(user.id) == user_id


def test_get_current_user_rejects_missing_credentials():
    with pytest.raises(HTTPException) as exc:
        get_current_user(None)
    assert exc.value.status_code == 401


def test_get_current_user_rejects_expired_token():
    now = datetime.now(timezone.utc)
    expired = jwt.encode(
        {"sub": str(uuid.uuid4()), "email": "trader@example.com", "iat": now - timedelta(hours=2), "exp": now - timedelta(hours=1)},
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )
    with pytest.raises(HTTPException) as exc:
        get_current_user(_creds(expired))
    assert exc.value.status_code == 401


def test_get_current_user_rejects_bad_signature():
    token = jwt.encode(
        {"sub": str(uuid.uuid4()), "exp": datetime.now(timezone.utc) + timedelta(hours=1)}, "wrong-secret", algorithm="HS256"
    )
    with pytest.raises(HTTPException) as exc:
        get_current_user(_creds(token))
    assert exc.value.status_code == 401


def test_get_current_user_rejects_non_uuid_subject():
    with pytest.raises(HTTPException) as exc:
        get_current_user(_creds(_token("not-a-uuid")))
    assert exc.value.status_code == 401
