"""Login + per-user ownership on the Weekly Advisor routes
(app/api/routes/weekly_advisor.py; same model as tests/test_ownership.py):
saved recommendations are owned by their creator, a trade inherits its
recommendation's owner, the platform-wide settings are admin-only for writes,
and the one deliberately open route (the cached screenshot) stays open.

Plain fakes and direct route-function calls, like the rest of this backend."""

import uuid
from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.adapters.db import models as db_models
from app.api.routes import weekly_advisor as route
from app.auth import Caller
from app.config import settings
from app.domain.weekly_advisor.journal import DecisionSet, SaveRecommendationRequest, TradeClose, TradeCreate, TradeEntryUpdate
from app.main import app

ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
BOB = uuid.UUID("22222222-2222-2222-2222-222222222222")
ADMIN = Caller(user_id=uuid.UUID("99999999-9999-9999-9999-999999999999"), is_admin=True, enforced=True)
OFF = Caller(user_id=None, is_admin=False, enforced=False)


def user(uid):
    return Caller(user_id=uid, is_admin=False, enforced=True)


Rec = db_models.WeeklyAdvisorRecommendation
Trade = db_models.WeeklyAdvisorTrade


class Row(SimpleNamespace):
    pass


class FakeDb:
    def __init__(self, rows=None):
        self.rows = rows or {}
        self.added = []
        self.deleted = []

    def get(self, model, key):
        return self.rows.get((model, key))

    def add(self, row):
        self.added.append(row)

    def delete(self, row):
        self.deleted.append(row)

    def commit(self):
        pass

    def refresh(self, row):
        pass


@pytest.fixture(autouse=True)
def passthrough_serializers(monkeypatch):
    """The real serializers need fully-populated rows; these tests are about
    who may reach a row, not how it is rendered."""
    monkeypatch.setattr(route, "_to_saved_out", lambda row: row)
    monkeypatch.setattr(route, "_to_trade_out", lambda row, rec: row)


def rec_row(owner, rid=None):
    return Row(id=rid or uuid.uuid4(), created_by=owner, symbol="TCS", decision=None, confidence=None, decision_comments=None, decided_at=None)


def trade_row(rec_id, status="open"):
    return Row(id=uuid.uuid4(), recommendation_id=rec_id, status=status, exit_debit=None, realized_pnl=None, exit_notes=None, closed_at=None)


# --- saved recommendations -----------------------------------------------------------------------


def test_saving_a_recommendation_stamps_the_owner(monkeypatch):
    fake_rec = SimpleNamespace(
        symbol="TCS", as_of=datetime(2026, 9, 25, tzinfo=timezone.utc), strategy=SimpleNamespace(action="sell_put"),
        model_dump=lambda mode=None: {"symbol": "TCS"},
    )
    monkeypatch.setattr(route, "run_symbol", lambda symbol, as_of=None, **kw: fake_rec)
    db = FakeDb()
    route.save_recommendation(SaveRecommendationRequest(symbol="tcs"), db=db, caller=user(ALICE))
    assert db.added[0].created_by == ALICE


def test_someone_elses_recommendation_is_a_404_for_get_delete_and_decision():
    rid = uuid.uuid4()
    db = FakeDb({(Rec, rid): rec_row(BOB, rid)})
    for call in (
        lambda: route.get_saved_recommendation(str(rid), db=db, caller=user(ALICE)),
        lambda: route.delete_saved_recommendation(str(rid), db=db, caller=user(ALICE)),
        lambda: route.set_recommendation_decision(str(rid), DecisionSet(decision="execute"), db=db, caller=user(ALICE)),
    ):
        with pytest.raises(HTTPException) as exc:
            call()
        assert exc.value.status_code == 404
    assert db.deleted == []


def test_owner_and_admin_can_reach_it_and_legacy_rows_are_admin_only():
    rid, legacy = uuid.uuid4(), uuid.uuid4()
    db = FakeDb({(Rec, rid): rec_row(ALICE, rid), (Rec, legacy): rec_row(None, legacy)})
    assert route.get_saved_recommendation(str(rid), db=db, caller=user(ALICE)).id == rid
    assert route.get_saved_recommendation(str(rid), db=db, caller=ADMIN).id == rid
    assert route.get_saved_recommendation(str(legacy), db=db, caller=ADMIN).id == legacy
    with pytest.raises(HTTPException):
        route.get_saved_recommendation(str(legacy), db=db, caller=user(ALICE))
    assert route.get_saved_recommendation(str(rid), db=db, caller=OFF).id == rid  # flag off: unchanged


class FakeQuery:
    def __init__(self):
        self.filters = []

    def filter(self, criterion):
        self.filters.append(str(criterion))
        return self

    def order_by(self, *a):
        return self

    def limit(self, n):
        return self

    def all(self):
        return []

    def join(self, *a, **k):
        return self


class QueryDb:
    def __init__(self):
        self.q = FakeQuery()

    def query(self, *models):
        return self.q


def test_history_is_filtered_to_the_callers_own_recommendations_unless_admin():
    db = QueryDb()
    route.list_saved_recommendations(symbol=None, limit=50, db=db, caller=user(ALICE))
    assert any("created_by" in f for f in db.q.filters)
    db = QueryDb()
    route.list_saved_recommendations(symbol=None, limit=50, db=db, caller=ADMIN)
    assert not any("created_by" in f for f in db.q.filters)


def test_trade_list_and_performance_summary_are_scoped_through_the_recommendation():
    db = QueryDb()
    route.list_trades(status=None, symbol=None, db=db, caller=user(ALICE))
    assert any("created_by" in f for f in db.q.filters)
    db = QueryDb()
    route.get_performance_summary(symbol=None, db=db, caller=user(BOB))
    assert any("created_by" in f for f in db.q.filters)
    db = QueryDb()
    route.get_performance_summary(symbol=None, db=db, caller=ADMIN)
    assert not any("created_by" in f for f in db.q.filters)


# --- trades inherit the recommendation's owner ---------------------------------------------------


def test_a_trade_cannot_be_created_on_someone_elses_recommendation():
    rid = uuid.uuid4()
    db = FakeDb({(Rec, rid): rec_row(BOB, rid)})
    with pytest.raises(HTTPException) as exc:
        route.create_trade(str(rid), TradeCreate(quantity=1), db=db, caller=user(ALICE))
    assert exc.value.status_code == 404 and db.added == []


def test_someone_elses_trade_is_a_404_for_entry_close_and_delete():
    rid = uuid.uuid4()
    t = trade_row(rid)
    db = FakeDb({(Rec, rid): rec_row(BOB, rid), (Trade, t.id): t})
    for call in (
        lambda: route.update_trade_entry(str(t.id), TradeEntryUpdate(), db=db, caller=user(ALICE)),
        lambda: route.close_trade(str(t.id), TradeClose(exit_debit=1, realized_pnl=1), db=db, caller=user(ALICE)),
        lambda: route.delete_trade(str(t.id), db=db, caller=user(ALICE)),
    ):
        with pytest.raises(HTTPException) as exc:
            call()
        assert exc.value.status_code == 404 and exc.value.detail == "trade not found"
    assert db.deleted == [] and t.status == "open"


def test_the_owner_can_close_and_admin_can_delete_their_trade():
    rid = uuid.uuid4()
    t = trade_row(rid)
    db = FakeDb({(Rec, rid): rec_row(ALICE, rid), (Trade, t.id): t})
    route.close_trade(str(t.id), TradeClose(exit_debit=1, realized_pnl=5), db=db, caller=user(ALICE))
    assert t.status == "closed"
    route.delete_trade(str(t.id), db=db, caller=ADMIN)
    assert db.deleted == [t]


def test_unscoped_callers_do_not_even_look_up_the_recommendation():
    """Flag off / admin: behaviour identical to before ownership existed."""
    t = trade_row(uuid.uuid4())
    db = FakeDb({(Trade, t.id): t})  # no recommendation row at all
    route.delete_trade(str(t.id), db=db, caller=OFF)
    assert db.deleted == [t]


# --- platform-wide settings --------------------------------------------------------------------------


@pytest.fixture
def restore_settings(monkeypatch):
    monkeypatch.setattr(settings, "openrouter_vision_model", settings.openrouter_vision_model)
    monkeypatch.setattr(settings, "weekly_advisor_defined_risk", settings.weekly_advisor_defined_risk)


client = TestClient(app)


def test_settings_write_is_admin_only_when_enforced(monkeypatch, restore_settings):
    from app.auth import get_admin_caller

    monkeypatch.setattr(settings, "require_auth", True)
    with pytest.raises(HTTPException) as exc:
        get_admin_caller(user(ALICE))
    assert exc.value.status_code == 403
    assert get_admin_caller(ADMIN) is ADMIN
    assert get_admin_caller(OFF) is OFF  # flag off: anyone, as before


def test_settings_write_changes_the_process_wide_values_for_an_admin(restore_settings):
    out = route.update_weekly_advisor_settings(
        route.WeeklyAdvisorSettings(openrouter_vision_model="some/model", defined_risk=False), caller=ADMIN
    )
    assert out.openrouter_vision_model == "some/model" and settings.weekly_advisor_defined_risk is False


# --- real app wiring -------------------------------------------------------------------------------------

PROTECTED = [
    ("GET", "/weekly-advisor/recommendations"),
    ("POST", "/weekly-advisor/margin"),
    ("GET", "/weekly-advisor/lot-size?security_id=1"),
    ("GET", "/weekly-advisor/option-chain-strikes?symbol=TCS&expiry=2026-10-01"),
    ("POST", "/weekly-advisor/recommendations/save"),
    ("GET", "/weekly-advisor/recommendations/history"),
    ("GET", "/weekly-advisor/recommendations/11111111-1111-1111-1111-111111111111"),
    ("DELETE", "/weekly-advisor/recommendations/11111111-1111-1111-1111-111111111111"),
    ("PUT", "/weekly-advisor/recommendations/11111111-1111-1111-1111-111111111111/decision"),
    ("POST", "/weekly-advisor/recommendations/11111111-1111-1111-1111-111111111111/trades"),
    ("GET", "/weekly-advisor/trades"),
    ("PUT", "/weekly-advisor/trades/11111111-1111-1111-1111-111111111111/entry"),
    ("PUT", "/weekly-advisor/trades/11111111-1111-1111-1111-111111111111/close"),
    ("DELETE", "/weekly-advisor/trades/11111111-1111-1111-1111-111111111111"),
    ("GET", "/weekly-advisor/performance/summary"),
    ("GET", "/weekly-advisor/settings"),
    ("PUT", "/weekly-advisor/settings"),
]


@pytest.mark.parametrize("method,path", PROTECTED)
def test_advisor_routes_reject_anonymous_callers_when_enforced(monkeypatch, method, path):
    monkeypatch.setattr(settings, "require_auth", True)
    resp = client.request(method, path, json={})
    assert resp.status_code == 401, (method, path, resp.status_code)


def test_the_cached_screenshot_stays_open(monkeypatch):
    """The UI loads it as a plain URL (no Authorization header possible)."""
    monkeypatch.setattr(settings, "require_auth", True)
    monkeypatch.setattr(route, "get_cached_screenshot", lambda symbol: None)
    assert client.get("/weekly-advisor/fundamentals/TCS/screenshot").status_code == 404  # "nothing cached", not 401
