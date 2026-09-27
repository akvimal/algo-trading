"""PUT /positions/{id}/target: moving an open spot/futures position's take-profit.

Plain fakes and direct calls, like the rest of this backend."""

import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.routes import positions as route
from app.auth import User
from app.domain import position_manager as pm
from app.domain.models import TargetUpdate

ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
BOB = uuid.UUID("22222222-2222-2222-2222-222222222222")
PID = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")


def row(action="BUY", entry=100.0, status="OPEN", owner=ALICE, target=None, stop=95.0):
    return SimpleNamespace(id=PID, user_id=owner, action=action, entry_price=entry, status=status, target_price=target, stop_loss_price=stop)


class FakeDb:
    def __init__(self, r=None):
        self.r = r
        self.commits = 0

    def get(self, model, key):
        return self.r if self.r is not None and key == PID else None

    def commit(self):
        self.commits += 1


def test_the_model_needs_a_positive_price():
    assert TargetUpdate(target_price=105).target_price == 105
    for bad in (0, -1):
        with pytest.raises(ValidationError):
            TargetUpdate(target_price=bad)


def test_a_buy_target_above_entry_is_saved_and_nothing_else_changes():
    r = row("BUY", 100)
    db = FakeDb(r)
    out, reason = pm.update_target(db, ALICE, PID, 110)
    assert reason is None and out is r and r.target_price == 110 and r.stop_loss_price == 95.0 and db.commits == 1


def test_a_sell_target_below_entry_is_saved():
    r = row("SELL", 100)
    out, reason = pm.update_target(FakeDb(r), ALICE, PID, 90)
    assert reason is None and r.target_price == 90


@pytest.mark.parametrize("action, price", [("BUY", 100), ("BUY", 99), ("SELL", 100), ("SELL", 101)])
def test_a_target_on_the_wrong_side_of_entry_is_refused_and_leaves_the_row_alone(action, price):
    r = row(action, 100, target=None)
    db = FakeDb(r)
    out, reason = pm.update_target(db, ALICE, PID, price)
    assert out is r and reason and "must be" in reason
    assert r.target_price is None and db.commits == 0


def test_someone_elses_or_a_missing_position_is_none():
    assert pm.update_target(FakeDb(row(owner=ALICE)), BOB, PID, 110) == (None, None)
    assert pm.update_target(FakeDb(None), ALICE, PID, 110) == (None, None)


def user(uid):
    return User(id=uid, token="t", is_admin=False)


def test_the_route_maps_each_outcome_to_its_status(monkeypatch):
    p = TargetUpdate(target_price=110)
    monkeypatch.setattr(route, "_position_to_out", lambda r: {"id": str(r.id), "target_price": r.target_price})
    ok = route.edit_target(str(PID), p, user=user(ALICE), db=FakeDb(row()))
    assert ok == {"id": str(PID), "target_price": 110}

    for db, who, code in (
        (FakeDb(row()), ALICE, None),
        (FakeDb(row(status="CLOSED")), ALICE, 409),
        (FakeDb(None), ALICE, 404),
        (FakeDb(row(owner=ALICE)), BOB, 404),
    ):
        if code is None:
            continue
        with pytest.raises(HTTPException) as exc:
            route.edit_target(str(PID), p, user=user(who), db=db)
        assert exc.value.status_code == code, (code, exc.value.detail)

    with pytest.raises(HTTPException) as exc:
        route.edit_target(str(PID), TargetUpdate(target_price=90), user=user(ALICE), db=FakeDb(row("BUY", 100)))
    assert exc.value.status_code == 422

    with pytest.raises(HTTPException) as exc:
        route.edit_target("not-a-uuid", p, user=user(ALICE), db=FakeDb(row()))
    assert exc.value.status_code == 404
