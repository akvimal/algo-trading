"""Balance and equity history (app/domain/equity_history.py, the scheduled job,
the reset hooks in app/api/routes/accounts.py, GET /equity-history/{segment}).

The statistics are pure and tested directly. Recording is tested with a small
in-memory fake session that really evaluates the SQLAlchemy filter expressions
the code builds, so a wrong filter shows up as a wrong result rather than being
silently ignored. Same "plain fakes" convention as the rest of this backend."""

import uuid
from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.sql import operators

from app.adapters.db import models as db_models
from app.api.routes import accounts as accounts_route
from app.api.routes import equity_history as history_route
from app.auth import User
from app.domain import equity_history as eh
from app.domain.equity_history import EquityPoint, compute_equity_stats, record_equity_snapshots, record_reset_point
from app.domain.models import AccountUpdate

ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
BOB = uuid.UUID("22222222-2222-2222-2222-222222222222")
Snap = db_models.AccountEquitySnapshot


def day(n):
    return date(2026, 9, n)


def pt(n, equity, *, start=100000.0, reset=False):
    return EquityPoint(day=day(n), starting_balance=start, balance=equity, unrealized_pnl=0.0, equity=equity, is_reset_point=reset)


# --- statistics ----------------------------------------------------------------------------------


def test_no_history_has_no_stats():
    assert compute_equity_stats([]) is None


def test_return_peak_and_drawdown():
    stats = compute_equity_stats([pt(1, 100000, reset=True), pt(2, 110000), pt(3, 99000), pt(4, 105000)])
    assert stats.baseline == 100000 and stats.latest_equity == 105000
    assert stats.return_pct == pytest.approx(5.0)
    assert stats.peak_equity == 110000
    assert stats.max_drawdown_pct == pytest.approx(10.0)  # 110000 -> 99000
    assert (stats.since, stats.days_tracked, stats.points) == (day(1), 4, 4)


def test_a_curve_that_only_loses_still_shows_a_drawdown_from_its_baseline():
    stats = compute_equity_stats([pt(1, 100000, reset=True), pt(2, 95000)])
    assert stats.peak_equity == 100000 and stats.max_drawdown_pct == pytest.approx(5.0)
    assert stats.return_pct == pytest.approx(-5.0)


def test_a_reset_starts_a_new_curve_and_earlier_losses_do_not_count():
    points = [pt(1, 100000, reset=True), pt(2, 60000), pt(3, 50000), pt(4, 200000, start=200000, reset=True), pt(5, 210000, start=200000)]
    stats = compute_equity_stats(points)
    assert stats.since == day(4) and stats.baseline == 200000 and stats.points == 2
    assert stats.max_drawdown_pct == 0.0 and stats.return_pct == pytest.approx(5.0)


def test_with_no_reset_marker_the_baseline_is_the_first_rows_starting_balance():
    stats = compute_equity_stats([pt(1, 101000), pt(2, 103000)])
    assert stats.baseline == 100000 and stats.since == day(1)


def test_a_zero_baseline_does_not_divide_by_zero():
    stats = compute_equity_stats([pt(1, 0.0, start=0.0, reset=True)])
    assert stats.return_pct == 0.0 and stats.max_drawdown_pct == 0.0


# --- a tiny session that really evaluates filter expressions ------------------------------------------


def _matches(row, criterion):
    key, op = criterion.left.key, criterion.operator
    value = getattr(criterion.right, "value", None)
    current = getattr(row, key)
    if op is operators.is_not:
        return current is not None
    if op is operators.eq:
        return current == value
    if op is operators.lt:
        return current < value
    raise AssertionError(f"fake session cannot evaluate operator {op}")


class FakeQuery:
    def __init__(self, rows):
        self.rows = list(rows)

    def filter(self, *criteria):
        return FakeQuery(r for r in self.rows if all(_matches(r, c) for c in criteria))

    def filter_by(self, **kw):
        return FakeQuery(r for r in self.rows if all(getattr(r, k) == v for k, v in kw.items()))

    def order_by(self, clause):
        return FakeQuery(sorted(self.rows, key=lambda r: getattr(r, clause.element.key), reverse="DESC" in str(clause)))

    def first(self):
        return self.rows[0] if self.rows else None

    def all(self):
        return list(self.rows)


class FakeDb:
    def __init__(self, accounts=(), positions=(), snapshots=()):
        self.tables = {db_models.Account: list(accounts), db_models.Position: list(positions), Snap: list(snapshots)}
        self.commits = 0
        self.rollbacks = 0
        self.fail_next_commit = False

    def query(self, model):
        return FakeQuery(self.tables[model])

    def add(self, row):
        self.tables[type(row)].append(row)

    def commit(self):
        if self.fail_next_commit:
            self.fail_next_commit = False
            raise RuntimeError("boom")
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def snapshots(self):
        return self.tables[Snap]


def account(user=ALICE, segment="NSE", balance=100000.0, starting=100000.0):
    return SimpleNamespace(id=uuid.uuid4(), user_id=user, segment=segment, starting_balance=starting, current_balance=balance)


def position(user=ALICE, segment="NSE", symbol="TCS", action="BUY", entry=100.0, qty=10):
    return SimpleNamespace(id=uuid.uuid4(), user_id=user, segment=segment, status="OPEN", exchange="NSE", symbol=symbol, action=action, entry_price=entry, quantity=qty)


def ltp(prices):
    return lambda exchange, symbols: {s: prices[s] for s in symbols if s in prices}


def snap_row(acc, n, balance, *, unrealized=0.0, reset=False, starting=None):
    return Snap(
        account_id=acc.id, user_id=acc.user_id, segment=acc.segment, snapshot_date=day(n),
        starting_balance=starting if starting is not None else float(acc.starting_balance),
        balance=balance, unrealized_pnl=unrealized, equity=balance + unrealized, open_positions=0, is_reset_point=reset,
    )


NOON = datetime(2026, 9, 25, 6, 30, tzinfo=timezone.utc)  # 12:00 IST on the 25th


# --- the scheduled recording job -------------------------------------------------------------------------


def test_a_first_pass_writes_a_baseline_row_for_a_flat_account():
    acc = account()
    db = FakeDb([acc])
    out = record_equity_snapshots(db, ltp({}), now=NOON)
    (row,) = db.snapshots()
    assert out["written"] == 1 and (row.snapshot_date, row.balance, row.unrealized_pnl, row.equity) == (day(25), 100000.0, 0.0, 100000.0)
    assert row.open_positions == 0 and row.user_id == ALICE and row.is_reset_point is False


def test_open_positions_are_marked_to_market():
    acc = account(balance=99000.0)
    db = FakeDb([acc], [position(entry=100.0, qty=10), position(symbol="INFY", action="SELL", entry=50.0, qty=4)])
    record_equity_snapshots(db, ltp({"TCS": 110.0, "INFY": 45.0}), now=NOON)
    (row,) = db.snapshots()
    assert row.unrealized_pnl == pytest.approx(100.0 + 20.0)  # long +10x10, short +5x4
    assert row.equity == pytest.approx(99000.0 + 120.0) and row.open_positions == 2


def test_an_account_with_a_missing_quote_is_skipped_not_recorded_understated():
    acc = account()
    db = FakeDb([acc], [position(symbol="TCS"), position(symbol="INFY")])
    out = record_equity_snapshots(db, ltp({"TCS": 110.0}), now=NOON)  # no INFY quote
    assert out["skipped_incomplete"] == 1 and out["written"] == 0 and db.snapshots() == []


def test_a_quiet_account_with_an_unchanged_balance_writes_nothing():
    acc = account(balance=105000.0)
    db = FakeDb([acc], snapshots=[snap_row(acc, 20, 105000.0)])
    out = record_equity_snapshots(db, ltp({}), now=NOON)
    assert out["unchanged"] == 1 and len(db.snapshots()) == 1


def test_a_changed_balance_writes_a_new_day():
    acc = account(balance=106000.0)
    db = FakeDb([acc], snapshots=[snap_row(acc, 20, 105000.0)])
    record_equity_snapshots(db, ltp({}), now=NOON)
    assert [r.snapshot_date for r in db.snapshots()] == [day(20), day(25)] and db.snapshots()[-1].balance == 106000.0


def test_a_rebaselined_account_writes_even_if_the_balance_matches():
    acc = account(balance=105000.0, starting=105000.0)
    db = FakeDb([acc], snapshots=[snap_row(acc, 20, 105000.0, starting=100000.0)])
    assert record_equity_snapshots(db, ltp({}), now=NOON)["written"] == 1


def test_a_second_pass_the_same_day_updates_the_row_not_a_duplicate():
    acc = account(balance=100000.0)
    db = FakeDb([acc], [position(entry=100.0, qty=10)])
    record_equity_snapshots(db, ltp({"TCS": 101.0}), now=NOON)
    record_equity_snapshots(db, ltp({"TCS": 103.0}), now=NOON)
    (row,) = db.snapshots()
    assert row.unrealized_pnl == pytest.approx(30.0)


def test_the_day_is_bucketed_in_the_configured_timezone():
    acc = account()
    db = FakeDb([acc])
    late_utc = datetime(2026, 9, 25, 22, 0, tzinfo=timezone.utc)  # 03:30 IST on the 26th
    record_equity_snapshots(db, ltp({}), now=late_utc)
    assert db.snapshots()[0].snapshot_date == day(26)


def test_platform_accounts_and_other_users_positions_are_not_mixed_in():
    mine, platform = account(user=ALICE), account(user=None)
    db = FakeDb([mine, platform], [position(user=BOB, entry=100.0, qty=10), position(user=None)])
    record_equity_snapshots(db, ltp({"TCS": 200.0}), now=NOON)
    (row,) = db.snapshots()
    assert row.user_id == ALICE and row.unrealized_pnl == 0.0 and row.open_positions == 0


def test_one_accounts_failure_does_not_stop_the_others():
    a, b = account(user=ALICE), account(user=BOB)
    db = FakeDb([a, b])
    db.fail_next_commit = True
    out = record_equity_snapshots(db, ltp({}), now=NOON)
    assert out["failed"] == 1 and out["written"] == 1 and db.rollbacks == 1


# --- reset markers ------------------------------------------------------------------------------------------


def test_a_reset_writes_a_marker_at_the_post_reset_balance():
    acc = account(balance=100000.0)  # already reset by the caller
    db = FakeDb([acc])
    record_reset_point(db, acc, now=NOON)
    (row,) = db.snapshots()
    assert row.is_reset_point is True and row.equity == 100000.0 and row.unrealized_pnl == 0.0


def test_the_marker_survives_a_later_tick_the_same_day():
    acc = account()
    db = FakeDb([acc])
    record_reset_point(db, acc, now=NOON)
    record_equity_snapshots(db, ltp({}), now=NOON)
    (row,) = db.snapshots()
    assert row.is_reset_point is True


def test_platform_accounts_are_not_recorded():
    acc = account(user=None)
    db = FakeDb([acc])
    record_reset_point(db, acc, now=NOON)
    assert db.snapshots() == []


class ResetDb(FakeDb):
    def refresh(self, row):
        pass


@pytest.fixture
def reset_env(monkeypatch):
    """The account routes' reset paths, with load_account and serialisation stubbed."""
    acc = SimpleNamespace(
        id=uuid.uuid4(), user_id=ALICE, segment="NSE", starting_balance=200000.0, current_balance=150000.0,
        capital_per_trade=1, risk_per_trade_pct=1, min_reward_risk_ratio=4, enforce_risk_based_lots=False, leverage=1,
        leverage_buffer_pct=10, mtf_annual_interest_rate_pct=None, square_off_time=None, live_trading_enabled=False,
        live_trading_consent_at=None, live_trading_consent_version=None, require_stop_loss=False, max_order_value=None,
        max_daily_loss=None, default_interval=None, default_higher_interval=None, updated_at=NOON,
    )
    monkeypatch.setattr(accounts_route, "load_account", lambda db, uid, seg, book="intraday": acc)
    monkeypatch.setattr(accounts_route, "_to_out", lambda db, row, token=None: row)
    return acc, ResetDb([acc])


def test_the_reset_route_starts_a_new_curve(reset_env):
    acc, db = reset_env
    accounts_route.reset_account("NSE", user=User(id=ALICE, token="t", is_admin=False), db=db)
    (row,) = db.snapshots()
    assert acc.current_balance == 200000.0 and row.is_reset_point is True and row.balance == 200000.0


def test_changing_the_starting_balance_starts_a_new_curve(reset_env):
    acc, db = reset_env
    accounts_route.update_account("NSE", AccountUpdate(starting_balance=300000), user=User(id=ALICE, token="t", is_admin=False), db=db)
    (row,) = db.snapshots()
    assert row.is_reset_point is True and row.balance == 300000.0 and row.starting_balance == 300000.0


def test_an_ordinary_settings_edit_does_not_write_a_marker(reset_env):
    _, db = reset_env
    accounts_route.update_account("NSE", AccountUpdate(capital_per_trade=5000), user=User(id=ALICE, token="t", is_admin=False), db=db)
    assert db.snapshots() == []


# --- the read route ------------------------------------------------------------------------------------------------


def me(uid=ALICE):
    return User(id=uid, token="t", is_admin=False)


def read(db, segment="NSE", days=90, uid=ALICE):
    return history_route.get_equity_history(segment, days=days, user=me(uid), db=db)


def test_an_unknown_segment_is_a_404():
    with pytest.raises(HTTPException) as exc:
        read(FakeDb(), segment="FOREX")
    assert exc.value.status_code == 404


def test_no_account_yet_is_an_empty_history_not_an_error():
    out = read(FakeDb())
    assert out.points == [] and out.stats is None


def test_only_the_callers_own_curve_is_returned():
    mine, theirs = account(user=ALICE), account(user=BOB)
    db = FakeDb([mine, theirs], snapshots=[snap_row(mine, 20, 100000.0, reset=True), snap_row(theirs, 20, 1.0, reset=True)])
    out = read(db, uid=ALICE)
    assert [p.equity for p in out.points] == [100000.0]


def test_a_short_window_never_hides_a_drawdown(monkeypatch):
    acc = account()
    rows = [snap_row(acc, 1, 100000.0, reset=True), snap_row(acc, 2, 120000.0), snap_row(acc, 3, 90000.0), snap_row(acc, 24, 95000.0), snap_row(acc, 25, 96000.0)]
    monkeypatch.setattr(history_route, "today_in_equity_tz", lambda now: day(25))
    out = read(FakeDb([acc], snapshots=rows), days=3)
    assert [p.snapshot_date for p in out.points] == [day(24), day(25)]  # only the window
    assert out.stats.max_drawdown_pct == pytest.approx(25.0) and out.stats.points == 5  # but the whole curve


# --- real app wiring -----------------------------------------------------------------------------------------------


def test_the_route_needs_a_login():
    from fastapi.testclient import TestClient

    from app.main import app

    assert TestClient(app).get("/equity-history/NSE").status_code == 401


def test_the_scheduler_registers_the_job(monkeypatch):
    from app import scheduler

    added = []
    monkeypatch.setattr(scheduler._scheduler, "add_job", lambda fn, trigger, **kw: added.append(kw["id"]))
    monkeypatch.setattr(scheduler._scheduler, "start", lambda: None)
    monkeypatch.setattr(scheduler.settings, "equity_snapshot_poll_seconds", 300)
    scheduler.start_scheduler()
    assert "equity-snapshot" in added
    added.clear()
    monkeypatch.setattr(scheduler.settings, "equity_snapshot_poll_seconds", 0)
    scheduler.start_scheduler()
    assert "equity-snapshot" not in added  # 0 disables it
