"""The paper track-record gate (app/domain/track_record.py, its enforcement in
PUT /accounts/{segment}, and GET /live-eligibility/{segment}).

Three layers, tested separately: the pure evaluation, the loading of a real
account's record (through the fake session that evaluates the SQLAlchemy filters
the code builds), and the route wiring."""

import uuid
from datetime import date, datetime, timezone

import pytest
from fastapi import HTTPException

from app.api.routes import accounts as accounts_route
from app.api.routes import live_eligibility as eligibility_route
from app.auth import User
from app.config import settings
from app.domain import track_record as tr
from app.domain.live_gate import LIVE_SEGMENTS
from app.domain.track_record import Requirement, Thresholds, evaluate, evaluate_for_account, unmet_messages
from tests.test_live_gate import account_row, creds, enable, put_account, user  # noqa: F401  (creds is a fixture)
from tests.test_performance import ALICE, BOB, FakeDb, account, grp, pos, snap

TH = Thresholds(min_trades=30, min_days=14, min_discipline=60, max_drawdown_pct=20.0, min_slippage_bps=3.0)

GOOD = dict(apply_charges=True, slippage_bps=5.0, qualifying_trades=40, days_tracked=20, discipline_score=75, max_drawdown_pct=8.0, net_pnl=12000.0)


def ev(**over):
    return evaluate(TH, **{**GOOD, **over})


def by_key(reqs):
    return {r.key: r for r in reqs}


# --- pure evaluation -------------------------------------------------------------------------------------------------


def test_a_record_meeting_everything_is_eligible():
    assert all(r.met for r in ev())


@pytest.mark.parametrize(
    "key, over",
    [
        ("costs", dict(apply_charges=False)),
        ("costs", dict(slippage_bps=2.9)),
        ("trades", dict(qualifying_trades=29)),
        ("days", dict(days_tracked=13)),
        ("discipline", dict(discipline_score=59)),
        ("discipline", dict(discipline_score=None)),
        ("drawdown", dict(max_drawdown_pct=20.1)),
        ("drawdown", dict(max_drawdown_pct=None)),
        ("profit", dict(net_pnl=0.0)),
        ("profit", dict(net_pnl=-5.0)),
        ("profit", dict(net_pnl=None)),
    ],
)
def test_each_requirement_fails_on_its_own(key, over):
    reqs = by_key(ev(**over))
    assert reqs[key].met is False
    assert all(r.met for k, r in reqs.items() if k != key)  # and nothing else is dragged down


@pytest.mark.parametrize(
    "over",
    [dict(slippage_bps=3.0), dict(qualifying_trades=30), dict(days_tracked=14), dict(discipline_score=60), dict(max_drawdown_pct=20.0), dict(net_pnl=0.01)],
)
def test_the_boundaries_are_inclusive_where_they_should_be(over):
    assert all(r.met for r in ev(**over))


def test_unmet_messages_say_what_is_needed_and_what_there_is():
    msgs = unmet_messages(ev(qualifying_trades=12, discipline_score=None, net_pnl=-50.0))
    assert len(msgs) == 3
    assert any("12 trades" in m and "30 trades" in m for m in msgs)
    assert any("not enough trades yet" in m for m in msgs)
    assert any("-50.00" in m for m in msgs)
    assert unmet_messages(ev()) == []


def test_thresholds_come_from_settings(monkeypatch):
    monkeypatch.setattr(settings, "track_record_min_trades", 7)
    monkeypatch.setattr(settings, "track_record_max_drawdown_pct", 12.5)
    th = Thresholds.from_settings()
    assert th.min_trades == 7 and th.max_drawdown_pct == 12.5


def test_the_defaults_are_off_and_moderate():
    assert settings.require_paper_track_record is False
    assert (settings.track_record_min_trades, settings.track_record_min_days, settings.track_record_min_discipline) == (30, 14, 60)


# --- loading a real account's record ------------------------------------------------------------------------------------


def costed(**over):
    return pos(charges=5.0, **over)


def at(day):
    return datetime(2026, 9, day, 6, 0, tzinfo=timezone.utc)


def good_account(**over):
    acc = account()
    acc.apply_charges, acc.slippage_bps = True, 5.0
    for k, v in over.items():
        setattr(acc, k, v)
    return acc


def record_of(acc, trades, snapshots):
    return by_key(evaluate_for_account(FakeDb([acc], trades, snapshots=snapshots), ALICE, acc, TH))


def test_only_trades_recorded_with_costs_count():
    acc = good_account()
    trades = [costed(exit_time=at(d), pnl=100) for d in (1, 2, 3)] + [pos(exit_time=at(4), pnl=100)] * 5  # 5 gross trades
    r = record_of(acc, trades, [snap(acc, date(2026, 9, 1), reset=True)])
    assert r["trades"].actual == "3 trades"


def test_gross_history_cannot_be_laundered_by_switching_costs_on_afterwards():
    """A big profitable record with no costs recorded, then costs switched on: nothing qualifies."""
    acc = good_account()
    trades = [pos(exit_time=at(d), pnl=500) for d in range(1, 25)]
    r = record_of(acc, trades, [snap(acc, date(2026, 9, 1), reset=True)])
    assert r["costs"].met and r["trades"].actual == "0 trades" and not r["trades"].met and r["profit"].actual == "no trades yet"


def test_net_profit_is_over_the_costed_trades_and_uses_their_net_pnl():
    acc = good_account()
    trades = [costed(exit_time=at(1), pnl=100), costed(exit_time=at(2), pnl=-30)]
    r = record_of(acc, trades, [snap(acc, date(2026, 9, 1), reset=True)])
    assert r["profit"].actual == "70.00" and r["profit"].met


def test_days_and_drawdown_come_from_the_current_equity_curve():
    acc = good_account()
    snaps = [snap(acc, date(2026, 9, 1), reset=True), snap(acc, date(2026, 9, 5), equity=120000.0), snap(acc, date(2026, 9, 9), equity=90000.0)]
    r = record_of(acc, [], snaps)
    assert r["days"].actual == "9 days"
    assert r["drawdown"].actual == "25.0%" and not r["drawdown"].met  # 120000 -> 90000


def test_a_reset_restarts_the_record():
    acc = good_account()
    trades = [costed(exit_time=at(d), pnl=100) for d in (2, 3, 4)]
    snaps = [snap(acc, date(2026, 9, 1), reset=True), snap(acc, date(2026, 9, 10), reset=True)]  # reset AFTER those trades
    assert record_of(acc, trades, snaps)["trades"].actual == "0 trades"


def test_auto_trader_fills_and_other_users_trades_do_not_count():
    acc = good_account()
    trades = [costed(exit_time=at(1), auto_traded=True), costed(exit_time=at(2), user_id=BOB), costed(exit_time=at(3))]
    assert record_of(acc, trades, [snap(acc, date(2026, 9, 1), reset=True)])["trades"].actual == "1 trades"


def test_option_groups_recorded_with_costs_qualify_too():
    acc = good_account()
    assert record_of(acc, [], [snap(acc, date(2026, 9, 1), reset=True)])["trades"].actual == "0 trades"
    r = by_key(evaluate_for_account(FakeDb([acc], groups=[grp(charges=12.5), grp(charges=None)], snapshots=[snap(acc, date(2026, 9, 1), reset=True)]), ALICE, acc, TH))
    assert r["trades"].actual == "1 trades"


def test_the_account_switches_are_read_from_the_account():
    acc = good_account(apply_charges=False, slippage_bps=0)
    r = record_of(acc, [], [])
    assert not r["costs"].met and "charges off" in r["costs"].actual and "slippage 0 bps" in r["costs"].actual


# --- enforcement in PUT /accounts/{segment} --------------------------------------------------------------------------------------


@pytest.fixture
def enforced(monkeypatch):
    monkeypatch.setattr(settings, "require_paper_track_record", True)
    calls = []

    def fake_eval(db, user_id, row):
        calls.append(row)
        return state["reqs"]

    state = {"reqs": ev(qualifying_trades=12, discipline_score=None)}
    monkeypatch.setattr(accounts_route, "evaluate_for_account", fake_eval)
    state["calls"] = calls
    return state


def test_turning_live_on_without_the_record_is_refused_and_lists_the_shortfalls_with_the_others(creds, enforced):
    row = account_row()
    with pytest.raises(HTTPException) as exc:
        put_account(row, enable(live_trading_consent=None))  # consent ALSO missing
    detail = exc.value.detail
    assert exc.value.status_code == 422
    assert "paper track record" in detail and "12 trades" in detail and "not enough trades yet" in detail
    assert "risk disclosure" in detail  # everything at once, not one error per attempt
    assert row.live_trading_enabled is False and row.live_trading_consent_at is None


def test_turning_live_on_with_a_full_record_is_allowed(creds, enforced):
    enforced["reqs"] = ev()
    row = account_row()
    put_account(row, enable())
    assert row.live_trading_enabled is True


def test_the_gate_is_off_by_default(creds, monkeypatch):
    monkeypatch.setattr(accounts_route, "evaluate_for_account", lambda *a, **k: pytest.fail("must not be consulted when the flag is off"))
    row = account_row()
    put_account(row, enable())
    assert row.live_trading_enabled is True


def test_an_already_live_account_is_not_rechecked_on_a_routine_edit(creds, enforced):
    row = account_row(live_trading_enabled=True, max_order_value=1000, max_daily_loss=500)
    put_account(row, AccountUpdateLive(max_order_value=2000))
    assert enforced["calls"] == [] and float(row.max_order_value) == 2000


def test_re_sending_enabled_on_an_already_live_account_is_not_a_transition(creds, enforced):
    """live_trading_enabled=true on an account that is ALREADY live changes nothing, so it is not re-gated."""
    row = account_row(live_trading_enabled=True, max_order_value=1000, max_daily_loss=500)
    put_account(row, AccountUpdateLive(live_trading_enabled=True, max_order_value=2500))
    assert enforced["calls"] == [] and row.live_trading_enabled is True and float(row.max_order_value) == 2500


def test_switching_live_off_is_never_blocked(creds, enforced):
    row = account_row(live_trading_enabled=True, max_order_value=1000, max_daily_loss=500)
    put_account(row, AccountUpdateLive(live_trading_enabled=False))
    assert row.live_trading_enabled is False and enforced["calls"] == []


def test_paper_only_edits_do_not_consult_it(creds, enforced):
    row = account_row()
    put_account(row, AccountUpdateLive(capital_per_trade=1234))
    assert enforced["calls"] == []


def test_an_unsupported_segment_is_left_to_the_existing_gate(creds, enforced):
    row = account_row(segment="CRYPTO")
    with pytest.raises(HTTPException) as exc:
        put_account(row, enable(), segment="CRYPTO")
    assert "only available for" in exc.value.detail and enforced["calls"] == []


def AccountUpdateLive(**kw):
    from app.domain.models import AccountUpdate

    return AccountUpdate(**kw)


# --- GET /live-eligibility/{segment} ---------------------------------------------------------------------------------------------


def me(uid=ALICE):
    return User(id=uid, token="t", is_admin=False)


def eligibility(db, segment="NSE"):
    return eligibility_route.get_live_eligibility(segment, user=me(), db=db)


def test_an_unknown_segment_is_a_404():
    with pytest.raises(HTTPException) as exc:
        eligibility(FakeDb(), "FOREX")
    assert exc.value.status_code == 404


def test_crypto_can_never_go_live_and_says_so():
    out = eligibility(FakeDb(), "CRYPTO")
    assert out.eligible is False and [r.key for r in out.requirements] == ["segment"]
    assert "NSE" in out.requirements[0].required and "MCX" in out.requirements[0].required


def test_no_account_yet_means_every_requirement_is_unmet_at_zero():
    out = eligibility(FakeDb())
    assert out.eligible is False and {r.key for r in out.requirements} == {"costs", "trades", "days", "discipline", "drawdown", "profit"}
    assert not any(r.met for r in out.requirements)


def test_the_progress_is_reported_and_enforced_reflects_the_flag(monkeypatch):
    acc = good_account()
    db = FakeDb([acc], [costed(exit_time=at(1), pnl=100)], snapshots=[snap(acc, date(2026, 9, 1), reset=True)])
    monkeypatch.setattr(settings, "require_paper_track_record", False)
    out = eligibility(db)
    assert out.enforced is False and out.eligible is False
    assert {r.key: r.actual for r in out.requirements}["trades"] == "1 trades"
    monkeypatch.setattr(settings, "require_paper_track_record", True)
    assert eligibility(db).enforced is True


def test_eligible_when_everything_is_met(monkeypatch):
    monkeypatch.setattr(eligibility_route, "evaluate_for_account", lambda db, uid, acc: ev())
    out = eligibility(FakeDb([good_account()]))
    assert out.eligible is True and all(r.met for r in out.requirements)


def test_the_route_needs_a_login():
    from fastapi.testclient import TestClient

    from app.main import app

    assert TestClient(app).get("/live-eligibility/NSE").status_code == 401


def test_live_segments_are_what_the_existing_gate_says():
    assert set(LIVE_SEGMENTS) == {"NSE", "MCX"}
