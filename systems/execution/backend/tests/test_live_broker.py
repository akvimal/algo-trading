"""Tests for app/domain/live_broker.py (live-broker-adapter P1/P2, see
docs/architecture.md). Follows this test suite's existing "plain fakes"
preference (see test_orders_consumer.py's own comment) rather than a real
DB/HTTP connection - a FakeDb stands in for the SQLAlchemy Session
(add/commit are no-ops, refresh applies a pre-scripted sequence of status
transitions to simulate the postback arriving via a separate session), and
place_broker_order/place_broker_order_internal/etc. are monkeypatched
instead of hitting market-data."""

import uuid

import pytest

import app.domain.live_broker as live_broker
from app.adapters.db import models as db_models


class FakeAccount:
    def __init__(self, live_trading_enabled=False):
        self.live_trading_enabled = live_trading_enabled


class FakeDb:
    """refresh() pops the next status off a pre-scripted queue each call -
    simulates the postback flipping broker_orders.status via a different
    session/transaction between polls."""

    def __init__(self, status_sequence=None):
        self._status_sequence = list(status_sequence) if status_sequence else []
        self.added = []
        self.commits = 0

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        self.commits += 1

    def refresh(self, obj):
        if self._status_sequence:
            obj.status = self._status_sequence.pop(0)


@pytest.fixture(autouse=True)
def _fast_timeout(monkeypatch):
    # Real values are 8s/0.5s - shrink both so timeout-path tests don't
    # actually sleep for seconds, and stub time.sleep entirely.
    monkeypatch.setattr(live_broker, "FILL_WAIT_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(live_broker, "FILL_POLL_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(live_broker.time, "sleep", lambda _seconds: None)


def test_is_live_enabled_true_when_account_opted_in_and_no_kill_switch(monkeypatch):
    monkeypatch.setattr(live_broker.settings, "live_trading_kill_switch", False)
    assert live_broker.is_live_enabled(FakeAccount(live_trading_enabled=True)) is True


def test_is_live_enabled_false_when_account_not_opted_in(monkeypatch):
    monkeypatch.setattr(live_broker.settings, "live_trading_kill_switch", False)
    assert live_broker.is_live_enabled(FakeAccount(live_trading_enabled=False)) is False


def test_is_live_enabled_false_when_kill_switch_on_even_if_account_opted_in(monkeypatch):
    monkeypatch.setattr(live_broker.settings, "live_trading_kill_switch", True)
    assert live_broker.is_live_enabled(FakeAccount(live_trading_enabled=True)) is False


def test_submit_live_order_success_returns_traded_order(monkeypatch):
    monkeypatch.setattr(live_broker, "place_broker_order", lambda **kwargs: {"orderId": "dhan-123"})
    db = FakeDb(status_sequence=["traded"])

    order, error = live_broker.submit_live_order(
        db, uuid.uuid4(), "tok", position_id=None, purpose="entry",
        exchange="NSE", symbol="RELIANCE", action="BUY", quantity=10,
    )

    assert error is None
    assert order.status == "traded"
    assert order.broker_order_id == "dhan-123"
    assert order.purpose == "entry"
    assert order.order_type == "MARKET"
    assert order.product_type == "INTRADAY"
    # Written once before the Dhan call (submit-then-crash safety), then
    # again after the response, so at least 2 commits happened.
    assert db.commits >= 2


def test_submit_live_order_dhan_rejects_immediately(monkeypatch):
    monkeypatch.setattr(live_broker, "place_broker_order", lambda **kwargs: {"orderId": "dhan-999"})
    db = FakeDb(status_sequence=["rejected"])

    order, error = live_broker.submit_live_order(
        db, uuid.uuid4(), "tok", position_id=None, purpose="entry",
        exchange="NSE", symbol="RELIANCE", action="BUY", quantity=10,
    )

    assert error is not None
    assert "rejected" in error
    assert order.status == "rejected"


def test_submit_live_order_http_call_raises_marks_failed(monkeypatch):
    def _boom(**kwargs):
        raise RuntimeError("market-data unreachable")

    monkeypatch.setattr(live_broker, "place_broker_order", _boom)
    db = FakeDb()

    order, error = live_broker.submit_live_order(
        db, uuid.uuid4(), "tok", position_id=None, purpose="entry",
        exchange="NSE", symbol="RELIANCE", action="BUY", quantity=10,
    )

    assert order.status == "failed"
    assert "market-data unreachable" in error
    assert "market-data unreachable" in order.failure_reason


def test_submit_live_order_times_out_without_confirmation(monkeypatch):
    monkeypatch.setattr(live_broker, "place_broker_order", lambda **kwargs: {"orderId": "dhan-1"})
    # Never transitions away from 'pending' - refresh() has nothing queued,
    # so status stays whatever it was set to after the place_order response.
    db = FakeDb(status_sequence=[])

    order, error = live_broker.submit_live_order(
        db, uuid.uuid4(), "tok", position_id=None, purpose="entry",
        exchange="NSE", symbol="RELIANCE", action="BUY", quantity=10,
    )

    assert error is not None
    assert "not confirmed traded" in error
    assert order.status == "pending"


def test_submit_live_order_writes_broker_order_row_before_dhan_call(monkeypatch):
    """Submit-then-crash safety (broker_orders' own comment) - the row must
    be added/committed BEFORE place_broker_order is ever called, so a crash
    mid-flight still leaves a resolvable 'submitting' row."""
    calls = []

    def _tracking_place_order(**kwargs):
        calls.append("place_order")
        return {"orderId": "dhan-1"}

    monkeypatch.setattr(live_broker, "place_broker_order", _tracking_place_order)

    class TrackingDb(FakeDb):
        def add(self, obj):
            calls.append("db.add")
            super().add(obj)

        def commit(self):
            calls.append("db.commit")
            super().commit()

    db = TrackingDb(status_sequence=["traded"])
    live_broker.submit_live_order(
        db, uuid.uuid4(), "tok", position_id=None, purpose="entry",
        exchange="NSE", symbol="RELIANCE", action="BUY", quantity=10,
    )

    assert calls.index("db.add") < calls.index("place_order")
    assert calls.index("db.commit") < calls.index("place_order")


def test_submit_resting_stop_loss_does_not_wait_for_a_fill(monkeypatch):
    """Unlike submit_live_order, a resting order may sit for hours - this
    must return as soon as Dhan ACCEPTS it (status='pending'), never poll
    for 'traded'."""
    monkeypatch.setattr(live_broker, "place_broker_order", lambda **kwargs: {"orderId": "dhan-sl-1"})
    # No status_sequence at all - if submit_resting_stop_loss incorrectly
    # waited for a fill, db.refresh would be a no-op forever and the test
    # would hang for FILL_WAIT_TIMEOUT_SECONDS (already shrunk to 0.05s by
    # the autouse fixture) - so a slow-but-passing result here would still
    # indicate a bug; asserting status=='pending' catches the real one.
    db = FakeDb()

    order, error = live_broker.submit_resting_stop_loss(
        db, uuid.uuid4(), "tok", position_id=uuid.uuid4(), exchange="NSE", symbol="RELIANCE",
        action="SELL", quantity=10, trigger_price=95.0,
    )

    assert error is None
    assert order.status == "pending"
    assert order.purpose == "stop_loss"
    assert order.order_type == "STOP_LOSS_MARKET"
    assert float(order.trigger_price) == 95.0


def test_submit_resting_stop_loss_returns_error_on_immediate_rejection(monkeypatch):
    def _boom(**kwargs):
        raise RuntimeError("invalid trigger price")

    monkeypatch.setattr(live_broker, "place_broker_order", _boom)
    db = FakeDb()

    order, error = live_broker.submit_resting_stop_loss(
        db, uuid.uuid4(), "tok", position_id=uuid.uuid4(), exchange="NSE", symbol="RELIANCE",
        action="SELL", quantity=10, trigger_price=95.0,
    )

    assert order.status == "failed"
    assert "invalid trigger price" in error


def test_submit_exit_order_scheduled_uses_internal_route_and_waits_for_fill(monkeypatch):
    calls = []

    def _tracking_internal(**kwargs):
        calls.append(kwargs)
        return {"orderId": "dhan-exit-1"}

    monkeypatch.setattr(live_broker, "place_broker_order_internal", _tracking_internal)
    db = FakeDb(status_sequence=["traded"])

    order, error = live_broker.submit_exit_order_scheduled(
        db, uuid.uuid4(), uuid.uuid4(), "NSE", "RELIANCE", "SELL", 10,
    )

    assert error is None
    assert order.status == "traded"
    assert order.purpose == "exit"
    assert calls[0]["transaction_type"] == "SELL"
    assert "user_id" in calls[0]


def test_modify_resting_order_scheduled_updates_trigger_price(monkeypatch):
    monkeypatch.setattr(live_broker, "modify_broker_order_internal", lambda **kwargs: {"orderId": "dhan-sl-1"})
    db = FakeDb()
    order = db_models.BrokerOrder(broker_order_id="dhan-sl-1", exchange="NSE", order_type="STOP_LOSS_MARKET", quantity=10, trigger_price=95.0)

    error = live_broker.modify_resting_order_scheduled(db, uuid.uuid4(), order, 97.0)

    assert error is None
    assert float(order.trigger_price) == 97.0
    assert db.commits == 1


def test_modify_resting_order_scheduled_requires_a_broker_order_id():
    db = FakeDb()
    order = db_models.BrokerOrder(broker_order_id=None, exchange="NSE", order_type="STOP_LOSS_MARKET", quantity=10)

    error = live_broker.modify_resting_order_scheduled(db, uuid.uuid4(), order, 97.0)

    assert error is not None
    assert db.commits == 0


def test_cancel_resting_order_scheduled_marks_cancelled(monkeypatch):
    monkeypatch.setattr(live_broker, "cancel_broker_order_internal", lambda **kwargs: {"orderId": "dhan-sl-1"})
    db = FakeDb()
    order = db_models.BrokerOrder(broker_order_id="dhan-sl-1", exchange="NSE", order_type="STOP_LOSS_MARKET", quantity=10, status="pending")

    error = live_broker.cancel_resting_order_scheduled(db, uuid.uuid4(), order)

    assert error is None
    assert order.status == "cancelled"


def test_cancel_resting_order_scheduled_reports_failure_without_raising(monkeypatch):
    def _boom(**kwargs):
        raise RuntimeError("already filled, cannot cancel")

    monkeypatch.setattr(live_broker, "cancel_broker_order_internal", _boom)
    db = FakeDb()
    order = db_models.BrokerOrder(broker_order_id="dhan-sl-1", exchange="NSE", order_type="STOP_LOSS_MARKET", quantity=10, status="pending")

    error = live_broker.cancel_resting_order_scheduled(db, uuid.uuid4(), order)

    assert error is not None
    assert order.status == "pending"  # unchanged - a failed cancel must not lie about the state


def test_submit_entry_order_scheduled_opens_a_new_position_via_internal_route(monkeypatch):
    """Live-broker-adapter P3 item 14 - the ONE case where a scheduler-
    style (no live request) submission is allowed to be an ENTRY, not
    just a close - the automated Strategy-driven flow (open_position,
    called from orders_consumer.py's Redis consumer, no HTTP request at
    all)."""
    calls = []

    def _tracking_internal(**kwargs):
        calls.append(kwargs)
        return {"orderId": "dhan-entry-1"}

    monkeypatch.setattr(live_broker, "place_broker_order_internal", _tracking_internal)
    db = FakeDb(status_sequence=["traded"])

    order, error = live_broker.submit_entry_order_scheduled(db, uuid.uuid4(), "NSE", "RELIANCE", "BUY", 10)

    assert error is None
    assert order.status == "traded"
    assert order.purpose == "entry"
    assert order.position_id is None  # no Position exists yet - created only once this confirms TRADED
    assert calls[0]["transaction_type"] == "BUY"


def test_submit_resting_stop_loss_scheduled_does_not_wait_for_a_fill(monkeypatch):
    monkeypatch.setattr(live_broker, "place_broker_order_internal", lambda **kwargs: {"orderId": "dhan-sl-2"})
    db = FakeDb()

    order, error = live_broker.submit_resting_stop_loss_scheduled(
        db, uuid.uuid4(), uuid.uuid4(), "NSE", "RELIANCE", "SELL", 10, trigger_price=95.0,
    )

    assert error is None
    assert order.status == "pending"
    assert order.purpose == "stop_loss"
    assert order.order_type == "STOP_LOSS_MARKET"
