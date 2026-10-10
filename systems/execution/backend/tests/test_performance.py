"""Server-side performance and discipline (app/domain/performance.py,
GET /performance/{segment}).

compute_discipline is a port of the frontend's discipline.ts and is tested
against golden fixtures produced by RUNNING that TypeScript
(tests/fixtures/gen_discipline_golden.mjs), so any drift fails here. The loader
and route are tested with a small fake session that really evaluates the
SQLAlchemy filters the code builds."""

import json
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.sql import operators
from sqlalchemy.sql.elements import False_, True_

from app.adapters.db import models as db_models
from app.api.routes import performance as route
from app.auth import User
from app.domain.performance import (
    TradeRecord, _js_round, compute_discipline, compute_performance, epoch_start, load_manual_trades,
)

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "discipline_golden.json").read_text(encoding="utf-8"))
ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
BOB = uuid.UUID("22222222-2222-2222-2222-222222222222")


def record(js: dict) -> TradeRecord:
    return TradeRecord(
        segment=js["segment"], symbol="X", pnl=js["pnl"], entry_price=js["entry_price"], stop_loss_price=js["stop_loss_price"],
        target_price=js["target_price"], quantity=js["quantity"], exit_time=datetime.fromisoformat(js["exit_time"].replace("Z", "+00:00")),
        exit_reason=js["exit_reason"], order_type=js["order_type"], entry_setup_tag=js["entry_setup_tag"], entry_confidence=js["entry_confidence"],
        setup_tag=js["setup_tag"], confidence=js["confidence"], reviewed=js["reviewed"], auto_traded=js["auto_traded"],
    )


# --- parity with the real TypeScript -------------------------------------------------------------------------------


def _close(a, b):
    if a is None or b is None:
        return a is None and b is None
    return a == pytest.approx(b, abs=1e-9)


@pytest.mark.parametrize("case", GOLDEN, ids=[c["name"] for c in GOLDEN])
def test_the_python_port_matches_the_real_typescript(case):
    got = compute_discipline([record(t) for t in case["trades"]], case["days"])
    exp = case["expected"]
    assert got["score"] == exp["score"]
    assert (got["windowStart"], got["windowDays"], got["tradeCount"]) == (exp["windowStart"], exp["windowDays"], exp["tradeCount"])
    for comp in ("planned", "planAdherence"):
        assert _close(got[comp]["rate"], exp[comp]["rate"]) and got[comp]["trades"] == exp[comp]["trades"], comp
    pr = got["planReview"]
    assert _close(pr["rate"], exp["planReview"]["rate"]) and pr["trades"] == exp["planReview"]["trades"]
    assert _close(pr["beforeRate"], exp["planReview"]["beforeRate"]) and _close(pr["afterRate"], exp["planReview"]["afterRate"])
    oc = got["outcome"]
    assert _close(oc["rate"], exp["outcome"]["rate"]) and oc["trades"] == exp["outcome"]["trades"]
    assert _close(oc["winRate"], exp["outcome"]["winRate"]) and _close(oc["avgR"], exp["outcome"]["avgR"])


def test_the_golden_set_is_not_trivial():
    scores = [c["expected"]["score"] for c in GOLDEN]
    assert len([s for s in scores if s is not None]) >= 10 and 100 in scores and None in scores
    assert len({c["expected"]["score"] for c in GOLDEN if c["expected"]["score"] is not None}) >= 8


def test_js_rounding_rounds_halves_up_not_to_even():
    assert [_js_round(x) for x in (0.5, 1.5, 2.5, 3.49, -0.5)] == [1, 2, 3, 3, 0]  # Python's round(2.5) is 2


# --- discipline behaviours (also implied by the parity, spelled out) ------------------------------------------------------


def base(**over):
    t = TradeRecord(
        segment="NSE", symbol="X", pnl=100.0, entry_price=100.0, stop_loss_price=90.0, target_price=130.0, quantity=10,
        exit_time=datetime(2026, 9, 10, 6, 0, tzinfo=timezone.utc), exit_reason="target", order_type="limit", entry_setup_tag="a",
        entry_confidence=3, setup_tag="a", confidence=3, reviewed=True, auto_traded=False,
    )
    for k, v in over.items():
        setattr(t, k, v)
    return t


def test_below_five_trades_there_is_no_score():
    assert compute_discipline([base() for _ in range(4)], 30)["score"] is None
    assert compute_discipline([base() for _ in range(5)], 30)["score"] is not None


def test_auto_traded_fills_are_excluded_entirely():
    d = compute_discipline([base(auto_traded=True) for _ in range(8)], 30)
    assert d["tradeCount"] == 0 and d["score"] is None


def test_a_market_order_or_a_limit_without_a_stop_is_not_a_plan():
    d = compute_discipline([base(order_type="market"), base(stop_loss_price=None)] * 3, 30)
    assert d["planned"]["rate"] == 0.0 and d["planAdherence"]["rate"] == 0.0


def test_bailing_on_a_plan_scores_forty_percent():
    d = compute_discipline([base(exit_reason="manual")] * 5, 30)
    assert d["planAdherence"]["rate"] == pytest.approx(0.4)


# --- performance figures, by hand ------------------------------------------------------------------------------------------


def trades_with(pnls, **over):
    out = []
    for i, pnl in enumerate(pnls):
        out.append(base(pnl=pnl, exit_time=datetime(2026, 9, 1, 6, 0, tzinfo=timezone.utc) + timedelta(days=i), **over))
    return out


def test_performance_by_hand():
    ts = trades_with([100, -50, -50, 200, -30, 0])
    for t, c, s in zip(ts, (1, 2, 3, 4, 5, 6), (0.5, 0, 0, 0, 0, 0)):
        t.charges, t.slippage_cost = float(c), float(s)
    p = compute_performance(ts)
    assert (p.trades, p.wins, p.losses, p.breakeven) == (6, 2, 3, 1)
    assert p.win_rate_pct == pytest.approx(100 / 3)
    assert p.total_pnl == 170 and p.avg_pnl == pytest.approx(170 / 6)
    assert p.avg_win == 150 and p.avg_loss == pytest.approx(-130 / 3)
    assert p.profit_factor == pytest.approx(300 / 130)
    assert (p.best_trade, p.worst_trade, p.max_consecutive_losses) == (200, -50, 2)
    assert p.total_charges == 21.0 and p.total_slippage == 0.5 and p.gross_pnl == pytest.approx(170 + 21.5)


def test_profit_factor_is_none_without_losses_and_empty_is_none():
    assert compute_performance(trades_with([10, 20])).profit_factor is None
    assert compute_performance([]) is None
    assert compute_performance([base(pnl=None)]) is None


def test_the_losing_streak_is_measured_in_exit_order_not_list_order():
    # exit order: L L L L W (a streak of 4). Listed as t1, t5, t2, t3, t4 the
    # win sits between the losses, so list order would only ever show 3.
    t1, t2, t3, t4, t5 = trades_with([-1, -1, -1, -1, 5])
    assert compute_performance([t1, t5, t2, t3, t4]).max_consecutive_losses == 4


def test_average_r_only_counts_trades_that_had_a_stop():
    with_stop = base(pnl=200.0)  # risk (100-90)*10 = 100 -> +2R
    no_stop = base(pnl=500.0, stop_loss_price=None)
    assert compute_performance([with_stop, no_stop]).avg_r == pytest.approx(2.0)


# --- loading + the route, through a fake session that evaluates the real filters ------------------------------------------------


def _matches(row, c):
    key, op = c.left.key, c.operator
    if isinstance(c.right, True_):  # .is_(True) renders as a True_ element, not a bound value
        value = True
    elif isinstance(c.right, False_):
        value = False
    else:
        value = getattr(c.right, "value", None)
    current = getattr(row, key)
    if op is operators.eq:
        return current == value
    if op is operators.ne:
        return current != value
    if op is operators.is_not:
        return current is not None
    if op is operators.is_:
        return current is value
    raise AssertionError(f"fake session cannot evaluate {op}")


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
    def __init__(self, accounts=(), positions=(), groups=(), snapshots=()):
        self.t = {db_models.Account: list(accounts), db_models.Position: list(positions), db_models.OptionPositionGroup: list(groups), db_models.AccountEquitySnapshot: list(snapshots)}

    def query(self, model):
        return FakeQuery(self.t[model])


def pos(**over):
    row = dict(
        user_id=ALICE, strategy_id=None, status="CLOSED", segment="NSE", option_group_id=None, symbol="TCS", pnl=100, entry_price=100,
        stop_loss_price=90, target_price=130, quantity=10, exit_time=datetime(2026, 9, 10, 6, 0, tzinfo=timezone.utc), exit_reason="target",
        order_type="limit", entry_setup_tag="a", entry_confidence=3, setup_tag="a", confidence=3, reviewed_at=None, notes=None,
        auto_traded=False, charges=None, slippage_cost=None, is_live_broker_order=False, horizon="intraday",
    )
    row.update(over)
    return SimpleNamespace(**row)


def grp(**over):
    row = dict(
        user_id=ALICE, strategy_id=None, status="CLOSED", segment="NSE", underlying_symbol="NIFTY", pnl=250, spot_stop_loss_price=22000,
        spot_target_price=23000, quantity=75, exit_time=datetime(2026, 9, 11, 6, 0, tzinfo=timezone.utc), exit_reason="spot_target",
        order_type="market", entry_setup_tag=None, entry_confidence=None, setup_tag=None, confidence=None, reviewed_at=None, notes=None,
        auto_traded=False, charges=12.5, slippage_cost=3.0, id=uuid.uuid4(),
    )
    row.update(over)
    return SimpleNamespace(**row)


def test_the_loader_takes_only_the_callers_own_closed_manual_trades_for_the_segment():
    keep = pos()
    db = FakeDb(positions=[
        keep,
        pos(user_id=BOB),  # someone else's
        pos(strategy_id=uuid.uuid4()),  # an automated Strategy trade
        pos(status="OPEN"),
        pos(segment="MCX"),
        pos(option_group_id=uuid.uuid4()),  # an option leg: its group is the trade
        pos(exit_time=None),
    ], groups=[grp(), grp(user_id=BOB), grp(status="OPEN"), grp(segment="MCX"), grp(strategy_id=uuid.uuid4())])
    trades = load_manual_trades(db, ALICE, "NSE")
    assert sorted(t.symbol for t in trades) == ["NIFTY", "TCS"]


def test_a_group_maps_to_a_trade_the_way_the_frontend_does():
    (t,) = load_manual_trades(FakeDb(groups=[grp()]), ALICE, "NSE")
    assert (t.entry_price, t.stop_loss_price, t.target_price, t.symbol) == (None, 22000.0, 23000.0, "NIFTY")
    assert (t.charges, t.slippage_cost) == (12.5, 3.0)


@pytest.mark.parametrize(
    "reviewed_at, notes, expected",
    [(None, None, False), (None, "", False), (None, "   ", False), (None, "learned x", True), (datetime(2026, 9, 12, tzinfo=timezone.utc), None, True)],
)
def test_reviewed_means_a_review_or_a_non_blank_note(reviewed_at, notes, expected):
    (t,) = load_manual_trades(FakeDb(positions=[pos(reviewed_at=reviewed_at, notes=notes)]), ALICE, "NSE")
    assert t.reviewed is expected


def test_since_drops_trades_that_closed_before_that_ist_date():
    old, new = pos(symbol="OLD", exit_time=datetime(2026, 9, 9, 6, 0, tzinfo=timezone.utc)), pos(symbol="NEW", exit_time=datetime(2026, 9, 12, 6, 0, tzinfo=timezone.utc))
    db = FakeDb(positions=[old, new])
    assert [t.symbol for t in load_manual_trades(db, ALICE, "NSE", since=date(2026, 9, 10))] == ["NEW"]


def account(user=ALICE, segment="NSE"):
    return SimpleNamespace(id=uuid.uuid4(), user_id=user, segment=segment, book="intraday", starting_balance=100000.0, current_balance=100000.0)


def snap(acc, day, *, reset=False, equity=100000.0):
    return SimpleNamespace(account_id=acc.id, snapshot_date=day, is_reset_point=reset, starting_balance=100000.0, balance=equity, unrealized_pnl=0.0, equity=equity)


def test_epoch_start_is_the_latest_reset_marker():
    acc = account()
    db = FakeDb(snapshots=[snap(acc, date(2026, 9, 1), reset=True), snap(acc, date(2026, 9, 5)), snap(acc, date(2026, 9, 8), reset=True), snap(acc, date(2026, 9, 9))])
    assert epoch_start(db, acc) == date(2026, 9, 8)
    assert epoch_start(FakeDb(snapshots=[snap(acc, date(2026, 9, 1))]), acc) is None


def me(uid=ALICE):
    return User(id=uid, token="t", is_admin=False)


def get(db, segment="NSE", **kw):
    return route.get_performance(segment, scope=kw.get("scope", "epoch"), discipline_days=kw.get("discipline_days", 30), user=me(kw.get("uid", ALICE)), db=db)


def test_an_unknown_segment_is_a_404():
    with pytest.raises(HTTPException) as exc:
        get(FakeDb(), "FOREX")
    assert exc.value.status_code == 404


def test_no_trades_and_no_account_is_an_empty_but_valid_answer():
    out = get(FakeDb())
    assert out.performance is None and out.discipline.score is None and out.equity is None and out.since is None


def test_a_reset_restarts_the_record_and_scope_all_shows_everything():
    acc = account()
    early = pos(symbol="OLD", pnl=-500, exit_time=datetime(2026, 9, 3, 6, 0, tzinfo=timezone.utc))
    late = pos(symbol="NEW", pnl=300, exit_time=datetime(2026, 9, 12, 6, 0, tzinfo=timezone.utc))
    db = FakeDb([acc], [early, late], snapshots=[snap(acc, date(2026, 9, 10), reset=True), snap(acc, date(2026, 9, 12), equity=100300.0)])
    epoch, everything = get(db), get(db, scope="all")
    assert epoch.since == date(2026, 9, 10) and epoch.performance.trades == 1 and epoch.performance.total_pnl == 300
    assert everything.since is None and everything.performance.trades == 2 and everything.performance.total_pnl == -200
    assert epoch.equity.since == date(2026, 9, 10)  # the equity stats are from the same curve


def test_only_the_callers_trades_and_auto_fills_do_not_count_toward_performance():
    acc = account()
    db = FakeDb([acc], [pos(pnl=100), pos(user_id=BOB, pnl=999), pos(auto_traded=True, pnl=555)])
    out = get(db)
    assert out.performance.trades == 1 and out.performance.total_pnl == 100


def test_the_response_shape_carries_the_discipline_components():
    acc = account()
    db = FakeDb([acc], [pos(pnl=100 + i, exit_time=datetime(2026, 9, 1 + i, 6, 0, tzinfo=timezone.utc)) for i in range(6)])
    d = get(db).discipline
    assert d.score is not None and d.trade_count == 6 and d.window_days == 30
    assert d.planned.rate == 1.0 and d.plan_review.before_rate == 1.0 and d.outcome.win_rate == 1.0


def test_the_route_needs_a_login():
    from fastapi.testclient import TestClient

    from app.main import app

    assert TestClient(app).get("/performance/NSE").status_code == 401


# --- the two books -------------------------------------------------------------------------------------------------------------


def test_the_intraday_book_leaves_out_a_positional_hold_and_the_positional_book_is_only_those():
    day, swing = pos(symbol="DAY"), pos(symbol="SWING", horizon="positional")
    db = FakeDb(positions=[day, swing], groups=[grp()])
    assert sorted(t.symbol for t in load_manual_trades(db, ALICE, "NSE")) == ["DAY", "NIFTY"]
    assert [t.symbol for t in load_manual_trades(db, ALICE, "NSE", book="positional")] == ["SWING"]  # an option spread is never positional


def test_the_performance_route_reads_the_asked_for_book_and_its_own_account():
    from app.api.routes.performance import get_performance

    intraday = account()
    intraday.book = "intraday"
    swing_acc = account()
    swing_acc.book = "positional"
    db = FakeDb(accounts=[intraday, swing_acc], positions=[pos(symbol="DAY"), pos(symbol="SWING", horizon="positional", pnl=300)])
    user = SimpleNamespace(id=ALICE)
    day_out = get_performance("NSE", scope="epoch", discipline_days=30, user=user, db=db)  # (called directly: no Query defaults)
    swing_out = get_performance("NSE", scope="epoch", discipline_days=30, book="positional", user=user, db=db)
    assert day_out.book == "intraday" and swing_out.book == "positional"
    assert day_out.performance.trades == 1 and swing_out.performance.trades == 1
