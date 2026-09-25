"""HTTP client for the accounts service - only what the live-trading gate
needs: whether the CALLER has saved Dhan broker credentials.

Uses the caller's own bearer token against accounts' GET /credentials, which
returns presence flags only (`has_dhan`, ...) and never the secrets, so
execution never has to hold anyone's broker token just to know it exists. The
shared-secret /internal/credentials routes are deliberately NOT used here:
they return the decrypted credential itself."""

import logging
from typing import Optional

import requests

from app.config import settings

logger = logging.getLogger(__name__)


def user_has_dhan_credentials(token: str) -> Optional[bool]:
    """True/False from accounts, or None when it could not be determined
    (accounts unreachable, timeout, unexpected response). Callers must treat
    None as "not verified", not as "has credentials"."""
    if not token:
        return None
    try:
        resp = requests.get(
            f"{settings.accounts_base_url}/credentials",
            headers={"Authorization": f"Bearer {token}"},
            timeout=5,
        )
        resp.raise_for_status()
        return bool(resp.json().get("has_dhan"))
    except (requests.RequestException, ValueError):
        logger.exception("live-trading gate: could not check Dhan credentials with the accounts service")
        return None
