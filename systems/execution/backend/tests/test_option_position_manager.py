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

from app.domain.option_position_manager import (
    _close_group_at_cmp,
    _evaluate_option_group_exits,
    _evaluate_option_group_square_off_due,
    compute_group_unrealized_pnl,
)
from app.domain.position_manager import _resolve_signal_conflicts


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
    square_off_time: Optional[time] = None
    exit_time: Optional[object] = None
    exit_reason: Optional[str] = None
    pnl: Optional[float] = None
    duplicate_signal_policy: str = "add_position"
    counter_signal_policy: str = "skip"


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
    return {segment: FakeAccount(segment=segment, starting_balance=balance, current_balance=balance)}


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
        group, long_leg, short_leg, lambda ex, syms: {"NIFTY-CE": 45.0, "NIFTY-CE-OTM": 15.0}, accounts["NSE"], "manual"
    )

    assert closed is True
    # combined exit = 45-15=30, entry net_debit=20 -> combined gain=10, * qty 75 = 750
    assert group.pnl == 750.0
    assert group.status == "CLOSED"
    assert group.exit_reason == "manual"
    assert accounts["NSE"].current_balance == 1_000_000.0 + 750.0
    assert long_leg.status == "CLOSED"
    assert long_leg.pnl == (45.0 - 30.0) * 75  # BUY leg: exit-entry
    assert short_leg.pnl == (10.0 - 15.0) * 75  # SELL leg: entry-exit


def test_close_group_at_cmp_returns_false_when_quote_unavailable():
    group = _group()
    long_leg, short_leg = _legs()

    closed = _close_group_at_cmp(group, long_leg, short_leg, lambda ex, syms: {"NIFTY-CE": 45.0}, _accounts()["NSE"], "manual")

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

    closed = _close_group_at_cmp(group, long_leg, None, lambda ex, syms: {"NIFTY-CE": 45.0}, accounts["NSE"], "manual")

    assert closed is True
    assert group.pnl == (45.0 - 30.0) * 75
    assert group.status == "CLOSED"
    assert long_leg.pnl == (45.0 - 30.0) * 75
    assert accounts["NSE"].current_balance == 1_000_000.0 + (45.0 - 30.0) * 75


# --- _evaluate_option_group_exits ----------------------------------------------------------------


def test_evaluate_option_group_exits_closes_on_combined_stop_loss():
    group = _group(net_debit=20.0, combined_stop_loss_price=18.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    # combined = 25-10=15, below combined_stop_loss_price=18 -> SL hit
    result = _evaluate_option_group_exits([group], legs, lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0}, _accounts())

    assert result == {"closed_stop_loss": 1, "closed_target": 0, "checked": 1}
    assert group.status == "CLOSED"
    assert group.exit_reason == "combined_stop_loss"


def test_evaluate_option_group_exits_closes_on_combined_target():
    group = _group(net_debit=20.0, combined_target_price=35.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    # combined = 45-8=37, above combined_target_price=35 -> target hit
    result = _evaluate_option_group_exits([group], legs, lambda ex, syms: {"NIFTY-CE": 45.0, "NIFTY-CE-OTM": 8.0}, _accounts())

    assert result == {"closed_stop_loss": 0, "closed_target": 1, "checked": 1}
    assert group.exit_reason == "combined_target"


def test_evaluate_option_group_exits_leaves_open_when_neither_hit():
    group = _group(net_debit=20.0, combined_stop_loss_price=10.0, combined_target_price=40.0)
    long_leg, short_leg = _legs()
    legs = {"group-1": {"BUY": long_leg, "SELL": short_leg}}

    result = _evaluate_option_group_exits([group], legs, lambda ex, syms: {"NIFTY-CE": 30.0, "NIFTY-CE-OTM": 10.0}, _accounts())

    assert result == {"closed_stop_loss": 0, "closed_target": 0, "checked": 1}
    assert group.status == "OPEN"


def test_evaluate_option_group_exits_naked_group_closes_on_stop_loss():
    group = _group(net_debit=30.0, combined_stop_loss_price=27.0)
    long_leg = _naked_leg(entry_price=30.0)
    legs = {"group-1": {"BUY": long_leg}}  # no 'SELL' key at all

    result = _evaluate_option_group_exits([group], legs, lambda ex, syms: {"NIFTY-CE": 25.0}, _accounts())

    assert result == {"closed_stop_loss": 1, "closed_target": 0, "checked": 1}
    assert group.status == "CLOSED"
    assert group.exit_reason == "combined_stop_loss"
    assert long_leg.status == "CLOSED"


def test_evaluate_option_group_exits_skips_group_with_missing_legs():
    group = _group(combined_stop_loss_price=10.0)

    result = _evaluate_option_group_exits([group], {}, lambda ex, syms: {}, _accounts())

    assert result == {"closed_stop_loss": 0, "closed_target": 0, "checked": 1}
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

    result = compute_group_unrealized_pnl([open_group, closed_group], legs, lambda ex, syms: {"NIFTY-CE": 35.0, "NIFTY-CE-OTM": 10.0})

    assert set(result) == {"group-1"}
    combined_price, unrealized = result["group-1"]
    assert combined_price == 25.0  # 35-10
    assert unrealized == (25.0 - 20.0) * 75  # (combined - net_debit) * quantity


def test_compute_group_unrealized_pnl_naked_group_uses_long_leg_price_directly():
    group = _group(net_debit=30.0)
    long_leg = _naked_leg(entry_price=30.0)
    legs = {"group-1": {"BUY": long_leg}}

    result = compute_group_unrealized_pnl([group], legs, lambda ex, syms: {"NIFTY-CE": 38.0})

    combined_price, unrealized = result["group-1"]
    assert combined_price == 38.0
    assert unrealized == (38.0 - 30.0) * 75


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
