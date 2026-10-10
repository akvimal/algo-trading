"""Slippage (app/domain/slippage.py) and its wiring into the close paths: single
positions through _apply_realized_pnl, option groups at the three group-close
sites, the per-account setting, and its interaction with the Indian charges.
Expected values are computed by hand."""

import uuid
from datetime import time
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.api.routes import accounts as accounts_route
from app.auth import User
from app.domain import option_position_manager as opm
from app.domain import position_manager as pm
from app.domain.india_charges import NSE_EQUITY_INTRADAY, round_trip_charges
from app.domain.models import AccountUpdate
from app.domain.slippage import NO_SLIPPAGE_EXIT_REASONS, entry_slips, exit_slips, slippage_cost
from tests.test_option_position_manager import _accounts, _group as _fake_group, _legs as _fake_legs, _naked_leg
from tests.test_require_stop_loss import ME, RouteDb, _account_row

# --- the pure rules -----------------------------------------------------------------------------------


def test_the_cost_is_bps_of_each_slipping_leg_turnover():
    # 10 bps = 0.1%: 0.001 x 50,000 entry + 0.001 x 51,000 exit
    assert slippage_cost(10, 50000, 51000, "market", "square_off") == pytest.approx(101.0)


def test_a_non_positive_rate_costs_nothing():
    assert slippage_cost(0, 50000, 51000, "market", "square_off") == 0.0
    assert slippage_cost(-5, 50000, 51000, "market", "square_off") == 0.0
    assert slippage_cost(None, 50000, 51000, "market", "square_off") == 0.0


def test_a_resting_limit_entry_does_not_slip_but_a_market_or_unknown_entry_does():
    assert entry_slips("limit") is False
    assert entry_slips("market") is True and entry_slips(None) is True  # automated trades carry no order_type
    assert slippage_cost(10, 50000, 0, "limit", "target") == 0.0


@pytest.mark.parametrize("reason", sorted(NO_SLIPPAGE_EXIT_REASONS))
def test_target_and_liquidation_exits_do_not_slip(reason):
    assert exit_slips(reason) is False


@pytest.mark.parametrize(
    "reason",
    ["stop_loss", "combined_stop_loss", "individual_stop_loss", "spot_stop_loss", "square_off", "manual", "counter_signal", "exit_condition", None],
)
def test_stops_and_market_style_exits_slip(reason):
    assert exit_slips(reason) is True  # a stop-loss is a stop-MARKET


def test_a_limit_entry_and_a_target_exit_together_cost_nothing():
    assert slippage_cost(25, 50000, 51000, "limit", "combined_target") == 0.0


# --- single positions through the chokepoint ----------------------------------------------------------


def account(bps=10.0, charges=False, balance=100000.0):
    return SimpleNamespace(current_balance=balance, apply_charges=charges, slippage_bps=bps)


def position(**over):
    row = SimpleNamespace(
        id=uuid.uuid4(), segment="NSE", instrument_type="spot", horizon="intraday", action="BUY", entry_price=500.0,
        exit_price=510.0, quantity=100, option_group_id=None, pnl=None, order_type="market", exit_reason="square_off",
    )
    for k, v in over.items():
        setattr(row, k, v)
    return row


GROSS = 1000.0


def test_a_market_round_trip_is_netted_of_slippage_and_the_balance_gets_the_net():
    pos, acc = position(), account(10.0)
    pm._apply_realized_pnl(pos, acc, GROSS, None)
    cost = 0.001 * 50000 + 0.001 * 51000
    assert pos.slippage_cost == pytest.approx(cost) and pos.pnl == pytest.approx(GROSS - cost)
    assert acc.current_balance == pytest.approx(100000.0 + GROSS - cost)


def test_a_target_exit_with_a_limit_entry_records_no_slippage():
    pos = position(order_type="limit", exit_reason="target")
    pm._apply_realized_pnl(pos, account(10.0), GROSS, None)
    assert pos.pnl == GROSS and not hasattr(pos, "slippage_cost")


def test_a_target_exit_still_slips_on_a_market_entry():
    pos = position(order_type="market", exit_reason="target")
    pm._apply_realized_pnl(pos, account(10.0), GROSS, None)
    assert pos.slippage_cost == pytest.approx(0.001 * 50000)  # entry leg only


def test_with_the_rate_at_zero_nothing_changes_and_nothing_is_recorded():
    pos, acc = position(), account(0)
    pm._apply_realized_pnl(pos, acc, GROSS, None)
    assert pos.pnl == GROSS and acc.current_balance == 100000.0 + GROSS and not hasattr(pos, "slippage_cost")


@pytest.mark.parametrize("over", [{"option_group_id": uuid.uuid4()}, {"exit_price": None}])
def test_cases_where_slippage_does_not_apply(over):
    pos = position(**over)
    pm._apply_realized_pnl(pos, account(10.0), GROSS, None)
    assert pos.pnl == GROSS and not hasattr(pos, "slippage_cost")


def test_an_option_group_object_is_left_to_its_own_path():
    group = SimpleNamespace(id=uuid.uuid4(), segment="NSE", pnl=None)
    pm._apply_realized_pnl(group, account(10.0), 250.0, None)
    assert group.pnl == 250.0 and not hasattr(group, "slippage_cost")


def test_no_account_is_safe():
    pos = position()
    pm._apply_realized_pnl(pos, None, GROSS, None)
    assert pos.pnl == GROSS


def test_charges_and_slippage_stack_and_each_is_recorded_separately():
    pos, acc = position(), account(10.0, charges=True)
    pm._apply_realized_pnl(pos, acc, GROSS, None)
    charges = round_trip_charges(NSE_EQUITY_INTRADAY, "BUY", 500.0, 510.0, 100).total
    slip = 0.001 * 50000 + 0.001 * 51000
    assert pos.charges == pytest.approx(charges) and pos.slippage_cost == pytest.approx(slip)
    assert pos.pnl == pytest.approx(GROSS - charges - slip)


def test_slippage_applies_to_crypto_in_its_own_currency():
    pos = position(segment="CRYPTO", instrument_type="future", entry_price=60000.0, exit_price=60100.0, quantity=0.01)
    pm._apply_realized_pnl(pos, account(10.0), 1.0, 83.0)
    assert pos.slippage_cost == pytest.approx(0.001 * (600.0 + 601.0))


# --- option groups ---------------------------------------------------------------------------------------------------


def _accounts_with(bps, charges=False):
    accounts = _accounts()
    acc = accounts[(None, "NSE")]
    acc.apply_charges, acc.slippage_bps = charges, bps
    return accounts, acc


def _turnover(entry=(30.0, 10.0), exit_=(25.0, 10.0), qty=75):
    return (entry[0] + entry[1]) * qty, (exit_[0] + exit_[1]) * qty


def test_the_exit_monitor_slips_a_stop_loss_exit():
    group = _fake_group(net_debit=20.0, combined_stop_loss_price=18.0)
    long_leg, short_leg = _fake_legs()
    accounts, acc = _accounts_with(10.0)
    opm._evaluate_option_group_exits([group], {"group-1": {"BUY": long_leg, "SELL": short_leg}}, lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0}, accounts)
    entry_t, exit_t = _turnover()
    assert group.exit_reason == "combined_stop_loss"
    assert group.slippage_cost == pytest.approx(0.001 * (entry_t + exit_t))
    assert group.pnl == pytest.approx(((25.0 - 10.0) - 20.0) * 75 - group.slippage_cost)


def test_the_exit_monitor_does_not_slip_the_exit_leg_of_a_target_hit_on_a_limit_entry():
    group = _fake_group(net_debit=20.0, combined_target_price=30.0)
    group.order_type = "limit"  # FakeGroup does not take it as a constructor field
    long_leg, short_leg = _fake_legs()
    accounts, acc = _accounts_with(10.0)
    opm._evaluate_option_group_exits([group], {"group-1": {"BUY": long_leg, "SELL": short_leg}}, lambda ex, syms: {"NIFTY-CE": 45.0, "NIFTY-CE-OTM": 10.0}, accounts)
    assert group.exit_reason == "combined_target" and getattr(group, "slippage_cost", None) is None


def test_scheduled_square_off_slips():
    group = _fake_group(square_off_time=time(15, 0))
    long_leg, short_leg = _fake_legs()
    accounts, acc = _accounts_with(10.0)
    opm._evaluate_option_group_square_off_due([group], {"group-1": {"BUY": long_leg, "SELL": short_leg}}, lambda ex, syms: {"NIFTY-CE": 30.0, "NIFTY-CE-OTM": 10.0}, time(15, 30), accounts)
    entry_t, exit_t = _turnover(exit_=(30.0, 10.0))
    assert group.slippage_cost == pytest.approx(0.001 * (entry_t + exit_t))
    assert acc.current_balance == pytest.approx(1_000_000.0 + ((30.0 - 10.0) - 20.0) * 75 - group.slippage_cost)


def test_a_manual_group_close_slips_and_a_naked_group_uses_its_one_leg():
    long_leg = _naked_leg(entry_price=30.0)
    group = _fake_group(net_debit=30.0)
    acc = _accounts_with(10.0)[1]
    assert opm._close_group_at_cmp(group, long_leg, None, lambda ex, syms: {"NIFTY-CE": 20.0}, acc, "manual") is True
    assert group.slippage_cost == pytest.approx(0.001 * (30.0 * 75 + 20.0 * 75))


def test_group_charges_and_slippage_stack():
    group = _fake_group(square_off_time=time(15, 0))
    long_leg, short_leg = _fake_legs()
    accounts, acc = _accounts_with(10.0, charges=True)
    opm._evaluate_option_group_square_off_due([group], {"group-1": {"BUY": long_leg, "SELL": short_leg}}, lambda ex, syms: {"NIFTY-CE": 30.0, "NIFTY-CE-OTM": 10.0}, time(15, 30), accounts)
    assert group.charges > 0 and group.slippage_cost > 0
    assert group.pnl == pytest.approx(((30.0 - 10.0) - 20.0) * 75 - group.charges - group.slippage_cost)


def test_a_group_with_the_rate_at_zero_is_unchanged():
    group = _fake_group(square_off_time=time(15, 0))
    long_leg, short_leg = _fake_legs()
    accounts, _ = _accounts_with(0)
    opm._evaluate_option_group_square_off_due([group], {"group-1": {"BUY": long_leg, "SELL": short_leg}}, lambda ex, syms: {"NIFTY-CE": 32.0, "NIFTY-CE-OTM": 10.0}, time(15, 30), accounts)
    assert group.pnl == pytest.approx(((32.0 - 10.0) - 20.0) * 75) and getattr(group, "slippage_cost", None) is None


# --- the account setting and API ----------------------------------------------------------------------------------------


@pytest.fixture
def account_route():
    original = accounts_route.load_account
    yield
    accounts_route.load_account = original


def test_the_route_sets_and_reports_slippage_bps(account_route):
    row = _account_row(slippage_bps=0)
    accounts_route.load_account = lambda db, uid, seg, book="intraday": row
    out = accounts_route.update_account("NSE", AccountUpdate(slippage_bps=7.5), user=User(id=ME, token="t", is_admin=False), db=RouteDb())
    assert row.slippage_bps == 7.5 and out["slippage_bps"] == 7.5
    out = accounts_route.update_account("NSE", AccountUpdate(slippage_bps=0), user=User(id=ME, token="t", is_admin=False), db=RouteDb())
    assert row.slippage_bps == 0 and out["slippage_bps"] == 0  # an explicit 0 turns it off, it is not "unchanged"


def test_omitting_it_leaves_it_unchanged(account_route):
    row = _account_row(slippage_bps=5)
    accounts_route.load_account = lambda db, uid, seg, book="intraday": row
    accounts_route.update_account("NSE", AccountUpdate(capital_per_trade=1234), user=User(id=ME, token="t"), db=RouteDb())
    assert row.slippage_bps == 5


@pytest.mark.parametrize("bad", [-1, 501])
def test_out_of_range_rates_are_rejected(bad):
    with pytest.raises(ValidationError):
        AccountUpdate(slippage_bps=bad)


def test_the_orm_default_is_five_for_new_accounts_and_the_columns_exist():
    from app.adapters.db import models as db_models

    assert db_models.Account.__table__.c.slippage_bps.default.arg == 5
    for table in (db_models.Position, db_models.OptionPositionGroup):
        assert "slippage_cost" in table.__table__.c.keys()
