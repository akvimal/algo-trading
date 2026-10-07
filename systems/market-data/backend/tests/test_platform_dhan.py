"""The platform's Dhan token has ONE source: the operator's saved Settings keys (app/providers/platform_dhan.py). Covered here: when a saved token
is adopted, that a renewal saves the new token back, that the routes that change the credentials need an admin (or the internal secret), and that
the periodic sync is always scheduled. The token itself is never returned."""

import base64
import inspect
import json
import re
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import jwt as pyjwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app import scheduler
from app.adapters import accounts_client
from app.api.routes import dhan as dhan_routes
from app.auth import require_operator
from app.config import settings
from app.providers import dhan, platform_dhan

NOW = datetime(2026, 10, 7, 4, 0, tzinfo=timezone.utc)


def tok(hours_from_now: float, tag: str = "a") -> str:
    """A token shaped like Dhan's: a JWT with an `exp` claim (the signature is never checked)."""
    def b64(d):
        return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")

    return f"{b64({'alg': 'none'})}.{b64({'exp': int((NOW + timedelta(hours=hours_from_now)).timestamp()), 't': tag})}.sig"


@pytest.fixture
def state(monkeypatch):
    """The in-memory token the platform uses, a fake accounts service, and a capture of what gets saved where."""
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(dhan, "_last_renewal_response", None)
    monkeypatch.setattr(settings, "dhan_access_token", "")
    monkeypatch.setattr(settings, "dhan_client_id", "1101")
    monkeypatch.setattr(settings, "platform_dhan_from_accounts", True)
    s = type("S", (), {})()
    s.saved = {"has_dhan": False}  # what accounts says the owner has saved; None = accounts is down
    s.pushed, s.push_ok, s.persisted = [], True, []
    monkeypatch.setattr(accounts_client, "fetch_platform_dhan", lambda: s.saved)
    monkeypatch.setattr(accounts_client, "push_platform_dhan", lambda token, client_id=None: (s.pushed.append((token, client_id)), s.push_ok)[1])
    monkeypatch.setattr(dhan, "_persist_credentials", lambda client_id, token: s.persisted.append((client_id, token)))
    return s


def saved(token, client_id="1101"):
    return {"has_dhan": True, "owner_user_id": str(uuid4()), "dhan_client_id": client_id, "dhan_access_token": token}


def use(token):
    dhan._renewed_token = token


# ---- when the saved token is adopted ---------------------------------------------------------------------------------------------------


def test_a_saved_token_is_adopted_when_the_platform_has_none(state):
    state.saved = saved(tok(20))
    out = platform_dhan.refresh_from_accounts(NOW)
    assert out["adopted"] is True and dhan.current_access_token() == state.saved["dhan_access_token"]
    assert state.persisted and state.persisted[0][1] == state.saved["dhan_access_token"]  # and kept on the volume for the next restart


def test_a_saved_token_is_adopted_when_the_one_in_use_has_expired_the_vps_case(state):
    use(tok(-120, "old"))  # expired days ago: the token that broke the background jobs
    state.saved = saved(tok(22, "new"))
    assert platform_dhan.refresh_from_accounts(NOW)["adopted"] is True
    assert dhan.current_access_token() == state.saved["dhan_access_token"]


def test_a_saved_token_that_outlives_the_one_in_use_replaces_it(state):
    use(tok(2, "soon"))
    state.saved = saved(tok(23, "fresh"))
    assert platform_dhan.refresh_from_accounts(NOW)["adopted"] is True


def test_a_saved_token_that_does_not_outlive_the_one_in_use_is_left_alone(state):
    mine = tok(20, "renewed")
    use(mine)
    state.saved = saved(tok(5, "older"))
    out = platform_dhan.refresh_from_accounts(NOW)
    assert out["adopted"] is False and "as long or longer" in out["reason"] and dhan.current_access_token() == mine


def test_a_saved_token_that_has_already_expired_is_never_adopted(state):
    use(tok(-1, "dead"))
    state.saved = saved(tok(-1, "alsodead"))
    out = platform_dhan.refresh_from_accounts(NOW)
    assert out["adopted"] is False and "expired" in out["reason"] and state.persisted == []


def test_the_same_token_is_a_no_op(state):
    t = tok(10)
    use(t)
    state.saved = saved(t)
    assert platform_dhan.refresh_from_accounts(NOW)["adopted"] is False and state.persisted == []


def test_a_token_that_is_not_a_jwt_is_adopted_only_when_nothing_valid_is_in_use(state):
    state.saved = saved("opaque-token")
    assert platform_dhan.refresh_from_accounts(NOW)["adopted"] is True  # nothing in use: better than nothing
    use(tok(10))
    state.saved = saved("another-opaque-token")
    assert platform_dhan.refresh_from_accounts(NOW)["adopted"] is False  # cannot tell it is fresher than a valid one


def test_nothing_changes_when_nothing_is_saved_or_accounts_is_down_or_the_feature_is_off(state, monkeypatch):
    use(tok(5, "mine"))
    before = dhan.current_access_token()
    state.saved = {"has_dhan": False}
    assert "no Dhan token saved" in platform_dhan.refresh_from_accounts(NOW)["reason"]
    state.saved = None
    assert "could not be reached" in platform_dhan.refresh_from_accounts(NOW)["reason"]
    monkeypatch.setattr(settings, "platform_dhan_from_accounts", False)
    state.saved = saved(tok(23))
    assert "switched off" in platform_dhan.refresh_from_accounts(NOW)["reason"]
    assert dhan.current_access_token() == before and state.persisted == []


def test_the_token_is_never_in_what_refresh_returns(state):
    t = tok(20, "secret-marker")
    state.saved = saved(t)
    out = platform_dhan.refresh_from_accounts(NOW)
    assert t not in json.dumps(out) and "secret-marker" not in json.dumps(out)


# ---- renewing, and saving the renewed token back (one source) ----------------------------------------------------------------------------


def fake_renewal(monkeypatch, new_token, fail=None):
    def renew():
        if fail:
            raise RuntimeError(fail)
        dhan._renewed_token = new_token
        return {"token": new_token, "expiryTime": "2026-10-08T09:00:00"}

    monkeypatch.setattr(platform_dhan, "renew_access_token", renew)


def test_a_renewal_saves_the_new_token_back_so_settings_holds_the_live_one(state, monkeypatch):
    use(tok(3, "old"))
    new = tok(24, "renewed")
    fake_renewal(monkeypatch, new)
    out = platform_dhan.renew_platform_token()
    assert out == {"renewed": True, "adopted_saved_token": False, "saved_back_to_settings": True, "expiry_time": "2026-10-08T09:00:00"}
    assert state.pushed == [(new, "1101")]
    assert new not in json.dumps(out)  # the new token is not handed back to the caller


def test_a_fresher_saved_token_is_adopted_before_the_renewal_so_it_is_what_gets_renewed(state, monkeypatch):
    use(tok(-80, "dead"))
    state.saved = saved(tok(22, "saved-in-settings"))
    seen = {}
    monkeypatch.setattr(platform_dhan, "renew_access_token", lambda: (seen.update(token=dhan.current_access_token()), setattr(dhan, "_renewed_token", tok(24, "after")), {"token": "x"})[2])
    out = platform_dhan.renew_platform_token()
    assert seen["token"] == state.saved["dhan_access_token"] and out["adopted_saved_token"] is True


def test_a_renewal_that_dhan_refuses_raises_and_saves_nothing(state, monkeypatch):
    use(tok(-5))
    fake_renewal(monkeypatch, None, fail="Dhan rejected the renewal request (401)")
    with pytest.raises(RuntimeError, match="401"):
        platform_dhan.renew_platform_token()
    assert state.pushed == []


def test_a_renewal_whose_token_could_not_be_saved_back_says_so(state, monkeypatch):
    use(tok(3))
    fake_renewal(monkeypatch, tok(24, "n"))
    state.push_ok = False
    assert platform_dhan.renew_platform_token()["saved_back_to_settings"] is False


def test_with_the_feature_off_a_renewal_saves_nothing_back(state, monkeypatch):
    monkeypatch.setattr(settings, "platform_dhan_from_accounts", False)
    use(tok(3))
    fake_renewal(monkeypatch, tok(24, "n"))
    out = platform_dhan.renew_platform_token()
    assert out["saved_back_to_settings"] is False and state.pushed == []


def test_setting_the_token_by_hand_makes_it_the_one_in_use_and_saves_it_as_the_owners(state):
    new = tok(24, "typed")
    assert platform_dhan.set_platform_credentials("2202", new) == {"saved_to_settings": True}
    assert dhan.current_access_token() == new and settings.dhan_client_id == "2202" and state.pushed == [(new, "2202")]


# ---- who may change the platform's credentials -----------------------------------------------------------------------------------------------


def bearer(is_admin: bool):
    t = pyjwt.encode({"sub": str(uuid4()), "is_admin": is_admin, "exp": int((datetime.now(timezone.utc) + timedelta(minutes=5)).timestamp())}, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=t)


def test_an_admin_login_is_an_operator_a_plain_user_and_a_stranger_are_not():
    assert require_operator(bearer(True), None) is not None
    with pytest.raises(HTTPException) as e:
        require_operator(bearer(False), None)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        require_operator(None, None)
    assert e.value.status_code == 401


def test_the_internal_secret_is_an_operator_too_and_a_wrong_one_is_not(monkeypatch):
    monkeypatch.setattr(settings, "internal_service_secret", "a-real-secret-value-123")
    assert require_operator(None, "a-real-secret-value-123") is None
    with pytest.raises(HTTPException) as e:
        require_operator(None, "wrong")
    assert e.value.status_code == 401
    monkeypatch.setattr(settings, "internal_service_secret", "")
    with pytest.raises(HTTPException):
        require_operator(None, "")  # an empty configured secret never matches an empty header


def test_every_route_that_can_change_the_platforms_credentials_needs_an_operator_and_the_read_only_ones_stay_open():
    by_path = {(r.path, m): r for r in dhan_routes.router.routes for m in r.methods}
    gated = [("/dhan/credentials", "PUT"), ("/dhan/renew-token", "POST"), ("/dhan/refresh", "POST"), ("/dhan/feed/subscribe", "POST")]
    for key in gated:
        assert any(d.call is require_operator for d in by_path[key].dependant.dependencies), key
    for key in [("/dhan/token-status", "GET"), ("/dhan/token-expiry", "GET"), ("/dhan/feed-status", "GET")]:
        assert not any(d.call is require_operator for d in by_path[key].dependant.dependencies), key


def test_the_credentials_route_returns_status_without_the_token(state):
    new = tok(24, "typed-secret")
    out = dhan_routes.update_credentials(type("P", (), {"client_id": "1101", "access_token": new})())
    assert out["saved_to_settings"] is True and out["has_access_token"] is True and new not in json.dumps(out)


def test_the_renew_route_turns_a_refusal_into_a_502_and_never_returns_the_token(state, monkeypatch):
    use(tok(3))
    fake_renewal(monkeypatch, tok(24, "renewed-secret"))
    out = dhan_routes.renew_token()
    assert out["renewed"] is True and "renewed-secret" not in json.dumps(out)
    fake_renewal(monkeypatch, None, fail="Dhan rejected the renewal request (401)")
    with pytest.raises(HTTPException) as e:
        dhan_routes.renew_token()
    assert e.value.status_code == 502


# ---- the schedule ---------------------------------------------------------------------------------------------------------------------------


def test_the_saved_token_is_checked_every_few_minutes_and_once_at_start_even_when_renewal_is_off():
    src = inspect.getsource(scheduler.start_scheduler)
    gate = src.index("if settings.dhan_token_renew_interval_hours > 0")
    # the sync job is added at the function's own indentation (4 spaces), so outside the renewal "if", which is why renewal being off leaves it on
    sync = re.search(r"\n    _scheduler\.add_job\(\n        _sync_platform_dhan,\n        IntervalTrigger\(minutes=settings\.platform_dhan_sync_minutes\)", src)
    assert sync is not None and sync.start() > gate
    assert 'id="dhan-token-sync-initial"' in src
