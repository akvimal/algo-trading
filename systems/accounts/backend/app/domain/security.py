"""Password hashing, JWT issuance/verification, and at-rest encryption for
broker credentials. Pure functions wherever possible (no DB/FastAPI
imports) so they're unit-testable in isolation - see tests/test_security.py.
"""

import base64
import hashlib
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from cryptography.fernet import Fernet, InvalidToken

from app.config import settings

# --- Passwords ---


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


# --- JWT ---


def create_access_token(user_id: str, email: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "email": email,
        "iat": now,
        "exp": now + timedelta(minutes=settings.jwt_expiry_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    """Raises jwt.PyJWTError (expired/malformed/bad signature) on failure -
    callers (app/auth.py's get_current_user) turn that into a 401."""
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])


# --- Credential encryption at rest ---
#
# CREDENTIALS_ENCRYPTION_KEY can be any secret string, not a pre-formatted
# Fernet key - SHA-256 it down to 32 bytes and base64-urlsafe-encode that,
# so operators don't need to run `Fernet.generate_key()` themselves and
# there's no "wrong length/format" failure mode for a hand-typed env var.


def _fernet() -> Fernet:
    digest = hashlib.sha256(settings.credentials_encryption_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_secret(ciphertext: str) -> str:
    return _fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")


def try_decrypt_secret(ciphertext: str) -> Optional[str]:
    """Same as decrypt_secret but None on failure instead of raising - for
    a masked-display path that must never 500 just because the key rotated
    out from under an old row (see CredentialsOut.dhan_client_id_masked's
    own reasoning - though that field doesn't itself go through this,
    future callers reading the encrypted fields for display should)."""
    try:
        return decrypt_secret(ciphertext)
    except InvalidToken:
        return None
