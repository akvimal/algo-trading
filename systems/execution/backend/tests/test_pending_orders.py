"""Server-side pending (limit) orders (app/domain/pending_orders.py,
app/api/routes/pending_orders.py, the scheduler job).

The logic is tested with a small in-memory session that really evaluates the
SQLAlchemy filters the code builds, and injected fakes for the price feed and
the order placement, so no market-data or broker is needed."""

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.sql import operators

from app.adapters.db import models as db_models
from app.api.routes import pending_orders as route
from app.auth import User
from app.config import settings
from app.domain import pending_orders as po
from app.domain.models import PendingOrderCreate, PendingOrderUpdate
from app.domain.pending_orders import (
    Deps, PendingOrderError, UnderlyingUnavailable, UnknownUnderlying, bracket_problem, cancel_pending_order, create_pending_order,
    crossed, list_pending_orders, process_pending_orders, update_pending_order,
)

ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
BOB = uuid.UUID("22222222-2222-2222-2222-222222222222")
NOW = datetime(2026, 9, 25, 6, 0, tzinfo=timezone.utc)
P = db_models.PendingOrder


# --- the pure rules --------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "started_above, trigger, ltp, expected",
    [
        (True, 100, 100, True), (True, 100, 99.9, True), (True, 100, 100.1, False),  # from above: fires on falling to it
        (False, 100, 100, True), (False, 100, 100.1, True), (False, 100, 99.9, False),  # from below: fires on rising to it
    ],
)
def test_the_crossing_rule_matches_the_frontends(started_above, trigger, ltp, expected):
    assert crossed(started_above, trigger, ltp) is expected


@pytest.mark.parametrize(
    "action, stop, target, ok",
    [
        ("BUY", 95, 110, True), ("BUY", 105, None, False), ("BUY", None, 90, False), ("BUY", None, None, True),
        ("SELL", 105, 90, True), ("SELL", 95, None, False), ("SELL", None, 110, False),
    ],
)
def test_the_bracket_must_put_the_stop_on_the_losing_side_and_the_target_on_the_winning_side(action, stop, target, ok):
    assert (bracket_problem(action, 100, stop, target) is None) is ok


def test_a_client_cannot_choose_the_starting_side_or_the_status():
    body = PendingOrderCreate(segment="NSE", symbol="NIFTY", action="BUY", trigger_price=100)
    assert "started_above" not in body.model_dump() and "status" not in body.model_dump()


@pytest.mark.parametrize("bad", [dict(trigger_price=0), dict(trigger_price=-1), dict(quantity=0), dict(confidence=6), dict(expires_in_minutes=0), dict(symbol="")])
def test_the_request_is_validated(bad):
    with pytest.raises(ValidationError):
        PendingOrderCreate(**{**dict(segment="NSE", symbol="NIFTY", action="BUY", trigger_price=100), **bad})


# --- a small session that evaluates the real filters ----------------------------------------------------------------------


def _matches(row, c):
    key, op = c.left.key, c.operator
    value = getattr(c.right, "value", None)
    current = getattr(row, key)
    if op is operators.eq:
        return current == value
    if op is operators.le:
        return current <= value
    raise AssertionError(f"fake session cannot evaluate {op}")


class FakeQuery:
    def __init__(self, rows):
        self.rows = list(rows)

    def filter(self, *criteria):
        return FakeQuery(r for r in self.rows if all(_matches(r, c) for c in criteria))

    def order_by(self, clause):
        return FakeQuery(sorted(self.rows, key=lambda r: getattr(r, clause.element.key), reverse="DESC" in str(clause)))

    def all(self):
        return list(self.rows)

    def update(self, values, synchronize_session=False):
        """A conditional bulk UPDATE: applies to the rows this query selects, returns the count."""
        for r in self.rows:
            for column, value in values.items():
                setattr(r, column.key, value)
        return len(self.rows)


class FakeDb:
    def __init__(self):
        self.rows = []
        self.commits = 0
        self.rollbacks = 0

    def query(self, model):
        assert model is P
        return FakeQuery(self.rows)

    def get(self, model, key):
        return next((r for r in self.rows if r.id == key), None)

    def add(self, row):
        if row.id is None:
            row.id = uuid.uuid4()
        if row.created_at is None:
            row.created_at = NOW + timedelta(seconds=len(self.rows))
        self.rows.append(row)

    def flush(self):
        pass

    def refresh(self, row):
        pass

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def fake_deps(prices=None, **over):
    """`prices`: {(segment, symbol): price | Exception}. Records what was called."""
    prices = prices if prices is not None else {}
    log = SimpleNamespace(price_calls=[], futures=[], options=[], stops=[], targets=[])

    def underlying_ltp(segment, symbol, token=None, owner=None):
        log.price_calls.append((segment, symbol))
        v = prices.get((segment, symbol), UnknownUnderlying(symbol))
        if isinstance(v, Exception):
            raise v
        return v

    def open_future(db, order, exec_settings):
        log.futures.append((order.status, db.commits, order.symbol))
        return SimpleNamespace(id=uuid.uuid4(), status="OPEN", rejection_reason=None)

    def open_option(db, order, exec_settings):
        log.options.append((order.status, order.symbol, order.strategy, order.moneyness))
        return SimpleNamespace(id=uuid.uuid4(), status="OPEN", rejection_reason=None)

    deps = Deps(
        underlying_ltp=underlying_ltp, open_future=open_future, open_option=open_option,
        set_spot_stop=lambda db, uid, gid, price: log.stops.append((gid, price)),
        set_spot_target=lambda db, uid, gid, price: log.targets.append((gid, price)),
    )
    for k, v in over.items():
        setattr(deps, k, v)
    deps.log = log
    return deps


def body(**over):
    return PendingOrderCreate(**{**dict(segment="NSE", symbol="nifty", action="BUY", trigger_price=100.0), **over})


def arm(db, deps, live=False, uid=ALICE, **over):
    return create_pending_order(db, uid, body(**over), deps, live, now=NOW)


@pytest.fixture(autouse=True)
def account_state(monkeypatch):
    """The watcher's account/settings lookups (imported at call time inside _place)."""
    state = {"live": False}
    from app.domain import position_manager as pm

    monkeypatch.setattr(pm, "load_account", lambda db, uid, seg: SimpleNamespace(live_trading_enabled=state["live"]))
    monkeypatch.setattr(pm, "load_settings", lambda db, uid: SimpleNamespace())
    return state


# --- arming ---------------------------------------------------------------------------------------------------------------


def test_arming_records_the_starting_side_from_the_servers_own_price():
    db = FakeDb()
    above = arm(db, fake_deps({("NSE", "NIFTY"): 105.0}))
    assert above.started_above is True and float(above.last_price) == 105.0
    below = arm(FakeDb(), fake_deps({("NSE", "NIFTY"): 95.0}))
    assert below.started_above is False


def test_the_symbol_is_normalised_and_the_default_expiry_is_24_hours():
    row = arm(FakeDb(), fake_deps({("NSE", "NIFTY"): 105.0}))
    assert row.symbol == "NIFTY" and row.status == "pending"
    assert row.expires_at == NOW + timedelta(minutes=settings.pending_order_default_ttl_minutes)


def test_an_explicit_expiry_is_used_and_capped():
    deps = fake_deps({("NSE", "NIFTY"): 105.0})
    assert arm(FakeDb(), deps, expires_in_minutes=30).expires_at == NOW + timedelta(minutes=30)
    with pytest.raises(PendingOrderError) as exc:
        arm(FakeDb(), deps, expires_in_minutes=settings.pending_order_max_ttl_minutes + 1)
    assert exc.value.status_code == 422


def test_a_live_account_cannot_arm_a_server_order():
    db = FakeDb()
    with pytest.raises(PendingOrderError) as exc:
        arm(db, fake_deps({("NSE", "NIFTY"): 105.0}), live=True)
    assert exc.value.status_code == 409 and "paper-only" in exc.value.detail and db.rows == []


def test_a_bad_bracket_is_refused_before_any_price_is_fetched():
    deps = fake_deps({("NSE", "NIFTY"): 105.0})
    with pytest.raises(PendingOrderError) as exc:
        arm(FakeDb(), deps, action="BUY", stop_loss_price=120.0)
    assert exc.value.status_code == 422 and deps.log.price_calls == []


def test_a_price_exactly_at_the_trigger_is_refused_as_a_market_order():
    with pytest.raises(PendingOrderError) as exc:
        arm(FakeDb(), fake_deps({("NSE", "NIFTY"): 100.0}))
    assert exc.value.status_code == 422 and "market order" in exc.value.detail


def test_an_unknown_symbol_is_a_404_and_no_price_is_a_503():
    with pytest.raises(PendingOrderError) as exc:
        arm(FakeDb(), fake_deps({}))
    assert exc.value.status_code == 404
    with pytest.raises(PendingOrderError) as exc:
        arm(FakeDb(), fake_deps({("NSE", "NIFTY"): UnderlyingUnavailable("timeout")}))
    assert exc.value.status_code == 503


def test_arming_again_for_the_same_symbol_replaces_the_old_order():
    db = FakeDb()
    deps = fake_deps({("NSE", "NIFTY"): 105.0, ("NSE", "BANKNIFTY"): 500.0})
    first = arm(db, deps)
    other = arm(db, deps, symbol="BANKNIFTY", trigger_price=490.0)
    second = arm(db, deps, trigger_price=99.0)
    assert (first.status, first.status_reason) == ("cancelled", "replaced by a newer order for the same symbol")
    assert second.status == "pending" and other.status == "pending"


def test_the_per_user_limit_counts_other_symbols_but_a_replacement_is_always_allowed(monkeypatch):
    monkeypatch.setattr(settings, "max_pending_orders_per_user", 2)
    db = FakeDb()
    deps = fake_deps({("NSE", s): 105.0 for s in ("A", "B", "C")})
    arm(db, deps, symbol="A")
    arm(db, deps, symbol="B")
    with pytest.raises(PendingOrderError) as exc:
        arm(db, deps, symbol="C")
    assert exc.value.status_code == 422 and "too many" in exc.value.detail
    assert arm(db, deps, symbol="A", trigger_price=99.0).status == "pending"  # replacing is not adding


def test_the_limit_is_per_user():
    db = FakeDb()
    deps = fake_deps({("NSE", "NIFTY"): 105.0})
    arm(db, deps, uid=ALICE)
    arm(db, deps, uid=BOB)  # same symbol, different user: both stand
    assert len([r for r in db.rows if r.status == "pending"]) == 2


def test_option_orders_keep_their_moneyness_and_futures_do_not():
    deps = fake_deps({("NSE", "NIFTY"): 105.0})
    assert arm(FakeDb(), deps, strategy="spread", moneyness="OTM1").moneyness == "OTM1"
    assert arm(FakeDb(), deps, strategy="future", moneyness="OTM1").moneyness is None


# --- cancelling and listing -----------------------------------------------------------------------------------------------------


def test_cancel_finds_only_your_own_pending_order():
    db = FakeDb()
    row = arm(db, fake_deps({("NSE", "NIFTY"): 105.0}))
    assert cancel_pending_order(db, BOB, row.id) is None  # someone else's: indistinguishable from missing
    assert cancel_pending_order(db, ALICE, uuid.uuid4()) is None
    out = cancel_pending_order(db, ALICE, row.id)
    assert (out.status, out.status_reason) == ("cancelled", "cancelled by you")
    with pytest.raises(PendingOrderError) as exc:
        cancel_pending_order(db, ALICE, row.id)
    assert exc.value.status_code == 409


def test_a_cancel_that_loses_the_race_does_not_overwrite_an_order_that_just_fired():
    db = FakeDb()
    row = arm(db, fake_deps({("NSE", "NIFTY"): 105.0}))
    real_get = db.get

    def get_then_lose_the_race(model, key):
        found = real_get(model, key)
        found.status = "triggered"  # the watcher claims it after our read, before our UPDATE
        return found

    db.get = get_then_lose_the_race
    with pytest.raises(PendingOrderError) as exc:
        cancel_pending_order(db, ALICE, row.id)
    assert exc.value.status_code == 409 and "already triggered" in exc.value.detail
    assert row.status == "triggered"  # not overwritten with 'cancelled'


def test_moving_a_waiting_order_changes_only_what_was_sent_and_checks_the_levels_still_make_sense_together():
    db = FakeDb()
    deps = fake_deps({("NSE", "NIFTY"): 105.0})
    row = arm(db, deps, trigger_price=100.0, stop_loss_price=95.0, target_price=110.0)
    out = update_pending_order(db, ALICE, row.id, deps, stop_loss_price=96.0)
    assert (float(out.trigger_price), float(out.stop_loss_price), float(out.target_price)) == (100.0, 96.0, 110.0)
    assert len(deps.log.price_calls) == 1  # only the arming read the price: a stop move needs no price
    for kwargs, fragment in [({"stop_loss_price": 101.0}, "stop-loss must be below"), ({"target_price": 99.0}, "target must be above"), ({"trigger_price": 94.0}, "stop-loss must be below")]:
        with pytest.raises(PendingOrderError) as exc:
            update_pending_order(db, ALICE, row.id, deps, **kwargs)
        assert exc.value.status_code == 422 and fragment in exc.value.detail
    assert (float(row.trigger_price), float(row.stop_loss_price)) == (100.0, 96.0)  # a refused move changes nothing


def test_moving_the_trigger_reads_the_price_again_and_works_out_the_starting_side_against_the_new_level():
    db = FakeDb()
    deps = fake_deps({("NSE", "NIFTY"): 105.0})
    row = arm(db, deps, trigger_price=100.0)  # armed from above: fires on the fall to 100
    assert row.started_above is True
    out = update_pending_order(db, ALICE, row.id, deps, trigger_price=110.0)  # moved above the price: now fires on the rise
    assert float(out.trigger_price) == 110.0 and out.started_above is False and out.last_price == 105.0
    assert len(deps.log.price_calls) == 2
    with pytest.raises(PendingOrderError) as exc:
        update_pending_order(db, ALICE, row.id, deps, trigger_price=105.0)  # the price is already there
    assert exc.value.status_code == 422 and "market order" in exc.value.detail


def test_a_move_finds_only_your_own_waiting_order_and_refuses_one_that_has_gone():
    db = FakeDb()
    deps = fake_deps({("NSE", "NIFTY"): 105.0})
    row = arm(db, deps, trigger_price=100.0, stop_loss_price=95.0)
    assert update_pending_order(db, BOB, row.id, deps, stop_loss_price=96.0) is None
    assert update_pending_order(db, ALICE, uuid.uuid4(), deps, stop_loss_price=96.0) is None
    assert update_pending_order(db, ALICE, row.id, deps) is row  # nothing to change
    cancel_pending_order(db, ALICE, row.id)
    with pytest.raises(PendingOrderError) as exc:
        update_pending_order(db, ALICE, row.id, deps, stop_loss_price=96.0)
    assert exc.value.status_code == 409 and "already cancelled" in exc.value.detail


def test_a_move_that_loses_the_race_to_the_watcher_does_not_change_an_order_that_just_fired():
    db = FakeDb()
    deps = fake_deps({("NSE", "NIFTY"): 105.0})
    row = arm(db, deps, trigger_price=100.0, stop_loss_price=95.0)
    real_get = db.get

    def get_then_lose_the_race(model, key):
        found = real_get(model, key)
        found.status = "triggered"  # the watcher claims it after our read, before our UPDATE
        return found

    db.get = get_then_lose_the_race
    with pytest.raises(PendingOrderError) as exc:
        update_pending_order(db, ALICE, row.id, deps, stop_loss_price=96.0)
    assert exc.value.status_code == 409 and float(row.stop_loss_price) == 95.0


def test_moving_the_trigger_maps_a_price_that_cannot_be_read():
    db = FakeDb()
    deps = fake_deps({("NSE", "NIFTY"): 105.0})
    row = arm(db, deps, trigger_price=100.0)
    deps.underlying_ltp = lambda *a, **k: (_ for _ in ()).throw(UnderlyingUnavailable("feed down"))
    with pytest.raises(PendingOrderError) as exc:
        update_pending_order(db, ALICE, row.id, deps, trigger_price=101.0)
    assert exc.value.status_code == 503 and float(row.trigger_price) == 100.0


def test_list_is_scoped_filtered_and_newest_first():
    db = FakeDb()
    deps = fake_deps({("NSE", "NIFTY"): 105.0, ("NSE", "TCS"): 105.0})
    a = arm(db, deps, symbol="NIFTY")
    b = arm(db, deps, symbol="TCS")
    arm(db, deps, uid=BOB)
    cancel_pending_order(db, ALICE, a.id)
    assert [r.symbol for r in list_pending_orders(db, ALICE)] == ["TCS", "NIFTY"]
    assert [r.symbol for r in list_pending_orders(db, ALICE, status="pending")] == ["TCS"]
    assert all(r.user_id == ALICE for r in list_pending_orders(db, ALICE))
    assert b in list_pending_orders(db, ALICE, limit=1)


# --- the watcher ------------------------------------------------------------------------------------------------------------------


def armed(db, prices, **over):
    return arm(db, fake_deps(prices), **over)


def run(db, prices, now=NOW + timedelta(minutes=1), **deps_over):
    deps = fake_deps(prices, **deps_over)
    return process_pending_orders(db, deps, now=now), deps


def test_an_order_below_the_price_fires_when_it_falls_to_the_trigger_and_opens_a_position():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0}, stop_loss_price=95.0, target_price=120.0)
    counts, deps = run(db, {("NSE", "NIFTY"): 105.0})
    assert counts["triggered"] == 0 and row.status == "pending"  # not yet
    counts, deps = run(db, {("NSE", "NIFTY"): 99.5})
    assert counts["triggered"] == 1 and row.status == "triggered" and row.position_id is not None
    assert row.triggered_at is not None and len(deps.log.futures) == 1


def test_an_order_armed_from_below_fires_on_the_rise():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 95.0})
    run(db, {("NSE", "NIFTY"): 99.0})
    assert row.status == "pending"
    run(db, {("NSE", "NIFTY"): 100.5})
    assert row.status == "triggered"


def test_the_order_is_claimed_before_it_is_placed_so_it_can_never_place_twice():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0})
    _, deps = run(db, {("NSE", "NIFTY"): 99.0})
    status_at_placement, commits_at_placement, _ = deps.log.futures[0]
    assert status_at_placement == "triggered" and commits_at_placement >= 1  # claimed and committed first
    counts, deps2 = run(db, {("NSE", "NIFTY"): 99.0})  # the next tick
    assert deps2.log.futures == [] and counts["triggered"] == 0


def test_an_order_cancelled_or_claimed_elsewhere_after_the_price_read_is_not_placed():
    """The claim is a conditional UPDATE: if another worker (or a cancel) already moved the
    order out of 'pending', this worker's claim matches nothing and it places nothing."""
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0})
    deps = fake_deps({("NSE", "NIFTY"): 99.0})
    price = deps.underlying_ltp

    def price_then_someone_else_takes_it(segment, symbol):
        value = price(segment, symbol)
        row.status = "cancelled"  # a cancel (or a second worker) lands after we read the price
        return value

    deps.underlying_ltp = price_then_someone_else_takes_it
    counts = process_pending_orders(db, deps, now=NOW + timedelta(minutes=1))
    assert deps.log.futures == [] and counts["triggered"] == 0 and row.status == "cancelled"


def test_a_crash_while_placing_fails_the_order_and_does_not_retry_it():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0})

    def boom(db, order, s):
        raise RuntimeError("market-data down")

    counts, _ = run(db, {("NSE", "NIFTY"): 99.0}, open_future=boom)
    assert counts["failed"] == 1 and row.status == "failed" and "market-data down" in row.status_reason and db.rollbacks == 1
    counts, deps = run(db, {("NSE", "NIFTY"): 99.0})
    assert deps.log.futures == []  # never placed a second time


def test_a_position_that_execution_rejects_is_reported_as_rejected_with_its_reason():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0})
    rejected = SimpleNamespace(id=uuid.uuid4(), status="REJECTED", rejection_reason="stop-loss required")
    counts, _ = run(db, {("NSE", "NIFTY"): 99.0}, open_future=lambda db, o, s: rejected)
    assert counts["rejected"] == 1 and (row.status, row.status_reason, row.position_id) == ("rejected", "stop-loss required", rejected.id)


def test_option_orders_open_a_group_then_attach_the_spot_stop_and_target():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0}, strategy="naked", moneyness="ITM1", stop_loss_price=95.0, target_price=120.0)
    _, deps = run(db, {("NSE", "NIFTY"): 99.0})
    assert row.status == "triggered" and row.option_group_id is not None and row.position_id is None
    assert deps.log.options == [("triggered", "NIFTY", "naked", "ITM1")]
    assert deps.log.stops == [(row.option_group_id, 95.0)] and deps.log.targets == [(row.option_group_id, 120.0)]


def test_a_failed_stop_attach_is_a_warning_not_a_failure():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0}, strategy="spread", stop_loss_price=95.0, target_price=120.0)

    def bad_stop(db, uid, gid, price):
        raise RuntimeError("nope")

    _, deps = run(db, {("NSE", "NIFTY"): 99.0}, set_spot_stop=bad_stop)
    assert row.status == "triggered" and "stop-loss did not attach" in row.status_reason
    assert len(deps.log.targets) == 1  # the target still went on


def test_a_rejected_option_group_does_not_get_a_stop_or_target():
    db = FakeDb()
    armed(db, {("NSE", "NIFTY"): 105.0}, strategy="naked", stop_loss_price=95.0)
    rejected = SimpleNamespace(id=uuid.uuid4(), status="REJECTED", rejection_reason="no liquidity")
    _, deps = run(db, {("NSE", "NIFTY"): 99.0}, open_option=lambda db, o, s: rejected)
    assert deps.log.stops == []


def test_an_account_that_went_live_while_armed_fails_the_order_instead_of_trading_real_money(account_state):
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0})
    account_state["live"] = True
    counts, deps = run(db, {("NSE", "NIFTY"): 99.0})
    assert counts["failed"] == 1 and row.status == "failed" and "went live" in row.status_reason and deps.log.futures == []


def test_expired_orders_are_expired_and_never_fire():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0}, expires_in_minutes=5)
    counts, deps = run(db, {("NSE", "NIFTY"): 99.0}, now=NOW + timedelta(minutes=6))
    assert counts["expired"] == 1 and row.status == "expired" and deps.log.futures == [] and deps.log.price_calls == []


def test_a_missing_price_leaves_the_order_armed_for_the_next_tick():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0})
    counts, _ = run(db, {("NSE", "NIFTY"): UnderlyingUnavailable("timeout")})
    assert counts["no_price"] == 1 and row.status == "pending"
    counts, _ = run(db, {("NSE", "NIFTY"): 99.0})
    assert row.status == "triggered"


def test_each_underlying_is_priced_once_per_pass_however_many_orders_watch_it():
    db = FakeDb()
    armed(db, {("NSE", "NIFTY"): 105.0}, uid=ALICE)
    armed(db, {("NSE", "NIFTY"): 105.0}, uid=BOB, trigger_price=101.0)
    counts, deps = run(db, {("NSE", "NIFTY"): 99.5})  # crosses both triggers (100 and 101) from above
    assert deps.log.price_calls == [("NSE", "NIFTY")] and counts["triggered"] == 2


def test_the_last_seen_price_is_recorded_even_when_nothing_fires():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0})
    run(db, {("NSE", "NIFTY"): 103.0}, now=NOW + timedelta(minutes=2))
    assert float(row.last_price) == 103.0 and row.last_checked_at == NOW + timedelta(minutes=2)


def test_one_orders_failure_does_not_stop_the_others():
    db = FakeDb()
    armed(db, {("NSE", "NIFTY"): 105.0, ("NSE", "TCS"): 105.0}, symbol="NIFTY")
    armed(db, {("NSE", "TCS"): 105.0}, symbol="TCS")
    calls = []

    def flaky(db, order, s):
        calls.append(order.symbol)
        if order.symbol == "NIFTY":
            raise RuntimeError("boom")
        return SimpleNamespace(id=uuid.uuid4(), status="OPEN", rejection_reason=None)

    counts, _ = run(db, {("NSE", "NIFTY"): 99.0, ("NSE", "TCS"): 99.0}, open_future=flaky)
    assert counts["failed"] == 1 and counts["triggered"] == 1 and sorted(calls) == ["NIFTY", "TCS"]


# --- the real adapters wiring ------------------------------------------------------------------------------------------------------


def test_the_default_feed_resolves_once_then_prices_and_maps_failures(monkeypatch):
    from app.adapters.quotes import client as qc

    calls = {"resolve": 0}

    def resolve(segment, symbol):
        calls["resolve"] += 1
        return None if symbol == "NOPE" else {"chart_exchange": "NSE", "chart_symbol": f"{symbol}-SPOT"}

    monkeypatch.setattr(qc, "resolve_underlying", resolve)
    monkeypatch.setattr(qc, "get_ltp_batch", lambda exchange, symbols, token=None, on_behalf_of=None: {"NIFTY-SPOT": 24000.0} if symbols == ["NIFTY-SPOT"] else {})
    po._resolve_cache.clear()
    feed = po.default_deps().underlying_ltp
    assert feed("NSE", "NIFTY") == 24000.0 and feed("NSE", "NIFTY") == 24000.0 and calls["resolve"] == 1  # cached
    with pytest.raises(UnknownUnderlying):
        feed("NSE", "NOPE")
    with pytest.raises(UnderlyingUnavailable):
        feed("NSE", "TCS")  # resolves, but no price
    def down(*a, **k):
        raise RuntimeError("down")

    monkeypatch.setattr(qc, "get_ltp_batch", down)
    feed = po.default_deps().underlying_ltp  # default_deps() binds the adapters when it is called: rebuild after re-patching
    with pytest.raises(UnderlyingUnavailable):
        feed("NSE", "NIFTY")


def test_a_fired_future_is_placed_as_a_limit_order_at_the_trigger_price_with_no_user_token(monkeypatch):
    from app.domain import position_manager as pm

    seen = {}
    monkeypatch.setattr(pm, "open_manual_position", lambda *a, **k: seen.update(args=a, kwargs=k) or SimpleNamespace(status="OPEN"))
    order = SimpleNamespace(user_id=ALICE, segment="NSE", symbol="NIFTY", action="BUY", trigger_price=100, quantity=None, stop_loss_price=95,
                            target_price=120, trend_followed=True, risk_managed=True, setup_tag="pullback", confidence=4, entry_interval="5m")
    po.default_deps().open_future(FakeDb(), order, SimpleNamespace())
    a, k = seen["args"], seen["kwargs"]
    assert a[:8] == (ALICE, "NSE", "NIFTY", "BUY", "future", 100.0, None, 95.0)  # entry = the trigger, quantity left to risk-sizing
    assert k["order_type"] == "limit" and k["token"] is None and k["auto_traded"] is False
    assert (k["target_price"], k["trend_followed"], k["risk_managed"], k["setup_tag"], k["confidence"], k["entry_interval"]) == (120.0, True, True, "pullback", 4, "5m")


def test_a_fired_option_order_is_placed_as_a_limit_group_with_the_right_style(monkeypatch):
    from app.domain import option_position_manager as opm

    seen = {}
    monkeypatch.setattr(opm, "open_manual_option_group", lambda *a, **k: seen.update(args=a, kwargs=k) or SimpleNamespace(status="OPEN"))
    order = SimpleNamespace(user_id=ALICE, segment="NSE", symbol="NIFTY", action="BUY", strategy="spread", moneyness="OTM1", quantity=2,
                            trend_followed=False, risk_managed=False, setup_tag=None, confidence=None, entry_interval=None)
    po.default_deps().open_option(FakeDb(), order, SimpleNamespace())
    a, k = seen["args"], seen["kwargs"]
    assert a[:9] == (ALICE, "NSE", "NIFTY", "BUY", "spread", "OTM1", None, "combined", 2.0)
    assert k["order_type"] == "limit" and k["auto_traded"] is False
    order.strategy = "naked"
    po.default_deps().open_option(FakeDb(), order, SimpleNamespace())
    assert seen["args"][4] == "naked"


# --- the routes and the job --------------------------------------------------------------------------------------------------------------


def me(uid=ALICE):
    return User(id=uid, token="t", is_admin=False)


@pytest.fixture
def route_env(monkeypatch):
    db = FakeDb()
    deps = fake_deps({("NSE", "NIFTY"): 105.0})
    monkeypatch.setattr(route, "default_deps", lambda: deps)
    state = {"live": False}
    monkeypatch.setattr(route, "load_account", lambda db, uid, seg: SimpleNamespace(live_trading_enabled=state["live"]))
    return db, state


def test_the_arm_route_returns_the_order_and_maps_errors(route_env):
    db, state = route_env
    out = route.arm_pending_order(body(), user=me(), db=db)
    assert out.status == "pending" and out.symbol == "NIFTY" and out.started_above is True and out.trigger_price == 100.0
    state["live"] = True
    with pytest.raises(HTTPException) as exc:
        route.arm_pending_order(body(symbol="TCS"), user=me(), db=db)
    assert exc.value.status_code == 409


def test_the_list_and_cancel_routes(route_env):
    db, _ = route_env
    created = route.arm_pending_order(body(), user=me(), db=db)
    assert [o.id for o in route.list_orders(status=None, limit=100, user=me(), db=db)] == [created.id]
    assert route.list_orders(status="cancelled", limit=100, user=me(), db=db) == []
    with pytest.raises(HTTPException) as exc:
        route.list_orders(status="bogus", limit=100, user=me(), db=db)
    assert exc.value.status_code == 422
    with pytest.raises(HTTPException) as exc:
        route.cancel_order(created.id, user=me(BOB), db=db)  # someone else's
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:
        route.cancel_order("not-a-uuid", user=me(), db=db)
    assert exc.value.status_code == 404
    assert route.cancel_order(created.id, user=me(), db=db).status == "cancelled"
    with pytest.raises(HTTPException) as exc:
        route.cancel_order(created.id, user=me(), db=db)
    assert exc.value.status_code == 409


def test_the_move_route_changes_the_levels_and_maps_the_errors(route_env):
    db, _ = route_env
    created = route.arm_pending_order(body(stop_loss_price=95.0), user=me(), db=db)
    out = route.move_order(created.id, PendingOrderUpdate(stop_loss_price=97.0, target_price=120.0), user=me(), db=db)
    assert (out.stop_loss_price, out.target_price, out.trigger_price) == (97.0, 120.0, 100.0)
    with pytest.raises(HTTPException) as exc:
        route.move_order(created.id, PendingOrderUpdate(stop_loss_price=101.0), user=me(), db=db)
    assert exc.value.status_code == 422
    with pytest.raises(HTTPException) as exc:
        route.move_order(created.id, PendingOrderUpdate(stop_loss_price=96.0), user=me(BOB), db=db)  # someone else's
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:
        route.move_order("not-a-uuid", PendingOrderUpdate(), user=me(), db=db)
    assert exc.value.status_code == 404
    route.cancel_order(created.id, user=me(), db=db)
    with pytest.raises(HTTPException) as exc:
        route.move_order(created.id, PendingOrderUpdate(stop_loss_price=96.0), user=me(), db=db)
    assert exc.value.status_code == 409
    for bad in ({"trigger_price": 0}, {"stop_loss_price": -1}):
        with pytest.raises(ValidationError):
            PendingOrderUpdate(**bad)


@pytest.mark.parametrize("method, path", [("POST", "/pending-orders"), ("GET", "/pending-orders"), ("PATCH", f"/pending-orders/{uuid.uuid4()}"), ("DELETE", f"/pending-orders/{uuid.uuid4()}")])
def test_every_route_needs_a_login(method, path):
    from fastapi.testclient import TestClient

    from app.main import app

    assert TestClient(app).request(method, path, json={}).status_code == 401


def test_the_scheduler_registers_the_job_and_zero_disables_it(monkeypatch):
    from app import scheduler

    added = []
    monkeypatch.setattr(scheduler._scheduler, "add_job", lambda fn, trigger, **kw: added.append(kw["id"]))
    monkeypatch.setattr(scheduler._scheduler, "start", lambda: None)
    monkeypatch.setattr(scheduler.settings, "pending_order_poll_seconds", 10)
    scheduler.start_scheduler()
    assert "pending-orders" in added
    added.clear()
    monkeypatch.setattr(scheduler.settings, "pending_order_poll_seconds", 0)
    scheduler.start_scheduler()
    assert "pending-orders" not in added


# --- stacking: a waiting order must not quietly open a second position --------------------------------------------------------------


def test_a_fired_order_is_skipped_when_the_person_already_holds_that_instrument():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0})
    counts, deps = run(db, {("NSE", "NIFTY"): 99.5}, holds_open=lambda db_, uid, seg, sym: "1 open NIFTY position")
    assert counts["skipped"] == 1 and counts["triggered"] == 0
    assert row.status == "cancelled" and "already hold 1 open NIFTY position" in row.status_reason
    assert deps.log.futures == [] and deps.log.options == []  # nothing was placed


def test_allow_stacking_lets_it_add_to_an_open_position_on_purpose():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0}, allow_stacking=True)
    assert row.allow_stacking is True
    counts, deps = run(db, {("NSE", "NIFTY"): 99.5}, holds_open=lambda *a: "1 open NIFTY position")
    assert counts["triggered"] == 1 and row.status == "triggered" and len(deps.log.futures) == 1


def test_it_fires_normally_when_nothing_is_open_and_the_default_is_not_to_stack():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0})
    assert row.allow_stacking is False
    counts, _ = run(db, {("NSE", "NIFTY"): 99.5}, holds_open=lambda *a: None)
    assert counts["triggered"] == 1 and row.status == "triggered"


def test_the_holding_is_looked_up_for_the_orders_own_owner_segment_and_symbol():
    db = FakeDb()
    armed(db, {("NSE", "NIFTY"): 105.0}, symbol="nifty")
    seen = []
    run(db, {("NSE", "NIFTY"): 99.5}, holds_open=lambda db_, uid, seg, sym: seen.append((uid, seg, sym)))
    assert seen == [(ALICE, "NSE", "NIFTY")]


def test_the_check_only_runs_once_the_price_is_actually_hit():
    db = FakeDb()
    armed(db, {("NSE", "NIFTY"): 105.0})
    seen = []
    run(db, {("NSE", "NIFTY"): 104.0}, holds_open=lambda *a: seen.append(a))
    assert seen == []


def test_a_skip_that_loses_the_race_to_a_cancel_changes_nothing_more():
    db = FakeDb()
    row = armed(db, {("NSE", "NIFTY"): 105.0})

    def cancel_then_report(db_, uid, seg, sym):
        row.status, row.status_reason = "cancelled", "cancelled by you"
        return "1 open NIFTY position"

    counts, _ = run(db, {("NSE", "NIFTY"): 99.5}, holds_open=cancel_then_report)
    assert row.status_reason == "cancelled by you" and counts["skipped"] == 0


class _HoldingsQuery:
    def __init__(self, rows):
        self.rows = rows

    def filter(self, *_):
        return self  # the SQL filters are the database's job (checked live); this covers the Python-side matching

    def all(self):
        return list(self.rows)


class _HoldingsDb:
    def __init__(self, positions, groups):
        self.by_model = {db_models.Position: positions, db_models.OptionPositionGroup: groups}

    def query(self, model):
        return _HoldingsQuery(self.by_model[model])


def _pos(symbol):
    return SimpleNamespace(symbol=symbol)


def test_holds_open_position_counts_contracts_of_the_underlying_and_option_groups_but_not_lookalikes():
    db = _HoldingsDb([_pos("NIFTY-Oct2026-FUT"), _pos("nifty"), _pos("BANKNIFTY-Oct2026-FUT"), _pos("NIFTYIT")], [SimpleNamespace()])
    assert po.holds_open_position(db, ALICE, "NSE", "nifty") == "3 open NIFTY positions"


def test_holds_open_position_is_none_when_nothing_matches_and_singular_for_one():
    assert po.holds_open_position(_HoldingsDb([_pos("BANKNIFTY-Oct2026-FUT")], []), ALICE, "NSE", "NIFTY") is None
    assert po.holds_open_position(_HoldingsDb([], [SimpleNamespace()]), ALICE, "NSE", "NIFTY") == "1 open NIFTY position"
