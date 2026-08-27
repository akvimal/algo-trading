"""Pure unit test for the internal-secret guard on
GET /internal/credentials/{user_id}/dhan - matches this repo's "no
DB-integration test pattern" convention (see test_security.py's own
docstring); the actual decrypt-and-return behavior against a real
BrokerCredentials row is verified live via curl, not pytest."""

import pytest
from fastapi import HTTPException

from app.api.routes.internal import _require_internal_secret
from app.config import settings


def test_require_internal_secret_accepts_the_configured_value():
    _require_internal_secret(settings.internal_service_secret)  # does not raise


def test_require_internal_secret_rejects_wrong_value():
    with pytest.raises(HTTPException) as exc:
        _require_internal_secret("wrong-secret")
    assert exc.value.status_code == 403


def test_require_internal_secret_rejects_missing_header():
    with pytest.raises(HTTPException) as exc:
        _require_internal_secret("")
    assert exc.value.status_code == 403
