"""The platform's Dhan token has ONE source: the operator's own saved Dhan keys in the accounts service (what the Settings page saves).

Before this, market-data's background jobs, shared price feed and option-chain reads used a token of their own (a file on a volume, seeded from
.env) that nothing connected to the Settings page: a token saved there never reached the jobs, and because Dhan's renewal REPLACES a token, a
renewal of either copy invalidated the other. Now:

  * `refresh_from_accounts` (every few minutes, and when asked) adopts the operator's saved token when it outlives the one in use, or when the
    one in use is missing or expired. A token that is saved but already expired is never adopted.
  * `renew_platform_token` adopts any fresher saved token first, renews it with Dhan, and WRITES THE NEW TOKEN BACK to the account, so the
    Settings copy stays the live one and there is no second copy to go stale.
  * `set_platform_credentials` (the operator's "set the token" action) stores it in both places the same way.

If accounts cannot be reached nothing changes: the token in use (and its saved file) keeps working, and the next pass tries again. The credentials
are never returned or logged here. Only the expiry and what was done are."""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from typing import Optional

from app.adapters import accounts_client
from app.config import settings
from app.providers.dhan import _decode_jwt_exp, current_access_token, renew_access_token, set_manual_credentials

logger = logging.getLogger(__name__)

_lock = threading.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def refresh_from_accounts(now: Optional[datetime] = None) -> dict:
    """Adopt the platform owner's saved Dhan token if it is better than the one in use. Returns what was decided (never the token itself)."""
    if not settings.platform_dhan_from_accounts:
        return {"adopted": False, "reason": "reading the token from Settings is switched off (PLATFORM_DHAN_FROM_ACCOUNTS)"}
    now = now or _now()
    with _lock:
        data = accounts_client.fetch_platform_dhan()
        if data is None:
            return {"adopted": False, "reason": "the accounts service could not be reached"}
        if not data.get("has_dhan"):
            return {"adopted": False, "reason": "the platform owner has no Dhan token saved in Settings"}
        token, client_id = data["dhan_access_token"], data["dhan_client_id"]
        current = current_access_token()
        if token == current:
            return {"adopted": False, "reason": "the token in use is already the one saved in Settings"}
        new_exp = _decode_jwt_exp(token)
        cur_exp = _decode_jwt_exp(current) if current else None
        if new_exp is not None and new_exp <= now:
            return {"adopted": False, "reason": "the token saved in Settings has already expired", "expires_at": new_exp.isoformat()}
        if cur_exp is not None and cur_exp > now and (new_exp is None or new_exp <= cur_exp):
            return {"adopted": False, "reason": "the token in use lasts as long or longer", "expires_at": cur_exp.isoformat()}
        set_manual_credentials(client_id, token)
        logger.info("platform Dhan token: adopted the one saved in Settings (expires %s)", new_exp)
        return {"adopted": True, "reason": "now using the token saved in Settings", "expires_at": new_exp.isoformat() if new_exp else None}


def _write_back(token: str) -> bool:
    """Put the token the platform now holds into the owner's saved credentials, so Settings shows (and keeps) the live one."""
    if not settings.platform_dhan_from_accounts:
        return False
    return accounts_client.push_platform_dhan(token, settings.dhan_client_id)


def renew_platform_token() -> dict:
    """Adopt a fresher saved token, renew with Dhan (RuntimeError if Dhan refuses), and save the renewed token back to the account."""
    adopted = refresh_from_accounts()
    data = renew_access_token()
    written = _write_back(current_access_token())
    if settings.platform_dhan_from_accounts and not written:
        logger.warning("platform Dhan token renewed, but could not be saved back to the account: the Settings copy is now stale")
    return {"renewed": True, "adopted_saved_token": adopted.get("adopted", False), "saved_back_to_settings": written, "expiry_time": data.get("expiryTime")}


def set_platform_credentials(client_id: str, access_token: str) -> dict:
    """The operator sets the token: it becomes the one in use (and is saved on the volume) and is stored as the owner's saved token."""
    set_manual_credentials(client_id, access_token)
    return {"saved_to_settings": _write_back(access_token)}
