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
from datetime import datetime, time, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from app.adapters import accounts_client
from app.domain import job_tracker
from app.config import settings
from app.providers.dhan import _decode_jwt_exp, current_access_token, renew_access_token, set_manual_credentials

logger = logging.getLogger(__name__)

_lock = threading.Lock()

TOKEN_LIFETIME_HOURS = 24.0  # a Dhan access token lives 24 hours (its own `exp` claim says exactly when)
URGENT_HOURS = 3.0  # with less than this left a renewal goes ahead even while a scan runs: a dead token cannot be renewed at all
SAFETY_HOURS = 2.0  # outside the quiet window, renew when the token would have less than this left at the moment the window opens
RETRY_AFTER_FAILURE_MINUTES = 30
# Jobs that call Dhan thousands of times over many minutes. Dhan's renewal REPLACES the token, so a renewal in the middle of one of these
# can fail the calls that were in flight; they are given the room to finish.
HEAVY_JOBS = ["oi-eod-snapshot-record", "equity-screener-snapshot-record", "session-summary-mcx"]

_last_failure: Optional[datetime] = None


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


def _hhmm(text: str) -> time:
    h, m = text.split(":")
    return time(int(h), int(m))


def quiet_window(now: datetime) -> tuple[bool, float]:
    """(inside the quiet window now?, hours until it next opens: 0 when inside). The window is in IST, between MCX's close and the morning open;
    it may not wrap past midnight in the config, but a window that starts at 00:00 is the usual case."""
    tz = ZoneInfo(settings.timezone)
    local = now.astimezone(tz)
    start, end = _hhmm(settings.dhan_renew_window_start), _hhmm(settings.dhan_renew_window_end)
    t = local.timetz().replace(tzinfo=None)
    inside = (start <= t < end) if start < end else (t >= start or t < end)
    if inside:
        return True, 0.0
    opens = local.replace(hour=start.hour, minute=start.minute, second=0, microsecond=0)
    if opens <= local:
        opens += timedelta(days=1)
    return False, (opens - local).total_seconds() / 3600


def renewal_state(now: Optional[datetime] = None, busy=None) -> dict:
    """Should the token be renewed now? Dhan's renewal REPLACES the token and both NSE and MCX use it, so it is done in a quiet window (after MCX
    closes, before the morning open), not on a timer that lands anywhere:

      * inside the window: when the token is at least DHAN_TOKEN_RENEW_INTERVAL_HOURS old (read from the token's own expiry; it lives 24 hours);
      * outside it: only when the token would have under SAFETY_HOURS left by the time the window opens (after downtime, say), since waiting would
        let it expire;
      * never in the middle of an OI or screener scan unless under URGENT_HOURS remain (a dead token cannot be renewed at all);
      * after a failure, not again for RETRY_AFTER_FAILURE_MINUTES unless under an hour is left.

    A token that has already expired cannot be renewed (Dhan refuses), so it is reported, not attempted."""
    now = now or _now()
    token = current_access_token()
    exp = _decode_jwt_exp(token) if token else None
    if exp is None:
        return {"due": False, "reason": "there is no readable token to renew"}
    remaining = (exp - now).total_seconds() / 3600
    if remaining <= 0:
        return {"due": False, "reason": "the token has already expired and cannot be renewed: save a fresh one on the Settings page", "remaining_hours": round(remaining, 2)}
    age = TOKEN_LIFETIME_HOURS - remaining
    min_age = max(1.0, float(settings.dhan_token_renew_interval_hours))
    inside, until_open = quiet_window(now)
    base = {"remaining_hours": round(remaining, 2), "in_quiet_window": inside}
    if inside:
        if age < min_age:
            return {"due": False, "reason": f"the token is {age:.1f} hours old; inside the quiet window it is renewed at {min_age:g}", **base}
        why = f"the token is {age:.1f} hours old and it is the quiet window"
    else:
        if remaining >= until_open + SAFETY_HOURS:
            return {"due": False, "reason": f"waiting for the quiet window, which opens in {until_open:.1f} hours (the token has {remaining:.1f} left)", **base}
        why = f"the token would have under {SAFETY_HOURS:g} hours left when the quiet window opens in {until_open:.1f} hours"
    if _last_failure is not None and (now - _last_failure).total_seconds() < RETRY_AFTER_FAILURE_MINUTES * 60 and remaining > 1.0:
        return {"due": False, "reason": f"the last renewal failed; trying again {RETRY_AFTER_FAILURE_MINUTES} minutes after it", **base}
    is_busy = busy if busy is not None else job_tracker.any_running
    if remaining > URGENT_HOURS and is_busy(HEAVY_JOBS):
        return {"due": False, "deferred": True, "reason": f"a scan is running, so the renewal waits for it ({remaining:.1f} hours left)", **base}
    return {"due": True, "reason": why, **base}


def renew_if_due(now: Optional[datetime] = None, busy=None) -> dict:
    """The scheduled renewal: renew when `renewal_state` says so, remember a failure so it is not retried every few minutes, and otherwise
    say why not. Raises RuntimeError when Dhan refuses (as `renew_platform_token` does)."""
    global _last_failure
    state = renewal_state(now, busy)
    if not state["due"]:
        return {"renewed": False, **state}
    try:
        out = renew_platform_token()
    except RuntimeError:
        _last_failure = now or _now()
        raise
    _last_failure = None
    return {**out, **{k: v for k, v in state.items() if k != "due"}}
