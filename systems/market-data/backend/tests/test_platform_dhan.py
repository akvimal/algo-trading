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


# ---- a replaced token must not linger in the per-person credentials cache -------------------------------------------------------------------


def test_saving_the_renewed_token_clears_that_persons_cached_credentials_so_the_old_token_stops_being_sent(monkeypatch):
    import time
    from types import SimpleNamespace

    owner = uuid4()
    other = uuid4()
    stale = SimpleNamespace(access_token="old.tok.en")
    monkeypatch.setitem(accounts_client._cache, owner, (stale, time.monotonic()))
    monkeypatch.setitem(accounts_client._cache, other, (stale, time.monotonic()))
    resp = SimpleNamespace(ok=True, json=lambda: {"ok": True, "owner_user_id": str(owner)})
    monkeypatch.setattr(accounts_client.requests, "put", lambda *a, **k: resp)
    assert accounts_client.push_platform_dhan("new.tok.en", "1101") is True
    assert owner not in accounts_client._cache and other in accounts_client._cache  # only the owner's entry is dropped


def test_a_failed_save_leaves_the_cache_alone(monkeypatch):
    import time
    from types import SimpleNamespace

    owner = uuid4()
    monkeypatch.setitem(accounts_client._cache, owner, (SimpleNamespace(), time.monotonic()))
    monkeypatch.setattr(accounts_client.requests, "put", lambda *a, **k: SimpleNamespace(ok=False, json=lambda: {}))
    assert accounts_client.push_platform_dhan("t.o.k") is False and owner in accounts_client._cache


# ---- when the renewal happens: in the quiet window after MCX closes, by the token's real age, never in the middle of a scan ----------------------

NIGHT = datetime(2026, 10, 6, 20, 30, tzinfo=timezone.utc)  # 02:00 IST: inside the 00:00-08:30 quiet window
DAY = datetime(2026, 10, 7, 4, 0, tzinfo=timezone.utc)  # 09:30 IST: markets about to be busy, window closed
EVENING = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)  # 17:30 IST: window opens in 6.5 hours


@pytest.fixture
def renewal(monkeypatch):
    monkeypatch.setattr(settings, "dhan_token_renew_interval_hours", 6)
    monkeypatch.setattr(settings, "dhan_renew_window_start", "00:00")
    monkeypatch.setattr(settings, "dhan_renew_window_end", "08:30")
    monkeypatch.setattr(platform_dhan, "_last_failure", None)
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(settings, "dhan_access_token", "")


def with_hours_left(hours, at=NIGHT):
    dhan._renewed_token = tok(hours + (at - NOW).total_seconds() / 3600)


def free(jobs):
    return False


def test_the_quiet_window_is_in_ist_and_reports_when_it_next_opens(renewal):
    assert platform_dhan.quiet_window(NIGHT) == (True, 0.0)
    assert platform_dhan.quiet_window(DAY)[0] is False
    inside, until = platform_dhan.quiet_window(EVENING)
    assert inside is False and until == pytest.approx(6.5)
    assert platform_dhan.quiet_window(datetime(2026, 10, 6, 18, 30, tzinfo=timezone.utc))[0] is True  # 00:00 IST sharp


def test_inside_the_window_a_young_token_is_left_alone(renewal):
    with_hours_left(20)  # 4 hours old
    out = platform_dhan.renewal_state(NIGHT, busy=free)
    assert out["due"] is False and "4.0 hours old" in out["reason"] and "renewed at 6" in out["reason"]


def test_inside_the_window_it_renews_at_the_configured_age_read_from_the_token(renewal):
    with_hours_left(19)  # 5 hours old
    assert platform_dhan.renewal_state(NIGHT, busy=free)["due"] is False
    with_hours_left(18)  # exactly 6
    assert platform_dhan.renewal_state(NIGHT, busy=free)["due"] is True


def test_two_renewals_fit_in_one_night_and_the_token_never_gets_old_enough_to_be_a_problem(renewal):
    # renewed at 00:00 IST -> 24h left; at 06:00 IST it is 6h old -> renewed again; so the token handed to the 09:00 open is under 3 hours old
    t = datetime(2026, 10, 6, 18, 30, tzinfo=timezone.utc)
    with_hours_left(24, at=t)
    assert platform_dhan.renewal_state(t + timedelta(hours=5.5), busy=free)["due"] is False  # 05:30 IST
    dhan._renewed_token = tok(24 + ((t + timedelta(hours=0)) - NOW).total_seconds() / 3600)
    assert platform_dhan.renewal_state(t + timedelta(hours=6), busy=free)["due"] is True  # 06:00 IST


def test_outside_the_window_it_waits_for_it_while_there_is_plenty_of_time(renewal):
    with_hours_left(10, at=EVENING)  # window opens in 6.5h; 10 left -> 3.5h margin
    out = platform_dhan.renewal_state(EVENING, busy=free)
    assert out["due"] is False and out["in_quiet_window"] is False and "waiting for the quiet window" in out["reason"]


def test_outside_the_window_it_renews_only_if_waiting_would_leave_under_two_hours(renewal):
    with_hours_left(8.4, at=EVENING)  # 6.5 + 2 = 8.5 needed
    out = platform_dhan.renewal_state(EVENING, busy=free)
    assert out["due"] is True and "under 2 hours" in out["reason"]
    with_hours_left(8.6, at=EVENING)
    assert platform_dhan.renewal_state(EVENING, busy=free)["due"] is False


def test_a_scan_in_progress_puts_the_renewal_off_while_there_is_time(renewal):
    with_hours_left(8)  # 16 hours old, in the window: due
    seen = []
    out = platform_dhan.renewal_state(NIGHT, busy=lambda jobs: (seen.append(list(jobs)), True)[1])
    assert out["due"] is False and out["deferred"] is True and "a scan is running" in out["reason"]
    assert seen == [["oi-eod-snapshot-record", "equity-screener-snapshot-record", "session-summary-mcx"]]  # the long Dhan jobs


def test_but_with_under_three_hours_left_it_goes_ahead_even_during_a_scan(renewal):
    with_hours_left(2.9)
    assert platform_dhan.renewal_state(NIGHT, busy=lambda jobs: True)["due"] is True
    with_hours_left(3.1)
    assert platform_dhan.renewal_state(NIGHT, busy=lambda jobs: True)["due"] is False


def test_an_expired_or_unreadable_token_is_reported_not_attempted(renewal):
    with_hours_left(-1)
    out = platform_dhan.renewal_state(NIGHT, busy=free)
    assert out["due"] is False and "already expired" in out["reason"] and "Settings page" in out["reason"]
    dhan._renewed_token = "not-a-jwt"
    assert platform_dhan.renewal_state(NIGHT, busy=free) == {"due": False, "reason": "there is no readable token to renew"}


def test_the_age_floor_is_one_hour(renewal, monkeypatch):
    monkeypatch.setattr(settings, "dhan_token_renew_interval_hours", 0)
    with_hours_left(23.5)
    assert platform_dhan.renewal_state(NIGHT, busy=free)["due"] is False
    with_hours_left(22.9)
    assert platform_dhan.renewal_state(NIGHT, busy=free)["due"] is True


def test_a_failed_renewal_is_not_retried_every_ten_minutes_but_is_once_the_token_is_nearly_gone(renewal, state, monkeypatch):
    with_hours_left(8)
    fake_renewal(monkeypatch, None, fail="Dhan rejected the renewal request (401)")
    with pytest.raises(RuntimeError):
        platform_dhan.renew_if_due(NIGHT, busy=free)
    out = platform_dhan.renewal_state(NIGHT + timedelta(minutes=10), busy=free)
    assert out["due"] is False and "last renewal failed" in out["reason"]
    assert platform_dhan.renewal_state(NIGHT + timedelta(minutes=31), busy=free)["due"] is True
    with_hours_left(0.9)
    assert platform_dhan.renewal_state(NIGHT + timedelta(minutes=10), busy=free)["due"] is True


def test_a_successful_renewal_clears_the_failure_memory_and_reports_why_it_ran(renewal, state, monkeypatch):
    with_hours_left(8)
    platform_dhan._last_failure = NIGHT - timedelta(minutes=45)
    fake_renewal(monkeypatch, tok(24, "renewed"))
    out = platform_dhan.renew_if_due(NIGHT, busy=free)
    assert out["renewed"] is True and out["saved_back_to_settings"] is True and "16.0 hours old" in out["reason"]
    assert platform_dhan._last_failure is None


def test_a_check_that_is_not_due_renews_nothing(renewal, state, monkeypatch):
    with_hours_left(22)
    called = []
    monkeypatch.setattr(platform_dhan, "renew_access_token", lambda: called.append(1))
    out = platform_dhan.renew_if_due(NIGHT, busy=free)
    assert out["renewed"] is False and called == [] and state.pushed == []


def test_the_job_log_can_say_whether_a_job_is_running(monkeypatch):
    from app.domain import job_tracker

    store = job_tracker.MemoryStore()
    monkeypatch.setattr(job_tracker, "_store", store)
    assert job_tracker.any_running(["oi-eod-snapshot-record"]) is False
    run_id = store.start("oi-eod-snapshot-record", "OI buildup snapshot")
    assert job_tracker.any_running(["equity-screener-snapshot-record", "oi-eod-snapshot-record"]) is True
    assert job_tracker.any_running(["equity-screener-snapshot-record"]) is False
    store.finish(run_id, "succeeded", None, 1, 1, {})
    assert job_tracker.any_running(["oi-eod-snapshot-record"]) is False


def test_if_the_job_log_cannot_be_read_the_renewal_is_not_held_up(monkeypatch):
    from app.domain import job_tracker

    class Broken(job_tracker.MemoryStore):
        def any_running(self, ids):
            raise RuntimeError("db down")

    monkeypatch.setattr(job_tracker, "_store", Broken())
    assert job_tracker.any_running(["oi-eod-snapshot-record"]) is False
    monkeypatch.setattr(job_tracker, "_store", None)
    assert job_tracker.any_running(["oi-eod-snapshot-record"]) is False


def test_the_renewal_is_checked_every_ten_minutes_and_the_defaults_are_a_six_hour_age_in_a_midnight_window():
    src = inspect.getsource(scheduler.start_scheduler)
    assert re.search(r"_renew_dhan_token,\s*IntervalTrigger\(minutes=10\)", src)
    from app.config import Settings

    f = Settings.model_fields
    assert f["dhan_token_renew_interval_hours"].default == 6
    assert (f["dhan_renew_window_start"].default, f["dhan_renew_window_end"].default) == ("00:00", "08:30")


def test_forgetting_my_credentials_drops_only_the_callers_cached_keys():
    from uuid import uuid4

    me, other = uuid4(), uuid4()
    accounts_client._cache[me] = ("old", 1.0)
    accounts_client._cache[other] = ("theirs", 1.0)
    try:
        assert dhan_routes.forget_my_credentials(user_id=me) == {"forgotten": True}
        assert me not in accounts_client._cache and other in accounts_client._cache
    finally:
        accounts_client._cache.pop(other, None)


def test_the_forget_route_needs_a_signed_in_user():
    route = next(r for r in dhan_routes.router.routes if r.path == "/dhan/forget-my-credentials")
    assert "POST" in route.methods
    assert any(d.call is require_user_id_dep() for d in route.dependant.dependencies)


def require_user_id_dep():
    from app.auth import require_user_id

    return require_user_id
