"""Tests for app/domain/option_position_manager.py (Phase 4d of the
options trading module - see docs/architecture.md). Same "plain fakes
over a real Session" convention as test_position_manager.py - only the
pure functions here (_close_group_at_cmp, _evaluate_option_group_exits,
_evaluate_option_group_square_off_due, compute_group_unrealized_pnl,
_resolve_signal_conflicts reused against groups) are unit-tested this
way, matching test_position_manager.py's own scope (open_position/
open_option_group themselves, which need a real Session, aren't unit-
tested in this codebase - only their extracted pure logic is)."""

from dataclasses import dataclass, field
from datetime import time
from typing import Optional

import pytest

from app.domain.option_position_manager import (
    _close_delta_option_fee,
    _close_group_at_cmp,
    _evaluate_option_group_exits,
    _evaluate_option_group_square_off_due,
    _open_delta_option_fee,
    compute_group_unrealized_pnl,
)
from app.domain.position_manager import _resolve_capital_account, _resolve_signal_conflicts


@dataclass
class FakePosition:
    id: str
    status: str
    exchange: str
    symbol: str
    action: str
    entry_price: float
    quantity: float
    exit_price: Optional[float] = None
    exit_time: Optional[object] = None
    pnl: Optional[float] = None
    exit_reason: Optional[str] = None
    stop_loss_price: Optional[float] = None
    target_price: Optional[float] = None


@dataclass
class FakeGroup:
    id: str
    segment: str
    exchange: str
    underlying_symbol: str
    action: str
    status: str
    net_debit: float
    quantity: float
    combined_stop_loss_price: Optional[float] = None
    combined_target_price: Optional[float] = None
    sl_scope: str = "combined"
    entry_spot_price: Optional[float] = None
    spot_stop_loss_price: Optional[float] = None
    spot_target_price: Optional[float] = None
    spot_stop_loss_trailing_enabled: bool = False
    spot_stop_loss_indicator_type: Optional[str] = None
    spot_stop_loss_indicator_params: Optional[dict] = None
    spot_stop_loss_interval: Optional[str] = None
    stop_loss_future_symbol: Optional[str] = None
    stop_loss_future_exchange: Optional[str] = None
    open_fee: Optional[float] = None
    close_fee: Optional[float] = None
    square_off_time: Optional[time] = None
    exit_time: Optional[object] = None
    exit_reason: Optional[str] = None
    pnl: Optional[float] = None
    duplicate_signal_policy: str = "add_position"
    counter_signal_policy: str = "skip"
    strategy_id: Optional[str] = None
    # None = the automated Strategy-driven flow's legacy convention (the
    # default every existing test predates and still exercises) - see
    # infra/postgres/init/02-execution.sql's own comment on this column.
    user_id: Optional[str] = None


@dataclass
class FakeAccount:
    segment: str
    starting_balance: float
    current_balance: float


@dataclass
class FakeOrder:
    action: str
    duplicate_signal_policy: str = "add_position"
    counter_signal_policy: str = "skip"


def _accounts(balance: float = 1_000_000.0, segment: str = "NSE") -> dict:
    """Keyed to match _accounts_by_segment's real (user_id, segment) shape
    - None user_id is the automated-flow account every FakeGroup above
    defaults to, same convention test_position_manager.py's own _accounts
    helper uses."""
    return {(None, segment): FakeAccount(segment=segment, starting_balance=balance, current_balance=balance)}


def _legs(net_debit_entry: tuple[float, float] = (30.0, 10.0), quantity: float = 75) -> tuple:
    long_entry, short_entry = net_debit_entry
    long_leg = FakePosition(id="long", status="OPEN", exchange="NSE", symbol="NIFTY-CE", action="BUY", entry_price=long_entry, quantity=quantity)
    short_leg = FakePosition(id="short", status="OPEN", exchange="NSE", symbol="NIFTY-CE-OTM", action="SELL", entry_price=short_entry, quantity=quantity)
    return long_leg, short_leg


def _naked_leg(entry_price: float = 30.0, quantity: float = 75) -> FakePosition:
    """A naked (option_position_style='naked') group's sole leg - no
    short leg at all, distinct from _legs()'s always-BUY+SELL pair."""
    return FakePosition(id="long", status="OPEN", exchange="NSE", symbol="NIFTY-CE", action="BUY", entry_price=entry_price, quantity=quantity)


def _group(net_debit: float = 20.0, quantity: float = 75, **overrides) -> FakeGroup:
    defaults = dict(
        id="group-1", segment="NSE", exchange="NSE", underlying_symbol="NIFTY", action="BUY",
        status="OPEN", net_debit=net_debit, quantity=quantity,
    )
    defaults.update(overrides)
    return FakeGroup(**defaults)


# --- _close_group_at_cmp -------------------------------------------------------------------------


def test_close_group_at_cmp_computes_combined_pnl_and_credits_account():
    group = _group(net_debit=20.0, quantity=75)
    long_leg, short_leg = _legs()
    accounts = _accounts()

    closed = _close_group_at_cmp(
        group, long_leg, short_leg, lambda ex, syms: {"NIFTY-CE": 45.0, "NIFTY-CE-OTM": 15.0}, accounts[(None, "NSE")], "manual"
    )

    assert closed is True
    # combined exit = 45-15=30, entry net_debit=20 -> combined gain=10, * qty 75 = 750
    assert group.pnl == 750.0
    assert group.status == "CLOSED"
    assert group.exit_reason == "manual"
    assert accounts[(None, "NSE")].current_balance == 1_000_000.0 + 750.0
    assert long_leg.status == "CLOSED"
    assert long_leg.pnl == (45.0 - 30.0) * 75  # BUY leg: exit-entry
    assert short_leg.pnl == (10.0 - 15.0) * 75  # SELL leg: entry-exit


def test_close_group_at_cmp_returns_false_when_quote_unavailable():
    group = _group()
    long_leg, short_leg = _legs()

    closed = _close_group_at_cmp(group, long_leg, short_leg, lambda ex, syms: {"NIFTY-CE": 45.0}, _accounts()[(None, "NSE")], "manual")

    assert closed is False
    assert group.status == "OPEN"
    assert long_leg.status == "OPEN"


def test_close_group_at_cmp_naked_group_has_no_short_leg():
    # net_debit for a naked group is just the long leg's own entry price
    # (no short leg to net against) - combined_price degenerates to the
    # long leg's own CMP, same identity the module docstring establishes.
    group = _group(net_debit=30.0, quantity=75)
    long_leg = _naked_leg(entry_price=30.0)
    accounts = _accounts()

    closed = _close_group_at_cmp(group, long_leg, None, lambda ex, syms: {"NIFTY-CE": 45.0}, accounts[(None, "NSE")], "manual")

    assert closed is True
    assert group.pnl == (45.0 - 30.0) * 75
    assert group.status == "CLOSED"
    assert long_leg.pnl == (45.0 - 30.0) * 75
    assert accounts[(None, "NSE")].current_balance == 1_000_000.0 + (45.0 - 30.0) * 75


# --- _evaluate_option_group_exits ----------------------------------------------------------------


def test_evaluate_option_group_exits_closes_on_combined_stop_loss():
    group = _group(net_debit=20.0, combined_stop_loss_price=18.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    # combined = 25-10=15, below combined_stop_loss_price=18 -> SL hit
    result = _evaluate_option_group_exits([group], legs, lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0}, _accounts())

    assert result == {"closed_stop_loss": 1, "closed_target": 0, "trailed": 0, "checked": 1}
    assert group.status == "CLOSED"
    assert group.exit_reason == "combined_stop_loss"


def test_evaluate_option_group_exits_closes_on_combined_target():
    group = _group(net_debit=20.0, combined_target_price=35.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    # combined = 45-8=37, above combined_target_price=35 -> target hit
    result = _evaluate_option_group_exits([group], legs, lambda ex, syms: {"NIFTY-CE": 45.0, "NIFTY-CE-OTM": 8.0}, _accounts())

    assert result == {"closed_stop_loss": 0, "closed_target": 1, "trailed": 0, "checked": 1}
    assert group.exit_reason == "combined_target"


def test_evaluate_option_group_exits_credits_the_dedicated_strategy_account_when_one_exists():
    group = _group(net_debit=20.0, combined_target_price=35.0, strategy_id="strat-1")
    strategy_accounts = {"strat-1": FakeAccount(segment="NSE", starting_balance=50000.0, current_balance=50000.0)}
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    # combined = 45-8=37, above combined_target_price=35 -> target hit
    _evaluate_option_group_exits(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 45.0, "NIFTY-CE-OTM": 8.0}, _accounts(), strategy_accounts,
    )

    combined_pnl = (37.0 - 20.0) * group.quantity
    assert strategy_accounts["strat-1"].current_balance == 50000.0 + combined_pnl


def test_evaluate_option_group_exits_falls_back_to_segment_account_with_no_dedicated_row():
    group = _group(net_debit=20.0, combined_target_price=35.0, strategy_id="strat-1")
    accounts = _accounts(balance=200000.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    _evaluate_option_group_exits(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 45.0, "NIFTY-CE-OTM": 8.0}, accounts, {},
    )

    combined_pnl = (37.0 - 20.0) * group.quantity
    assert accounts[(None, "NSE")].current_balance == 200000.0 + combined_pnl


def test_evaluate_option_group_exits_leaves_open_when_neither_hit():
    group = _group(net_debit=20.0, combined_stop_loss_price=10.0, combined_target_price=40.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits([group], legs, lambda ex, syms: {"NIFTY-CE": 30.0, "NIFTY-CE-OTM": 10.0}, _accounts())

    assert result == {"closed_stop_loss": 0, "closed_target": 0, "trailed": 0, "checked": 1}
    assert group.status == "OPEN"


def test_evaluate_option_group_exits_closes_on_spot_stop_loss_buy():
    # No combined SL/target configured at all - only the underlying's own
    # price (not the combined premium) trips this close.
    group = _group(net_debit=20.0, spot_stop_loss_price=24800.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0, "NIFTY": 24750.0}, _accounts()
    )

    assert result == {"closed_stop_loss": 1, "closed_target": 0, "trailed": 0, "checked": 1}
    assert group.status == "CLOSED"
    assert group.exit_reason == "spot_stop_loss"
    assert long_leg.exit_reason == "stop_loss"


def test_evaluate_option_group_exits_closes_on_spot_stop_loss_sell():
    # SELL (bearish combo) - spot stop trips when the underlying RISES
    # through it, opposite direction from the BUY case above.
    group = _group(net_debit=20.0, action="SELL", spot_stop_loss_price=25200.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0, "NIFTY": 25250.0}, _accounts()
    )

    assert result == {"closed_stop_loss": 1, "closed_target": 0, "trailed": 0, "checked": 1}
    assert group.exit_reason == "spot_stop_loss"


def test_evaluate_option_group_exits_closes_on_spot_target_buy():
    # No premium SL/target - only a take-profit on the underlying's own
    # price (the Live Chart panel's Target field for an option order).
    group = _group(net_debit=20.0, spot_target_price=25200.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0, "NIFTY": 25300.0}, _accounts()
    )

    assert result == {"closed_stop_loss": 0, "closed_target": 1, "trailed": 0, "checked": 1}
    assert group.status == "CLOSED"
    assert group.exit_reason == "spot_target"
    assert long_leg.exit_reason == "target"


def test_evaluate_option_group_exits_closes_on_spot_target_sell():
    # SELL combo - the spot target trips when the underlying FALLS through it.
    group = _group(net_debit=20.0, action="SELL", spot_target_price=24800.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0, "NIFTY": 24700.0}, _accounts()
    )

    assert result == {"closed_stop_loss": 0, "closed_target": 1, "trailed": 0, "checked": 1}
    assert group.exit_reason == "spot_target"


def test_evaluate_option_group_exits_spot_stop_loss_wins_over_spot_target():
    # Both spot levels trip in the same tick (nonsensical prices, but the
    # branch order must be deterministic) - the protective stop wins,
    # matching sl-before-target priority everywhere else here.
    group = _group(net_debit=20.0, spot_stop_loss_price=25000.0, spot_target_price=24000.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0, "NIFTY": 24500.0}, _accounts()
    )

    assert group.exit_reason == "spot_stop_loss"


def test_evaluate_option_group_exits_spot_stop_loss_not_hit_leaves_open():
    group = _group(net_debit=20.0, spot_stop_loss_price=24000.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0, "NIFTY": 24750.0}, _accounts()
    )

    assert result == {"closed_stop_loss": 0, "closed_target": 0, "trailed": 0, "checked": 1}
    assert group.status == "OPEN"


def test_evaluate_option_group_exits_combined_stop_loss_takes_priority_over_spot():
    # Both the combined premium SL and the spot SL trip in the same tick -
    # combined_stop_loss wins the reason label (checked first), same
    # priority order sl_hit already had over target_hit.
    group = _group(net_debit=20.0, combined_stop_loss_price=18.0, spot_stop_loss_price=24800.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0, "NIFTY": 24750.0}, _accounts()
    )

    assert result == {"closed_stop_loss": 1, "closed_target": 0, "trailed": 0, "checked": 1}
    assert group.exit_reason == "combined_stop_loss"


def test_evaluate_option_group_exits_naked_group_closes_on_stop_loss():
    group = _group(net_debit=30.0, combined_stop_loss_price=27.0)
    long_leg = _naked_leg(entry_price=30.0)
    legs = {"group-1": {"BUY": long_leg}}  # no 'SELL' key at all

    result = _evaluate_option_group_exits([group], legs, lambda ex, syms: {"NIFTY-CE": 25.0}, _accounts())

    assert result == {"closed_stop_loss": 1, "closed_target": 0, "trailed": 0, "checked": 1}
    assert group.status == "CLOSED"
    assert group.exit_reason == "combined_stop_loss"
    assert long_leg.status == "CLOSED"


def test_evaluate_option_group_exits_combined_mode_leg_exit_reason_is_plain():
    # Regression check: positions.exit_reason's own CHECK constraint has
    # no 'combined_*'/'individual_*' variants at all (only
    # option_position_groups.exit_reason does) - each LEG must get the
    # plain 'stop_loss'/'target' value every other position already uses,
    # even though the GROUP's own exit_reason stays 'combined_stop_loss'.
    group = _group(net_debit=20.0, combined_stop_loss_price=18.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    _evaluate_option_group_exits([group], legs, lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0}, _accounts())

    assert group.exit_reason == "combined_stop_loss"
    assert long_leg.exit_reason == "stop_loss"
    assert short_leg.exit_reason == "stop_loss"


def test_evaluate_option_group_exits_individual_short_leg_trips_closes_both_legs():
    group = _group(net_debit=20.0, sl_scope="individual")
    long_leg, short_leg = _legs(net_debit_entry=(30.0, 10.0))
    long_leg.stop_loss_price = 20.0  # long's own SL far away, won't trip
    short_leg.stop_loss_price = 12.0  # SELL SL trips when price rises above this
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    # long barely moves (31, nowhere near its own SL of 20); short rises to
    # 15, above its own SL of 12 - only the SHORT leg's own threshold trips.
    result = _evaluate_option_group_exits(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 31.0, "NIFTY-CE-OTM": 15.0}, _accounts()
    )

    assert result == {"closed_stop_loss": 1, "closed_target": 0, "trailed": 0, "checked": 1}
    assert group.status == "CLOSED"
    assert group.exit_reason == "individual_stop_loss"
    # Both legs close together even though only the short leg's own
    # threshold actually tripped - the confirmed "whole group closes"
    # design, never a partial/mixed-status group.
    assert long_leg.status == "CLOSED"
    assert short_leg.status == "CLOSED"
    assert long_leg.exit_reason == "stop_loss"
    assert short_leg.exit_reason == "stop_loss"


def test_evaluate_option_group_exits_individual_mode_ignores_combined_price():
    # combined_stop_loss_price is set here specifically to prove it's
    # ignored in individual mode: combined_price (25-8=17) would trip a
    # combined threshold of 25, but neither leg's own threshold does.
    group = _group(net_debit=20.0, sl_scope="individual", combined_stop_loss_price=25.0)
    long_leg, short_leg = _legs(net_debit_entry=(30.0, 10.0))
    long_leg.stop_loss_price = 20.0  # BUY SL trips if cmp<=20 - 25 doesn't trip
    short_leg.stop_loss_price = 20.0  # SELL SL trips if cmp>=20 - 8 doesn't trip
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 8.0}, _accounts()
    )

    assert result == {"closed_stop_loss": 0, "closed_target": 0, "trailed": 0, "checked": 1}
    assert group.status == "OPEN"


def test_evaluate_option_group_exits_individual_naked_matches_combined_trigger():
    # For naked, individual and combined are mathematically identical
    # (net_debit == the single leg's own premium) - same threshold either
    # mode would have computed, same trigger behavior.
    group = _group(net_debit=30.0, sl_scope="individual")
    long_leg = _naked_leg(entry_price=30.0)
    long_leg.stop_loss_price = 27.0
    legs = {"group-1": {"BUY": long_leg}}

    result = _evaluate_option_group_exits([group], legs, lambda ex, syms: {"NIFTY-CE": 25.0}, _accounts())

    assert result == {"closed_stop_loss": 1, "closed_target": 0, "trailed": 0, "checked": 1}
    assert group.status == "CLOSED"
    assert group.exit_reason == "individual_stop_loss"
    assert long_leg.exit_reason == "stop_loss"


def test_evaluate_option_group_exits_skips_group_with_missing_legs():
    group = _group(combined_stop_loss_price=10.0)

    result = _evaluate_option_group_exits([group], {}, lambda ex, syms: {}, _accounts())

    assert result == {"closed_stop_loss": 0, "closed_target": 0, "trailed": 0, "checked": 1}
    assert group.status == "OPEN"


# --- _evaluate_option_group_square_off_due -------------------------------------------------------


def test_evaluate_option_group_square_off_due_closes_groups_past_their_time():
    group = _group(square_off_time=time(15, 0))
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_square_off_due(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 30.0, "NIFTY-CE-OTM": 10.0}, time(15, 30), _accounts()
    )

    assert result == {"closed": 1, "failed": 0, "checked": 1}
    assert group.status == "CLOSED"
    assert group.exit_reason == "square_off"


def test_evaluate_option_group_square_off_due_closes_naked_group():
    group = _group(net_debit=30.0, square_off_time=time(15, 0))
    long_leg = _naked_leg(entry_price=30.0)
    legs = {"group-1": {"BUY": long_leg}}

    result = _evaluate_option_group_square_off_due([group], legs, lambda ex, syms: {"NIFTY-CE": 32.0}, time(15, 30), _accounts())

    assert result == {"closed": 1, "failed": 0, "checked": 1}
    assert group.status == "CLOSED"
    assert group.pnl == (32.0 - 30.0) * 75


def test_evaluate_option_group_square_off_due_credits_the_dedicated_strategy_account_when_one_exists():
    group = _group(net_debit=30.0, square_off_time=time(15, 0), strategy_id="strat-1")
    strategy_accounts = {"strat-1": FakeAccount(segment="NSE", starting_balance=50000.0, current_balance=50000.0)}
    long_leg = _naked_leg(entry_price=30.0)
    legs = {"group-1": {"BUY": long_leg}}

    _evaluate_option_group_square_off_due(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 32.0}, time(15, 30), _accounts(), strategy_accounts,
    )

    assert strategy_accounts["strat-1"].current_balance == 50000.0 + (32.0 - 30.0) * 75


def test_evaluate_option_group_square_off_due_ignores_groups_not_yet_due():
    group = _group(square_off_time=time(15, 0))
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_square_off_due(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 30.0, "NIFTY-CE-OTM": 10.0}, time(14, 0), _accounts()
    )

    assert result == {"closed": 0, "failed": 0, "checked": 0}
    assert group.status == "OPEN"


def test_evaluate_option_group_square_off_due_counts_quote_failure_as_failed():
    group = _group(square_off_time=time(15, 0))
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_square_off_due([group], legs, lambda ex, syms: {}, time(15, 30), _accounts())

    assert result == {"closed": 0, "failed": 1, "checked": 1}
    assert group.status == "OPEN"


# --- compute_group_unrealized_pnl ----------------------------------------------------------------


def test_compute_group_unrealized_pnl_only_reports_open_groups():
    open_group = _group(net_debit=20.0)
    closed_group = _group(net_debit=20.0, status="CLOSED")
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = compute_group_unrealized_pnl(
        [open_group, closed_group], legs, lambda ex, syms: {"NIFTY-CE": 35.0, "NIFTY-CE-OTM": 10.0, "NIFTY": 24800.0}
    )

    assert set(result) == {"group-1"}
    mtm = result["group-1"]
    assert mtm["combined_price"] == 25.0  # 35-10
    assert mtm["unrealized_pnl"] == (25.0 - 20.0) * 75  # (combined - net_debit) * quantity
    assert mtm["spot_price"] == 24800.0


def test_compute_group_unrealized_pnl_naked_group_uses_long_leg_price_directly():
    group = _group(net_debit=30.0)
    long_leg = _naked_leg(entry_price=30.0)
    legs = {"group-1": {"BUY": long_leg}}

    result = compute_group_unrealized_pnl([group], legs, lambda ex, syms: {"NIFTY-CE": 38.0})

    mtm = result["group-1"]
    assert mtm["combined_price"] == 38.0
    assert mtm["unrealized_pnl"] == (38.0 - 30.0) * 75
    assert mtm["spot_price"] is None  # no "NIFTY" quote given - best-effort, doesn't block the group's own pricing


def test_compute_group_unrealized_pnl_reports_legwise_live_price_and_pnl():
    group = _group(net_debit=20.0)
    long_leg, short_leg = _legs(net_debit_entry=(30.0, 10.0))  # long entered at 30, short at 10
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = compute_group_unrealized_pnl(
        [group], legs, lambda ex, syms: {"NIFTY-CE": 35.0, "NIFTY-CE-OTM": 8.0, "NIFTY": 24800.0}
    )

    leg_mtm = result["group-1"]["legs"]
    assert set(leg_mtm) == {"long", "short"}
    long_price, long_pnl = leg_mtm["long"]
    short_price, short_pnl = leg_mtm["short"]
    assert long_price == 35.0
    assert long_pnl == (35.0 - 30.0) * 75  # BUY - gains as price rises
    assert short_price == 8.0
    assert short_pnl == (10.0 - 8.0) * 75  # SELL - gains as price falls


def test_compute_group_unrealized_pnl_naked_group_has_no_short_leg_entry():
    group = _group(net_debit=30.0)
    long_leg = _naked_leg(entry_price=30.0)
    legs = {"group-1": {"BUY": long_leg}}

    result = compute_group_unrealized_pnl([group], legs, lambda ex, syms: {"NIFTY-CE": 38.0})

    leg_mtm = result["group-1"]["legs"]
    assert set(leg_mtm) == {"long"}


# --- _resolve_signal_conflicts reused against option groups ---------------------------------------


def test_resolve_signal_conflicts_reused_unchanged_against_option_groups():
    """_resolve_signal_conflicts (position_manager.py) is duck-typed on
    just .action - confirms it works against FakeGroup exactly like it
    already does against FakePosition, no option-specific fork needed."""
    same_direction_group = _group(action="BUY")
    order = FakeOrder(action="BUY", duplicate_signal_policy="skip")

    to_close, reject_reason = _resolve_signal_conflicts([same_direction_group], order)

    assert to_close == []
    assert reject_reason is not None and "duplicate_signal_policy=skip" in reject_reason


def test_resolve_signal_conflicts_close_and_flip_reused_against_option_groups():
    opposite_group = _group(action="SELL")
    order = FakeOrder(action="BUY", counter_signal_policy="close_and_flip")

    to_close, reject_reason = _resolve_signal_conflicts([opposite_group], order)

    assert to_close == [opposite_group]
    assert reject_reason is None


# --- future-referenced spot_stop_loss_price (auto-computed SuperTrend stop, added 2026-08-21) -----
#
# Same 20-bar steady-uptrend fixture test_position_manager.py's own
# supertrend tests use: compute_supertrend(candles, period=5, multiplier=1.0)
# settles to candles[-1]["close"] - 2.0 = 67.0.

_ST_FUTURE_CANDLES = [{"close": 50 + i, "high": 50 + i + 1, "low": 50 + i - 1} for i in range(20)]


def test_evaluate_option_group_exits_spot_stop_loss_checked_against_future_when_set():
    # underlying's own spot quote (24750, well below the stop) would trip
    # a plain spot_stop_loss_price - but this group carries
    # stop_loss_future_symbol, so it must be checked against the FUTURE's
    # own quote instead, which hasn't reached the stop yet.
    group = _group(
        net_debit=20.0, spot_stop_loss_price=25000.0,
        stop_loss_future_symbol="NIFTY-FUT", stop_loss_future_exchange="NSE",
    )
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits(
        [group], legs,
        lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0, "NIFTY": 24700.0, "NIFTY-FUT": 25100.0},
        _accounts(),
    )

    assert result == {"closed_stop_loss": 0, "closed_target": 0, "trailed": 0, "checked": 1}
    assert group.status == "OPEN"


def test_evaluate_option_group_exits_trails_future_supertrend_stop():
    group = _group(
        net_debit=20.0, action="BUY", spot_stop_loss_price=60.0,
        spot_stop_loss_trailing_enabled=True, spot_stop_loss_indicator_type="supertrend",
        spot_stop_loss_indicator_params={"period": 5, "multiplier": 1.0}, spot_stop_loss_interval="5min",
        stop_loss_future_symbol="NIFTY-FUT", stop_loss_future_exchange="NSE",
    )
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits(
        [group], legs,
        lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0, "NIFTY-FUT": 69.0},
        _accounts(), get_candle_history=lambda *a: _ST_FUTURE_CANDLES,
    )

    assert result == {"closed_stop_loss": 0, "closed_target": 0, "trailed": 1, "checked": 1}
    assert group.spot_stop_loss_price == pytest.approx(67.0)
    assert group.status == "OPEN"


def test_evaluate_option_group_exits_future_supertrend_trailing_never_loosens():
    group = _group(
        net_debit=20.0, action="BUY", spot_stop_loss_price=68.0,  # already tighter than the 67.0 candidate below
        spot_stop_loss_trailing_enabled=True, spot_stop_loss_indicator_type="supertrend",
        spot_stop_loss_indicator_params={"period": 5, "multiplier": 1.0}, spot_stop_loss_interval="5min",
        stop_loss_future_symbol="NIFTY-FUT", stop_loss_future_exchange="NSE",
    )
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits(
        [group], legs,
        lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0, "NIFTY-FUT": 69.0},
        _accounts(), get_candle_history=lambda *a: _ST_FUTURE_CANDLES,
    )

    assert result["trailed"] == 0
    assert group.spot_stop_loss_price == 68.0


def test_evaluate_option_group_exits_future_supertrend_trailing_skipped_without_get_candle_history():
    # get_candle_history defaults to None - a trailing-enabled group must
    # not crash, same backward-compatibility guarantee position_manager's
    # own _evaluate_exits has for its indicator trailing path.
    group = _group(
        net_debit=20.0, action="BUY", spot_stop_loss_price=60.0,
        spot_stop_loss_trailing_enabled=True, spot_stop_loss_indicator_type="supertrend",
        spot_stop_loss_indicator_params={"period": 5, "multiplier": 1.0}, spot_stop_loss_interval="5min",
        stop_loss_future_symbol="NIFTY-FUT", stop_loss_future_exchange="NSE",
    )
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits(
        [group], legs,
        lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0, "NIFTY-FUT": 69.0},
        _accounts(),
    )

    assert result["trailed"] == 0
    assert group.spot_stop_loss_price == 60.0


# --- Delta Exchange option trading-fee simulation (CRYPTO only, added 2026-08-21) ------------------


def test_open_delta_option_fee_none_for_non_crypto():
    assert _open_delta_option_fee("NSE", entry_spot_price=25000.0, quantity=75, long_premium=30.0) is None


def test_open_delta_option_fee_naked_uses_underlying_notional():
    from app.domain.delta_fees import compute_option_trading_fee

    fee = _open_delta_option_fee("CRYPTO", entry_spot_price=70_000.0, quantity=0.1, long_premium=1_500.0)
    expected = compute_option_trading_fee(70_000.0 * 0.1, 1_500.0 * 0.1)
    assert fee == pytest.approx(expected)


def test_open_delta_option_fee_spread_sums_both_legs():
    from app.domain.delta_fees import compute_option_trading_fee

    fee = _open_delta_option_fee("CRYPTO", entry_spot_price=70_000.0, quantity=0.1, long_premium=1_500.0, short_premium=800.0)
    expected_long = compute_option_trading_fee(70_000.0 * 0.1, 1_500.0 * 0.1)
    expected_short = compute_option_trading_fee(70_000.0 * 0.1, 800.0 * 0.1)
    assert fee == pytest.approx(expected_long + expected_short)


def test_open_delta_option_fee_falls_back_to_premium_notional_when_spot_missing():
    from app.domain.delta_fees import compute_option_trading_fee

    fee = _open_delta_option_fee("CRYPTO", entry_spot_price=None, quantity=0.1, long_premium=1_500.0)
    expected = compute_option_trading_fee(1_500.0 * 0.1, 1_500.0 * 0.1)
    assert fee == pytest.approx(expected)


def test_close_delta_option_fee_is_the_same_formula_at_exit_quotes():
    assert _close_delta_option_fee("CRYPTO", 71_000.0, 0.1, 1_600.0) == pytest.approx(
        _open_delta_option_fee("CRYPTO", 71_000.0, 0.1, 1_600.0)
    )


def test_close_group_at_cmp_nets_fees_for_crypto_group():
    group = _group(net_debit=1_500.0, quantity=0.1, segment="CRYPTO", exchange="CRYPTO", open_fee=8.85)
    long_leg = FakePosition(id="long", status="OPEN", exchange="CRYPTO", symbol="BTC-CALL", action="BUY", entry_price=1_500.0, quantity=0.1)
    accounts = _accounts(segment="CRYPTO")

    closed = _close_group_at_cmp(group, long_leg, None, lambda ex, syms: {"BTC-CALL": 1_800.0}, accounts[(None, "CRYPTO")], "manual")

    assert closed is True
    assert group.close_fee is not None and group.close_fee > 0
    raw_pnl = (1_800.0 - 1_500.0) * 0.1
    assert group.pnl == pytest.approx(raw_pnl - 8.85 - group.close_fee)


def test_close_group_at_cmp_credits_inr_converted_pnl_for_crypto_group():
    # group.pnl (the stored figure) stays raw USD - only the account (INR)
    # credit is converted, same split _apply_realized_pnl enforces for
    # plain positions (see test_position_manager.py's own currency tests).
    group = _group(net_debit=1_500.0, quantity=0.1, segment="CRYPTO", exchange="CRYPTO", open_fee=8.85)
    long_leg = FakePosition(id="long", status="OPEN", exchange="CRYPTO", symbol="BTC-CALL", action="BUY", entry_price=1_500.0, quantity=0.1)
    accounts = _accounts(balance=200_000.0, segment="CRYPTO")

    _close_group_at_cmp(group, long_leg, None, lambda ex, syms: {"BTC-CALL": 1_800.0}, accounts[(None, "CRYPTO")], "manual", usdinr_rate=90.0)

    usd_pnl = group.pnl
    assert accounts[(None, "CRYPTO")].current_balance == pytest.approx(200_000.0 + usd_pnl * 90.0)


def test_close_group_at_cmp_unaffected_for_non_crypto_group():
    # open_fee stays None for NSE/MCX - _net_pnl_with_fees-equivalent
    # netting must be a complete no-op, matching every test above this one
    # in the file (all written before this feature existed).
    group = _group(net_debit=20.0, quantity=75)
    long_leg, short_leg = _legs()
    accounts = _accounts()

    _close_group_at_cmp(group, long_leg, short_leg, lambda ex, syms: {"NIFTY-CE": 45.0, "NIFTY-CE-OTM": 15.0}, accounts[(None, "NSE")], "manual")

    assert group.close_fee is None
    assert group.pnl == pytest.approx((45.0 - 15.0 - 20.0) * 75)
