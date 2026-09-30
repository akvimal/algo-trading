"""Login + per-user ownership on signal-engine's core routes
(app/auth.py's get_caller, app/ownership.py, settings.require_auth).

Same "plain fakes, call the route function directly" convention as the rest
of this backend (there is no real-DB test layer), plus TestClient for the
one thing that needs the real app wiring: that an anonymous request gets a
401 when enforcement is on and the provider webhooks stay open.

What is asserted, mirroring the design (docs/redesign-rollout-plan.md,
Phase 0):
- flag OFF: nothing is restricted, but a caller with a valid token still gets
  new rows attributed to them (ownership accumulates ahead of the flip);
- flag ON: no/invalid token -> 401; a non-admin sees only their own rows;
  admins see everything; NULL-owner (legacy/platform) rows are admin-only;
  someone else's row is a 404 (existence not disclosed), never a 403.
"""

import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.adapters.db import models as db_models
from app.api.routes import indicators as indicators_route
from app.api.routes import saved_backtests as saved_backtests_route
from app.api.routes import signals as signals_route
from app.api.routes import watchlists as watchlists_route
from app.api.routes.rules import _check_referenced_indicator_exists, _check_regime_indicator_ids, _check_watchlist_exists
from app.auth import Caller, get_caller
from app.config import settings
from app.domain.generation.rule import IndicatorCreate
from app.domain.generation.watchlist import WatchlistCreate
from app.domain.processing.models import SignalIngest
from app.main import app
from app.ownership import apply_scope, get_owned_or_404, is_visible, owner_for_create, visible_strategy_ids

ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
BOB = uuid.UUID("22222222-2222-2222-2222-222222222222")


def user(uid: uuid.UUID) -> Caller:
    return Caller(user_id=uid, is_admin=False, enforced=True)


ADMIN = Caller(user_id=uuid.UUID("99999999-9999-9999-9999-999999999999"), is_admin=True, enforced=True)
OFF_ANON = Caller(user_id=None, is_admin=False, enforced=False)
OFF_ALICE = Caller(user_id=ALICE, is_admin=False, enforced=False)


class Row:
    """Any ORM row: only created_by matters to ownership."""

    def __init__(self, created_by=None, **attrs):
        self.created_by = created_by
        for k, v in attrs.items():
            setattr(self, k, v)


def token(uid=ALICE, is_admin=False, secret=None, expires_in=3600):
    payload = {"sub": str(uid), "is_admin": is_admin, "exp": datetime.now(timezone.utc) + timedelta(seconds=expires_in)}
    return jwt.encode(payload, secret or settings.jwt_secret, algorithm=settings.jwt_algorithm)


# --- Caller.scope_user_id ---------------------------------------------------------------------


def test_scope_is_none_when_not_enforced():
    assert OFF_ANON.scope_user_id is None
    assert OFF_ALICE.scope_user_id is None


def test_scope_is_none_for_admin_even_when_enforced():
    assert ADMIN.scope_user_id is None


def test_scope_is_the_user_when_enforced_non_admin():
    assert user(ALICE).scope_user_id == ALICE


# --- get_caller ---------------------------------------------------------------------------------


class Creds:
    def __init__(self, tok):
        self.credentials = tok


def test_get_caller_flag_off_never_raises(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", False)
    c = get_caller(None)
    assert (c.user_id, c.is_admin, c.enforced) == (None, False, False)


def test_get_caller_flag_off_still_reads_a_valid_token(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", False)
    c = get_caller(Creds(token(ALICE)))
    assert c.user_id == ALICE and c.enforced is False


def test_get_caller_flag_on_without_token_is_401(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", True)
    with pytest.raises(HTTPException) as exc:
        get_caller(None)
    assert exc.value.status_code == 401


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param(lambda: token(secret="some-other-secret"), id="wrong-signature"),
        pytest.param(lambda: token(expires_in=-10), id="expired"),
        pytest.param(lambda: "not-a-jwt", id="garbage"),
        pytest.param(lambda: jwt.encode({"sub": "not-a-uuid"}, settings.jwt_secret, algorithm=settings.jwt_algorithm), id="bad-sub"),
        pytest.param(lambda: jwt.encode({"foo": "bar"}, settings.jwt_secret, algorithm=settings.jwt_algorithm), id="no-sub"),
    ],
)
def test_get_caller_flag_on_invalid_token_is_401(monkeypatch, bad):
    monkeypatch.setattr(settings, "require_auth", True)
    with pytest.raises(HTTPException) as exc:
        get_caller(Creds(bad()))
    assert exc.value.status_code == 401


def test_get_caller_flag_on_valid_token(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", True)
    c = get_caller(Creds(token(ALICE)))
    assert (c.user_id, c.is_admin, c.enforced) == (ALICE, False, True)
    assert c.scope_user_id == ALICE


def test_get_caller_reads_admin_claim(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", True)
    c = get_caller(Creds(token(ALICE, is_admin=True)))
    assert c.is_admin is True and c.scope_user_id is None


# --- ownership helpers --------------------------------------------------------------------------


def test_is_visible_matrix():
    mine, theirs, legacy = Row(ALICE), Row(BOB), Row(None)
    assert is_visible(mine, user(ALICE))
    assert not is_visible(theirs, user(ALICE))
    assert not is_visible(legacy, user(ALICE))  # NULL-owner rows are admin-only
    assert all(is_visible(r, ADMIN) for r in (mine, theirs, legacy))
    assert all(is_visible(r, OFF_ANON) for r in (mine, theirs, legacy))  # flag off: everything


class FakeDb:
    def __init__(self, rows=None):
        self.rows = rows or {}  # {(model, id): row}
        self.added = []

    def get(self, model, row_id):
        return self.rows.get((model, row_id))

    def add(self, row):
        self.added.append(row)

    def commit(self):
        pass

    def refresh(self, row):
        row.id = uuid.uuid4()
        row.created_at = row.updated_at = datetime.now(timezone.utc)


def test_get_owned_or_404_returns_own_row():
    rid = uuid.uuid4()
    row = Row(ALICE)
    assert get_owned_or_404(FakeDb({(db_models.Rule, rid): row}), db_models.Rule, rid, user(ALICE), "rule not found") is row


def test_get_owned_or_404_hides_someone_elses_row_as_404():
    rid = uuid.uuid4()
    with pytest.raises(HTTPException) as exc:
        get_owned_or_404(FakeDb({(db_models.Rule, rid): Row(BOB)}), db_models.Rule, rid, user(ALICE), "rule not found")
    assert exc.value.status_code == 404 and exc.value.detail == "rule not found"


def test_get_owned_or_404_missing_row_is_404():
    with pytest.raises(HTTPException) as exc:
        get_owned_or_404(FakeDb(), db_models.Rule, uuid.uuid4(), user(ALICE), "rule not found")
    assert exc.value.status_code == 404


def test_get_owned_or_404_admin_and_flag_off_see_everything():
    rid = uuid.uuid4()
    db = FakeDb({(db_models.Rule, rid): Row(BOB)})
    assert get_owned_or_404(db, db_models.Rule, rid, ADMIN, "x") is not None
    assert get_owned_or_404(db, db_models.Rule, rid, OFF_ANON, "x") is not None


class FakeQuery:
    def __init__(self):
        self.filters = []

    def filter(self, criterion):
        self.filters.append(str(criterion))
        return self


def test_apply_scope_filters_only_when_scoped():
    q = FakeQuery()
    assert apply_scope(q, db_models.Rule, ADMIN) is q and q.filters == []
    assert apply_scope(q, db_models.Rule, OFF_ANON) is q and q.filters == []
    apply_scope(q, db_models.Rule, user(ALICE))
    assert len(q.filters) == 1 and "created_by" in q.filters[0]


def test_visible_strategy_ids_is_none_unless_scoped():
    assert visible_strategy_ids(ADMIN) is None
    assert visible_strategy_ids(OFF_ANON) is None
    sub = visible_strategy_ids(user(ALICE))
    assert sub is not None and "created_by" in str(sub)


def test_owner_for_create_stamps_the_caller_even_when_flag_off():
    assert owner_for_create(OFF_ALICE) == ALICE
    assert owner_for_create(OFF_ANON) is None
    assert owner_for_create(user(BOB)) == BOB


# --- routes: create stamps the owner, reads/writes are scoped ---------------------------------


def test_create_indicator_stamps_owner():
    db = FakeDb()
    payload = IndicatorCreate(name="RSI 14", type="rsi", params={"period": 14, "sma_period": 9})
    indicators_route.create_indicator(payload, db=db, caller=user(ALICE))
    assert db.added[0].created_by == ALICE


def test_create_watchlist_stamps_owner():
    db = FakeDb()
    watchlists_route.create_watchlist(WatchlistCreate(name="mine", symbols="RELIANCE,TCS"), db=db, caller=user(ALICE))
    assert db.added[0].created_by == ALICE


def test_get_indicator_of_someone_else_is_404_but_own_and_admin_work():
    iid = uuid.uuid4()
    row = Row(BOB, id=iid, name="n", type="rsi", params={}, created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc))
    db = FakeDb({(db_models.Indicator, iid): row})
    with pytest.raises(HTTPException) as exc:
        indicators_route.get_indicator(str(iid), db=db, caller=user(ALICE))
    assert exc.value.status_code == 404
    assert indicators_route.get_indicator(str(iid), db=db, caller=user(BOB)).id == str(iid)
    assert indicators_route.get_indicator(str(iid), db=db, caller=ADMIN).id == str(iid)


def test_delete_and_update_of_someone_elses_indicator_are_404():
    iid = uuid.uuid4()
    db = FakeDb({(db_models.Indicator, iid): Row(BOB)})
    with pytest.raises(HTTPException) as exc:
        indicators_route.delete_indicator(str(iid), db=db, caller=user(ALICE))
    assert exc.value.status_code == 404
    from app.domain.generation.rule import IndicatorUpdate

    with pytest.raises(HTTPException) as exc:
        indicators_route.update_indicator(str(iid), IndicatorUpdate(name="hijack"), db=db, caller=user(ALICE))
    assert exc.value.status_code == 404


def test_delete_of_a_legacy_null_owner_watchlist_is_404_for_a_user_but_fine_for_admin():
    wid = uuid.uuid4()

    class DeletableDb(FakeDb):
        deleted = None

        def delete(self, row):
            self.deleted = row

    db = DeletableDb({(db_models.Watchlist, wid): Row(None)})
    with pytest.raises(HTTPException):
        watchlists_route.delete_watchlist(str(wid), db=db, caller=user(ALICE))
    assert db.deleted is None
    watchlists_route.delete_watchlist(str(wid), db=db, caller=ADMIN)
    assert db.deleted is not None


# --- a rule may only reference objects its creator can see -------------------------------------

CROSSOVER = {"type": "crossover", "indicator_id": "33333333-3333-3333-3333-333333333333"}
IND_ID = uuid.UUID("33333333-3333-3333-3333-333333333333")


def test_rule_cannot_reference_someone_elses_indicator():
    db = FakeDb({(db_models.Indicator, IND_ID): Row(BOB, type="rsi")})
    with pytest.raises(HTTPException) as exc:
        _check_referenced_indicator_exists(db, CROSSOVER, user(ALICE))
    assert exc.value.status_code == 422
    _check_referenced_indicator_exists(db, CROSSOVER, user(BOB))  # owner: fine
    _check_referenced_indicator_exists(db, CROSSOVER, ADMIN)


def test_rule_cannot_reference_someone_elses_regime_indicator():
    db = FakeDb({(db_models.Indicator, IND_ID): Row(BOB, type="adx")})
    with pytest.raises(HTTPException) as exc:
        _check_regime_indicator_ids(db, [str(IND_ID)], user(ALICE))
    assert exc.value.status_code == 422
    _check_regime_indicator_ids(db, [str(IND_ID)], user(BOB))


def test_rule_watchlist_check_is_scoped():
    class Q:
        def __init__(self, found):
            self.found = found
            self.scoped = False

        def filter(self, criterion):
            self.scoped = True
            return self

        def filter_by(self, **kw):
            return self

        def first(self):
            return object() if self.found else None

    class Db:
        def __init__(self):
            self.q = Q(True)

        def query(self, model):
            return self.q

    db = Db()
    _check_watchlist_exists(db, "watchlist", "wl", user(ALICE))
    assert db.q.scoped is True  # the owner filter was applied
    db = Db()
    _check_watchlist_exists(db, "watchlist", "wl", ADMIN)
    assert db.q.scoped is False


# --- saved backtests inherit the rule's owner ---------------------------------------------------


def test_saved_backtest_of_someone_elses_rule_is_404():
    rule_id, sb_id = uuid.uuid4(), uuid.uuid4()
    sb = Row(None, id=sb_id, rule_id=rule_id)
    db = FakeDb({(db_models.SavedBacktest, sb_id): sb, (db_models.Rule, rule_id): Row(BOB)})
    with pytest.raises(HTTPException) as exc:
        saved_backtests_route.get_saved_backtest(str(sb_id), db=db, caller=user(ALICE))
    assert exc.value.status_code == 404 and exc.value.detail == "saved backtest not found"
    with pytest.raises(HTTPException):
        saved_backtests_route.delete_saved_backtest(str(sb_id), db=db, caller=user(ALICE))


def test_saving_a_backtest_against_someone_elses_rule_is_404():
    rule_id = uuid.uuid4()
    db = FakeDb({(db_models.Rule, rule_id): Row(BOB)})
    from app.domain.generation.rule import SavedBacktestCreate

    payload = SavedBacktestCreate(name="x", from_date="2026-01-01", to_date="2026-02-01", request={}, result={})
    with pytest.raises(HTTPException) as exc:
        saved_backtests_route.create_saved_backtest(str(rule_id), payload, db=db, caller=user(ALICE))
    assert exc.value.status_code == 404


# --- signals ---------------------------------------------------------------------------------


def _signal(strategy_id):
    return SignalIngest(strategy_id=str(strategy_id), symbol="RELIANCE", exchange="NSE", action="BUY", price=100.0, source="manual")


def test_manual_signal_for_someone_elses_strategy_is_404_and_never_reaches_the_pipeline(monkeypatch):
    sid = uuid.uuid4()
    called = []
    monkeypatch.setattr(signals_route, "create_signal_from_ingest", lambda db, s: called.append(s))
    db = FakeDb({(db_models.Strategy, sid): Row(BOB)})
    with pytest.raises(HTTPException) as exc:
        signals_route.create_signal(_signal(sid), db=db, caller=user(ALICE))
    assert exc.value.status_code == 404 and called == []


def test_manual_signal_with_a_non_uuid_strategy_is_404_for_a_scoped_caller(monkeypatch):
    monkeypatch.setattr(signals_route, "create_signal_from_ingest", lambda db, s: pytest.fail("must not be called"))
    with pytest.raises(HTTPException) as exc:
        signals_route.create_signal(_signal("not-a-uuid"), db=FakeDb(), caller=user(ALICE))
    assert exc.value.status_code == 404


def test_manual_signal_for_own_strategy_and_unscoped_callers_go_through(monkeypatch):
    sid = uuid.uuid4()
    seen = []
    monkeypatch.setattr(signals_route, "create_signal_from_ingest", lambda db, s: seen.append(s) or {"ok": True})
    db = FakeDb({(db_models.Strategy, sid): Row(ALICE)})
    assert signals_route.create_signal(_signal(sid), db=db, caller=user(ALICE)) == {"ok": True}
    # flag off / admin: no ownership lookup at all (an unknown strategy is left to the pipeline to reject, as before)
    assert signals_route.create_signal(_signal(uuid.uuid4()), db=FakeDb(), caller=OFF_ANON) == {"ok": True}
    assert signals_route.create_signal(_signal(uuid.uuid4()), db=FakeDb(), caller=ADMIN) == {"ok": True}
    assert len(seen) == 3


# --- real app wiring: 401 when enforced, webhooks stay open -----------------------------------

client = TestClient(app)

PROTECTED = [
    ("GET", "/strategies"),
    ("POST", "/strategies"),
    ("GET", "/strategies/11111111-1111-1111-1111-111111111111"),
    ("PATCH", "/strategies/11111111-1111-1111-1111-111111111111"),
    ("DELETE", "/strategies/11111111-1111-1111-1111-111111111111"),
    ("GET", "/rules"),
    ("POST", "/rules"),
    ("DELETE", "/rules/11111111-1111-1111-1111-111111111111"),
    ("POST", "/rules/11111111-1111-1111-1111-111111111111/backtest?from=2026-01-01"),
    ("GET", "/rules/11111111-1111-1111-1111-111111111111/saved-backtests"),
    ("GET", "/saved-backtests/11111111-1111-1111-1111-111111111111"),
    ("GET", "/indicators"),
    ("POST", "/indicators"),
    ("GET", "/watchlists"),
    ("POST", "/watchlists"),
    ("GET", "/signals"),
    ("GET", "/signals/counts"),
    ("POST", "/signals"),
    ("DELETE", "/signals"),
]


@pytest.mark.parametrize("method,path", PROTECTED)
def test_core_routes_reject_anonymous_callers_when_enforced(monkeypatch, method, path):
    monkeypatch.setattr(settings, "require_auth", True)
    resp = client.request(method, path, json={})
    assert resp.status_code == 401, (method, path, resp.status_code, resp.text[:200])
    assert resp.headers.get("www-authenticate") == "Bearer"


def test_health_and_webhooks_stay_open_when_enforced(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", True)
    assert client.get("/health").status_code == 200
    # The Chartink webhook cannot send a JWT. It must never be a 401 - here it
    # fails on the missing strategy_id query param (422) before any DB access.
    for path in ("/webhook/chartink-buy", "/webhook/chartink-sell"):
        assert client.post(path, json={}).status_code == 422
    assert client.post("/ingest/raw", json={}).status_code != 401
