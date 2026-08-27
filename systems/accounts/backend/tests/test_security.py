"""Pure unit tests for app/domain/security.py - no DB, no FastAPI, matching
this repo's existing convention of testing domain logic against plain
Python rather than through a route + real Postgres (see e.g. execution's
test_position_manager.py, which uses fake dataclasses instead of a DB
fixture - there is no DB-integration test pattern anywhere in this repo
to follow, so signup/login/credentials route round-trips are verified via
docker + curl instead, not pytest - see the accounts service's own README
or docs/architecture.md for that verification."""

import jwt
import pytest

from app.domain.security import (
    create_access_token,
    decode_access_token,
    decrypt_secret,
    encrypt_secret,
    hash_password,
    try_decrypt_secret,
    verify_password,
)


def test_hash_password_is_not_plaintext():
    hashed = hash_password("correct horse battery staple")
    assert hashed != "correct horse battery staple"
    assert hashed.startswith("$2b$")  # bcrypt's own format prefix


def test_verify_password_round_trip():
    hashed = hash_password("hunter22")
    assert verify_password("hunter22", hashed) is True
    assert verify_password("wrong-password", hashed) is False


def test_access_token_round_trip():
    token = create_access_token(user_id="abc-123", email="trader@example.com")
    payload = jwt.decode(token, options={"verify_signature": False})
    assert payload["sub"] == "abc-123"
    assert payload["email"] == "trader@example.com"
    assert payload["exp"] > payload["iat"]


def test_access_token_rejects_tampered_signature():
    token = create_access_token(user_id="abc-123", email="trader@example.com")
    tampered = token[:-1] + ("A" if token[-1] != "A" else "B")
    with pytest.raises(jwt.PyJWTError):
        decode_access_token(tampered)


def test_encrypt_secret_round_trip():
    ciphertext = encrypt_secret("dhan-access-token-value")
    assert ciphertext != "dhan-access-token-value"
    assert decrypt_secret(ciphertext) == "dhan-access-token-value"


def test_try_decrypt_secret_returns_none_on_garbage():
    assert try_decrypt_secret("not-a-real-fernet-token") is None
