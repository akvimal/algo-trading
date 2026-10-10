"""Where a plan note's trade stands (GET /study-notes/trades). Plain fakes and direct calls."""

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from app.adapters.db import models as m
from app.domain.study_notes import note_trades, r_multiple

ME = uuid.UUID("11111111-1111-1111-1111-111111111111")
NOW = datetime(2026, 10, 10, tzinfo=timezone.utc)


class Q:
    def __init__(self, rows):
        self.rows = rows

    def filter(self, *a, **k):
        return self

    def order_by(self, *a, **k):
        return self

    def all(self):
        return list(self.rows)


class Db:
    def __init__(self, notes=(), orders=(), positions=()):
        self.by_model = {m.StudyNote: notes, m.PendingOrder: orders, m.Position: positions}

    def query(self, model):
        return Q(self.by_model[model])


def note(position_id=None):
    return SimpleNamespace(id=uuid.uuid4(), user_id=ME, position_id=position_id)


def order(note_id, status="pending", reason=None):
    return SimpleNamespace(
        id=uuid.uuid4(), source_note_id=note_id, status=status, status_reason=reason, trigger_price=100, stop_loss_price=95, target_price=120,
        expires_at=NOW, last_price=101, created_at=NOW,
    )


def position(pid, status="OPEN", action="BUY", entry=100, exit_=None, initial_stop=95, pnl=None):
    return SimpleNamespace(
        id=pid, status=status, action=action, horizon="positional", quantity=10, entry_price=entry, exit_price=exit_, pnl=pnl, exit_reason=None,
        stop_loss_price=initial_stop, initial_stop_loss_price=initial_stop, target_price=120, segment="NSE",
    )


def test_r_multiple_is_the_move_over_the_planned_risk_and_signed_by_side():
    assert r_multiple("BUY", 100, 110, 95) == 2.0
    assert r_multiple("BUY", 100, 92, 95) == -1.6
    assert r_multiple("SELL", 100, 90, 105) == 2.0
    assert r_multiple("BUY", 100, 110, None) is None  # no stop, no R
    assert r_multiple("BUY", 100, 110, 100) is None  # a zero-width stop cannot define R


def test_a_note_with_no_trade_is_left_out():
    assert note_trades(Db(notes=[note()]), ME, [uuid.uuid4()]) == []
    assert note_trades(Db(), ME, []) == []


def test_a_limit_entry_still_waiting():
    n = note()
    out = note_trades(Db(notes=[n], orders=[order(n.id)]), ME, [n.id])
    assert len(out) == 1 and out[0]["state"] == "waiting" and out[0]["order"]["trigger_price"] == 100 and out[0]["position"] is None


def test_an_order_that_expired_is_ended_with_its_reason():
    n = note()
    out = note_trades(Db(notes=[n], orders=[order(n.id, "expired", "expired before the price reached the trigger")]), ME, [n.id])
    assert out[0]["state"] == "ended" and "expired" in out[0]["order"]["status_reason"]


def test_an_open_position_and_a_closed_one_with_its_r():
    pid = uuid.uuid4()
    n = note(pid)
    opened = note_trades(Db(notes=[n], positions=[position(pid)]), ME, [n.id])
    assert opened[0]["state"] == "open" and opened[0]["r_multiple"] is None
    closed = note_trades(Db(notes=[n], positions=[position(pid, "CLOSED", exit_=110, pnl=100)]), ME, [n.id])
    assert closed[0]["state"] == "closed" and closed[0]["r_multiple"] == 2.0 and closed[0]["position"]["pnl"] == 100


def test_the_position_wins_over_the_order_it_came_from():
    pid = uuid.uuid4()
    n = note(pid)
    out = note_trades(Db(notes=[n], orders=[order(n.id, "triggered")], positions=[position(pid)]), ME, [n.id])
    assert out[0]["state"] == "open" and out[0]["order"]["status"] == "triggered"
