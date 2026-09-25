"""Ownership of dedicated per-strategy accounts (app/api/routes/accounts.py's
/accounts/strategy* routes, app/adapters/signal_engine/client.py).

Before this, a login was required (app-wide, in app/main.py) but not
ownership: any logged-in user could read, edit or delete anyone's dedicated
account, or create one for another user's strategy - which silently changes how
that strategy's trades are sized. Now: someone else's account is a 404, and
creating one is verified with signal-engine using the caller's own token.

Plain fakes and direct route-function calls, like the rest of this backend."""

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
import requests
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.adapters.db import models as db_models
from app.adapters.signal_engine import client as se_client
from app.adapters.signal_engine.client import FOUND, NOT_FOUND, UNAVAILABLE, StrategyLookup
from app.api.routes import accounts as route
from app.auth import User
from app.domain.models import StrategyAccountCreate, StrategyAccountUpdate
from app.main import app

ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
BOB = uuid.UUID("22222222-2222-2222-2222-222222222222")
ADMIN = uuid.UUID("99999999-9999-9999-9999-999999999999")
SID = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")

Account = db_models.StrategyAccount


def user(uid, admin=False):
    return User(id=uid, token=f"token-{uid}", is_admin=admin)


def account(owner=ALICE, live_user=None, **over):
    row = SimpleNamespace(
        strategy_id=SID, segment="NSE", starting_balance=100000, current_balance=90000,
        capital_per_trade=10000, risk_per_trade_pct=1, owner_user_id=owner, live_trading_user_id=live_user,
        live_trading_enabled=False, live_trading_consent_at=None, live_trading_consent_version=None,
        max_order_value=None, max_daily_loss=None, updated_at=datetime.now(timezone.utc),
    )
    for k, v in over.items():
        setattr(row, k, v)
    return row


class FakeQuery:
    def __init__(self, rows):
        self.rows = rows
        self.filters = []

    def filter(self, criterion):
        self.filters.append(str(criterion))
        return self

    def filter_by(self, **kw):
        return self

    def all(self):
        return self.rows


class FakeDb:
    def __init__(self, rows=None):
        self.rows = {r.strategy_id: r for r in (rows or [])}
        self.added = []
        self.deleted = []
        self.last_query = None

    def get(self, model, key):
        return self.rows.get(key) if model is Account else None

    def query(self, model):
        self.last_query = FakeQuery(list(self.rows.values()) if model is Account else [])
        return self.last_query

    def add(self, row):
        self.added.append(row)

    def delete(self, row):
        self.deleted.append(row)

    def commit(self):
        pass

    def refresh(self, row):
        row.updated_at = datetime.now(timezone.utc)


@pytest.fixture(autouse=True)
def plain_output(monkeypatch):
    """Serialization is not what is under test (it also queries positions)."""
    monkeypatch.setattr(route, "_strategy_account_to_out", lambda db, row: row)


# --- who can see an account -------------------------------------------------------------------


@pytest.mark.parametrize(
    "who, expected",
    [
        (user(ALICE), True),  # the owner
        (user(BOB), False),  # a stranger
        (user(ADMIN, admin=True), True),
    ],
)
def test_visibility_of_an_owned_account(who, expected):
    assert route._can_see_strategy_account(account(owner=ALICE), who) is expected


def test_the_named_live_user_can_see_it_even_if_not_the_owner():
    assert route._can_see_strategy_account(account(owner=ALICE, live_user=BOB), user(BOB)) is True


def test_an_ownerless_legacy_account_is_admin_only():
    legacy = account(owner=None)
    assert route._can_see_strategy_account(legacy, user(ALICE)) is False
    assert route._can_see_strategy_account(legacy, user(ADMIN, admin=True)) is True


# --- reading / editing / deleting someone else's account -----------------------------------------


def test_a_strangers_get_put_delete_reset_are_all_404_and_change_nothing():
    row = account(owner=ALICE)
    db = FakeDb([row])
    stranger = user(BOB)
    for call in (
        lambda: route.get_strategy_account(str(SID), user=stranger, db=db),
        lambda: route.update_strategy_account(str(SID), StrategyAccountUpdate(capital_per_trade=1), user=stranger, db=db),
        lambda: route.delete_strategy_account(str(SID), user=stranger, db=db),
        lambda: route.reset_strategy_account(str(SID), user=stranger, db=db),
    ):
        with pytest.raises(HTTPException) as exc:
            call()
        assert exc.value.status_code == 404
    assert db.deleted == [] and row.capital_per_trade == 10000 and row.current_balance == 90000


def test_a_missing_account_and_someone_elses_look_identical():
    db = FakeDb([account(owner=ALICE)])
    with pytest.raises(HTTPException) as theirs:
        route.get_strategy_account(str(SID), user=user(BOB), db=db)
    with pytest.raises(HTTPException) as missing:
        route.get_strategy_account(str(uuid.uuid4()), user=user(BOB), db=FakeDb())
    assert theirs.value.status_code == missing.value.status_code == 404


def test_a_malformed_strategy_id_is_a_404_not_a_500():
    with pytest.raises(HTTPException) as exc:
        route.get_strategy_account("not-a-uuid", user=user(ALICE), db=FakeDb())
    assert exc.value.status_code == 404


def test_owner_and_admin_can_act_on_it():
    row = account(owner=ALICE)
    db = FakeDb([row])
    assert route.get_strategy_account(str(SID), user=user(ALICE), db=db) is row
    assert route.get_strategy_account(str(SID), user=user(ADMIN, admin=True), db=db) is row
    route.reset_strategy_account(str(SID), user=user(ALICE), db=db)
    assert row.current_balance == row.starting_balance
    route.delete_strategy_account(str(SID), user=user(ADMIN, admin=True), db=db)
    assert db.deleted == [row]


def test_listing_is_filtered_to_own_accounts_unless_admin():
    db = FakeDb([account()])
    route.list_strategy_accounts(user=user(BOB), db=db)
    assert any("owner_user_id" in f for f in db.last_query.filters)
    db = FakeDb([account()])
    route.list_strategy_accounts(user=user(ADMIN, admin=True), db=db)
    assert db.last_query.filters == []


# --- creating one ---------------------------------------------------------------------------------


def make_create(monkeypatch, lookup, caller, existing=None):
    seen = {}

    def fake_lookup(strategy_id, token):
        seen["args"] = (strategy_id, token)
        return lookup

    monkeypatch.setattr(route, "lookup_strategy", fake_lookup)
    db = FakeDb(existing)
    body = StrategyAccountCreate(segment="NSE", starting_balance=100000, capital_per_trade=10000, risk_per_trade_pct=1)
    return db, seen, lambda: route.create_strategy_account(str(SID), body, user=caller, db=db)


def test_creating_for_a_strategy_you_cannot_see_is_a_404_and_writes_nothing(monkeypatch):
    db, _, call = make_create(monkeypatch, StrategyLookup(NOT_FOUND), user(BOB))
    with pytest.raises(HTTPException) as exc:
        call()
    assert exc.value.status_code == 404 and db.added == []


def test_it_fails_closed_when_signal_engine_cannot_be_asked(monkeypatch):
    db, _, call = make_create(monkeypatch, StrategyLookup(UNAVAILABLE), user(ALICE))
    with pytest.raises(HTTPException) as exc:
        call()
    assert exc.value.status_code == 503 and db.added == []


def test_signal_engine_is_asked_with_the_callers_own_token(monkeypatch):
    _, seen, call = make_create(monkeypatch, StrategyLookup(FOUND, created_by=str(ALICE)), user(ALICE))
    call()
    assert seen["args"] == (str(SID), f"token-{ALICE}")


def test_the_row_is_owned_by_the_strategys_creator(monkeypatch):
    db, _, call = make_create(monkeypatch, StrategyLookup(FOUND, created_by=str(ALICE)), user(ALICE))
    call()
    assert db.added[0].owner_user_id == ALICE


def test_an_admin_creating_for_a_users_strategy_does_not_become_its_owner(monkeypatch):
    db, _, call = make_create(monkeypatch, StrategyLookup(FOUND, created_by=str(BOB)), user(ADMIN, admin=True))
    call()
    assert db.added[0].owner_user_id == BOB


def test_a_platform_strategy_with_no_creator(monkeypatch):
    db, _, call = make_create(monkeypatch, StrategyLookup(FOUND, created_by=None), user(ADMIN, admin=True))
    call()
    assert db.added[0].owner_user_id is None  # stays admin-only
    db, _, call = make_create(monkeypatch, StrategyLookup(FOUND, created_by=None), user(ALICE))
    call()
    assert db.added[0].owner_user_id == ALICE  # someone who could see it can still reach what they made


def test_an_existing_account_is_a_409_only_for_someone_who_can_see_the_strategy(monkeypatch):
    existing = [account(owner=ALICE)]
    _, _, call = make_create(monkeypatch, StrategyLookup(FOUND, created_by=str(ALICE)), user(ALICE), existing)
    with pytest.raises(HTTPException) as exc:
        call()
    assert exc.value.status_code == 409
    # a stranger learns nothing about whether an account exists
    _, _, call = make_create(monkeypatch, StrategyLookup(NOT_FOUND), user(BOB), existing)
    with pytest.raises(HTTPException) as exc:
        call()
    assert exc.value.status_code == 404


# --- the signal-engine client ---------------------------------------------------------------------


class Resp:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


def stub_get(monkeypatch, result):
    calls = []

    def fake_get(url, headers=None, timeout=None):
        calls.append((url, headers))
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(se_client.requests, "get", fake_get)
    return calls


def test_client_found_returns_the_creator(monkeypatch):
    calls = stub_get(monkeypatch, Resp(200, {"id": str(SID), "created_by": str(ALICE)}))
    out = se_client.lookup_strategy(str(SID), "tok")
    assert (out.status, out.created_by) == (FOUND, str(ALICE))
    assert calls[0][1] == {"Authorization": "Bearer tok"} and calls[0][0].endswith(f"/strategies/{SID}")


@pytest.mark.parametrize("code", [403, 404])
def test_client_maps_hidden_or_missing_to_not_found(monkeypatch, code):
    stub_get(monkeypatch, Resp(code))
    assert se_client.lookup_strategy(str(SID), "tok").status == NOT_FOUND


@pytest.mark.parametrize("result", [Resp(500), Resp(200, None), requests.ConnectionError("down"), requests.Timeout("slow")])
def test_client_fails_closed_on_anything_else(monkeypatch, result):
    stub_get(monkeypatch, result)
    assert se_client.lookup_strategy(str(SID), "tok").status == UNAVAILABLE


def test_client_without_a_token_does_not_call_out(monkeypatch):
    calls = stub_get(monkeypatch, Resp(200, {}))
    assert se_client.lookup_strategy(str(SID), "").status == UNAVAILABLE
    assert calls == []


# --- real app wiring --------------------------------------------------------------------------------

client = TestClient(app)  # no lifespan: no scheduler, no consumer


@pytest.mark.parametrize(
    "method, path",
    [
        ("GET", "/accounts/strategy"),
        ("GET", f"/accounts/strategy/{SID}"),
        ("POST", f"/accounts/strategy/{SID}"),
        ("PUT", f"/accounts/strategy/{SID}"),
        ("DELETE", f"/accounts/strategy/{SID}"),
        ("POST", f"/accounts/strategy/{SID}/reset"),
    ],
)
def test_every_strategy_account_route_needs_a_login(method, path):
    resp = client.request(method, path, json={})
    assert resp.status_code == 401, (method, path, resp.status_code)
