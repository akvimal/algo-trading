import uuid
from types import SimpleNamespace

from app.domain import pending_orders as po


class FakeQuery:
    def __init__(self, calls):
        self.calls = calls

    def filter(self, *a):
        return self

    def update(self, values, synchronize_session=False):
        self.calls.append(values)


class FakeDb:
    def __init__(self):
        self.calls = []

    def query(self, model):
        return FakeQuery(self.calls)


def test_the_read_a_waiting_order_was_armed_with_goes_onto_the_trade_it_becomes():
    db = FakeDb()
    model = SimpleNamespace(id="id", entry_context="col")
    ctx = {"regime": "trending_up", "person_read": "ranging", "overridden": True}
    po._carry_context(db, model, uuid.uuid4(), SimpleNamespace(entry_context=ctx))
    assert db.calls == [{"col": ctx}]


def test_an_order_armed_without_a_read_changes_nothing():
    db = FakeDb()
    po._carry_context(db, SimpleNamespace(id="id", entry_context="col"), uuid.uuid4(), SimpleNamespace(entry_context=None))
    assert db.calls == []
