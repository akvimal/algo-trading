"""Indian charges wired into the close paths: single positions through
_apply_realized_pnl (the one place every close credits the balance), option
groups through _group_charges / _close_group_at_cmp, and the per-account
switch. The arithmetic itself is in test_india_charges.py."""

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.domain import option_position_manager as opm
from app.domain import position_manager as pm
from app.domain.india_charges import (
    MCX_FUTURES, NSE_EQUITY_INTRADAY, NSE_OPTIONS, group_charges, round_trip_charges,
)


def account(apply_charges=True, balance=100000.0):
    return SimpleNamespace(current_balance=balance, apply_charges=apply_charges)


def position(**over):
    row = SimpleNamespace(
        id=uuid.uuid4(), segment="NSE", instrument_type="spot", horizon="intraday", action="BUY",
        entry_price=500.0, exit_price=510.0, quantity=100, option_group_id=None, pnl=None,
    )
    for k, v in over.items():
        setattr(row, k, v)
    return row


GROSS = (510.0 - 500.0) * 100


# --- single positions ------------------------------------------------------------------------------


def test_a_nse_position_is_netted_of_its_charges_and_the_balance_gets_the_net():
    pos, acc = position(), account()
    expected = round_trip_charges(NSE_EQUITY_INTRADAY, "BUY", 500.0, 510.0, 100)
    pm._apply_realized_pnl(pos, acc, GROSS, None)
    assert pos.pnl == pytest.approx(GROSS - expected.total)
    assert acc.current_balance == pytest.approx(100000.0 + GROSS - expected.total)
    assert pos.charges == pytest.approx(expected.total)
    assert pos.charges_detail["total"] == round(expected.total, 2) and "schedule" in pos.charges_detail


def test_a_short_position_is_charged_with_the_sell_as_its_opening_leg():
    pos = position(action="SELL", instrument_type="future", entry_price=100.0, exit_price=95.0, quantity=1000)
    pm._apply_realized_pnl(pos, account(), 5000.0, None)
    assert pos.charges > 0 and pos.charges_detail["tax"] == pytest.approx(100.0 * 1000 * 0.0002, abs=0.01)


def test_mcx_positions_use_the_mcx_schedule():
    pos = position(segment="MCX", instrument_type="future", entry_price=70000.0, exit_price=70100.0, quantity=1)
    pm._apply_realized_pnl(pos, account(), 100.0, None)
    assert pos.charges == pytest.approx(round_trip_charges(MCX_FUTURES, "BUY", 70000.0, 70100.0, 1).total)


def test_with_the_switch_off_nothing_changes_and_nothing_is_recorded():
    pos, acc = position(), account(apply_charges=False)
    pm._apply_realized_pnl(pos, acc, GROSS, None)
    assert pos.pnl == GROSS and acc.current_balance == 100000.0 + GROSS and not hasattr(pos, "charges")


@pytest.mark.parametrize(
    "over",
    [
        {"segment": "CRYPTO", "instrument_type": "future"},  # has its own fee simulation
        {"option_group_id": uuid.uuid4()},  # an option LEG: the group is charged as a whole
        {"exit_price": None},  # no exit price yet
    ],
)
def test_cases_where_charges_do_not_apply(over):
    pos = position(**over)
    before = 100000.0
    acc = account()
    pm._apply_realized_pnl(pos, acc, GROSS, None if over.get("segment") != "CRYPTO" else 83.0)
    assert not hasattr(pos, "charges")
    assert pos.pnl == GROSS


def test_an_option_group_object_is_left_to_its_own_path():
    group = SimpleNamespace(id=uuid.uuid4(), segment="NSE", pnl=None)  # no instrument_type
    acc = account()
    pm._apply_realized_pnl(group, acc, 250.0, None)
    assert not hasattr(group, "charges") and group.pnl == 250.0


def test_no_account_means_no_charges_and_no_crash():
    pos = position()
    pm._apply_realized_pnl(pos, None, GROSS, None)
    assert pos.pnl == GROSS and not hasattr(pos, "charges")


# --- option groups -------------------------------------------------------------------------------------


def legs():
    long_leg = SimpleNamespace(symbol="NIFTY-C", exchange="NSE", action="BUY", entry_price=100.0, quantity=50)
    short_leg = SimpleNamespace(symbol="NIFTY-C2", exchange="NSE", action="SELL", entry_price=40.0, quantity=50)
    return long_leg, short_leg


def group(**over):
    g = SimpleNamespace(id=uuid.uuid4(), segment="NSE", horizon="intraday", exchange="NSE", quantity=50, net_debit=60.0,
                        open_fee=None, close_fee=None, user_id=None)
    for k, v in over.items():
        setattr(g, k, v)
    return g


def test_group_charges_sum_the_legs_and_are_recorded_on_the_group():
    long_leg, short_leg = legs()
    g = group()
    total = opm._group_charges(g, account(), long_leg, 120.0, short_leg, 45.0)
    expected = group_charges(NSE_OPTIONS, [("BUY", 100.0, 120.0, 50), ("SELL", 40.0, 45.0, 50)])
    assert total == pytest.approx(expected.total) and g.charges == pytest.approx(total) and g.charges_detail["total"] == round(total, 2)


def test_a_naked_group_charges_only_its_one_leg():
    long_leg, _ = legs()
    g = group()
    total = opm._group_charges(g, account(), long_leg, 120.0, None, 0.0)
    assert total == pytest.approx(group_charges(NSE_OPTIONS, [("BUY", 100.0, 120.0, 50)]).total)


@pytest.mark.parametrize("acc, seg", [(account(apply_charges=False), "NSE"), (None, "NSE"), (account(), "CRYPTO")])
def test_group_charges_do_not_apply_when_off_missing_or_crypto(acc, seg):
    long_leg, short_leg = legs()
    g = group(segment=seg)
    assert opm._group_charges(g, acc, long_leg, 120.0, short_leg, 45.0) == 0.0
    assert not hasattr(g, "charges")


def test_a_real_group_close_nets_the_charges_into_pnl_and_the_balance():
    long_leg, short_leg = legs()
    for leg in (long_leg, short_leg):
        leg.entry_time = datetime.now(timezone.utc)
    g, acc = group(), account()
    quotes = lambda exchange, symbols: {"NIFTY-C": 120.0, "NIFTY-C2": 45.0}
    assert opm._close_group_at_cmp(g, long_leg, short_leg, quotes, acc, "square_off") is True
    raw = ((120.0 - 45.0) - 60.0) * 50
    charges = group_charges(NSE_OPTIONS, [("BUY", 100.0, 120.0, 50), ("SELL", 40.0, 45.0, 50)]).total
    assert g.charges == pytest.approx(charges)
    assert g.pnl == pytest.approx(raw - charges) and acc.current_balance == pytest.approx(100000.0 + raw - charges)


def test_the_same_group_close_with_the_switch_off_is_unchanged():
    long_leg, short_leg = legs()
    g, acc = group(), account(apply_charges=False)
    quotes = lambda exchange, symbols: {"NIFTY-C": 120.0, "NIFTY-C2": 45.0}
    opm._close_group_at_cmp(g, long_leg, short_leg, quotes, acc, "square_off")
    assert g.pnl == pytest.approx(((120.0 - 45.0) - 60.0) * 50) and not hasattr(g, "charges")


# --- the two scheduled close sites, through the existing option-manager harness ----------------------------------

from datetime import time  # noqa: E402

from tests.test_option_position_manager import _accounts, _group as _fake_group, _legs as _fake_legs, _naked_leg  # noqa: E402


def _charged_accounts(on=True):
    accounts = _accounts()
    accounts[(None, "NSE")].apply_charges = on
    return accounts


def test_the_exit_monitor_nets_charges_when_a_group_stops_out():
    group = _fake_group(net_debit=20.0, combined_stop_loss_price=18.0)
    long_leg, short_leg = _fake_legs()
    accounts = _charged_accounts()
    opm._evaluate_option_group_exits(
        [group], {"group-1": {"BUY": long_leg, "SELL": short_leg}}, lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0}, accounts
    )
    raw = ((25.0 - 10.0) - 20.0) * 75
    charges = group_charges(NSE_OPTIONS, [("BUY", 30.0, 25.0, 75), ("SELL", 10.0, 10.0, 75)]).total
    assert group.exit_reason == "combined_stop_loss" and group.charges == pytest.approx(charges)
    assert group.pnl == pytest.approx(raw - charges)
    assert accounts[(None, "NSE")].current_balance == pytest.approx(1_000_000.0 + raw - charges)


def test_the_exit_monitor_nets_charges_for_a_naked_group():
    group = _fake_group(net_debit=30.0, combined_stop_loss_price=25.0)
    leg = _naked_leg(entry_price=30.0)
    accounts = _charged_accounts()
    opm._evaluate_option_group_exits([group], {"group-1": {"BUY": leg}}, lambda ex, syms: {"NIFTY-CE": 20.0}, accounts)
    charges = group_charges(NSE_OPTIONS, [("BUY", 30.0, 20.0, 75)]).total
    assert group.charges == pytest.approx(charges) and group.pnl == pytest.approx((20.0 - 30.0) * 75 - charges)


def test_scheduled_square_off_nets_charges():
    group = _fake_group(square_off_time=time(15, 0))
    long_leg, short_leg = _fake_legs()
    accounts = _charged_accounts()
    opm._evaluate_option_group_square_off_due(
        [group], {"group-1": {"BUY": long_leg, "SELL": short_leg}}, lambda ex, syms: {"NIFTY-CE": 30.0, "NIFTY-CE-OTM": 10.0}, time(15, 30), accounts
    )
    raw = ((30.0 - 10.0) - 20.0) * 75
    charges = group_charges(NSE_OPTIONS, [("BUY", 30.0, 30.0, 75), ("SELL", 10.0, 10.0, 75)]).total
    assert group.exit_reason == "square_off" and group.pnl == pytest.approx(raw - charges)
    assert accounts[(None, "NSE")].current_balance == pytest.approx(1_000_000.0 + raw - charges)


def test_the_scheduled_paths_are_unchanged_with_the_switch_off():
    group = _fake_group(square_off_time=time(15, 0))
    long_leg, short_leg = _fake_legs()
    accounts = _charged_accounts(on=False)
    opm._evaluate_option_group_square_off_due(
        [group], {"group-1": {"BUY": long_leg, "SELL": short_leg}}, lambda ex, syms: {"NIFTY-CE": 32.0, "NIFTY-CE-OTM": 10.0}, time(15, 30), accounts
    )
    assert group.pnl == pytest.approx(((32.0 - 10.0) - 20.0) * 75) and getattr(group, "charges", None) is None


# --- the account switch and the API surface ---------------------------------------------------------------------------

from app.api.routes import accounts as accounts_route  # noqa: E402
from app.auth import User  # noqa: E402
from app.domain.models import AccountUpdate  # noqa: E402
from tests.test_require_stop_loss import ME, RouteDb, _account_row  # noqa: E402


@pytest.fixture
def account_route():
    original = accounts_route.load_account
    yield
    accounts_route.load_account = original


def test_the_route_toggles_and_reports_apply_charges(account_route):
    row = _account_row(apply_charges=False)
    accounts_route.load_account = lambda db, uid, seg: row
    user = User(id=ME, token="t", is_admin=False)
    out = accounts_route.update_account("NSE", AccountUpdate(apply_charges=True), user=user, db=RouteDb())
    assert row.apply_charges is True and out["apply_charges"] is True
    out = accounts_route.update_account("NSE", AccountUpdate(apply_charges=False), user=user, db=RouteDb())
    assert row.apply_charges is False and out["apply_charges"] is False


def test_omitting_apply_charges_leaves_it_unchanged(account_route):
    row = _account_row(apply_charges=True)
    accounts_route.load_account = lambda db, uid, seg: row
    accounts_route.update_account("NSE", AccountUpdate(capital_per_trade=1234), user=User(id=ME, token="t"), db=RouteDb())
    assert row.apply_charges is True


def test_the_orm_default_is_on_for_new_accounts_and_the_columns_exist():
    from app.adapters.db import models as db_models

    assert db_models.Account.__table__.c.apply_charges.default.arg is True
    for table in (db_models.Position, db_models.OptionPositionGroup):
        assert {"charges", "charges_detail"} <= set(table.__table__.c.keys())
