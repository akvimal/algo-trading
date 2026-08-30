from dataclasses import dataclass
from datetime import datetime, time, timezone
from types import SimpleNamespace
from typing import Optional

import pytest

from app.domain.position_manager import (
    _STOP_LOSS_COMPUTE_FUNCS,
    _apply_nse_leverage,
    _apply_realized_pnl,
    _evaluate_exits,
    _evaluate_square_off_due,
    _live_status_reason,
    _net_pnl_with_costs,
    _open_delta_fee_fields,
    _resolve_capital_account,
    _resolve_signal_conflicts,
    _resolve_stop_loss,
    compute_atr,
    compute_ema,
    compute_max_drawdown,
    compute_pnl,
    compute_quantity,
    compute_risk_based_quantity,
    compute_stop_loss_percent_price,
    compute_strategy_performance,
    compute_supertrend,
    compute_target_percent_price,
    compute_unrealized_pnl,
    is_supported,
    is_within_intraday_window,
    settle_live_position_exit,
)


@dataclass
class FakePosition:
    id: str
    status: str
    exchange: str
    symbol: str
    action: str
    entry_price: float
    quantity: float
    segment: str = "NSE"
    stop_loss_price: Optional[float] = None
    target_price: Optional[float] = None
    trailing_stop_enabled: bool = False
    stop_loss_method: Optional[str] = None
    stop_loss_interval: Optional[str] = None
    stop_loss_percent: Optional[float] = None
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict] = None
    breakeven_triggered: bool = False
    entry_time: Optional[object] = None
    exit_price: Optional[float] = None
    exit_time: Optional[object] = None
    pnl: Optional[float] = None
    exit_reason: Optional[str] = None
    square_off_time: Optional[time] = None
    strategy_id: Optional[str] = None
    open_fee: Optional[float] = None
    close_fee: Optional[float] = None
    margin_posted: Optional[float] = None
    liquidation_price: Optional[float] = None
    mtf_interest_rate_pct: Optional[float] = None
    interest_charged: Optional[float] = None
    # None = the automated Strategy-driven flow's legacy convention (the
    # default every existing test predates and still exercises) - see
    # infra/postgres/init/02-execution.sql's own comment on this column.
    user_id: Optional[str] = None
    # Live-broker-adapter P2 - see infra/postgres/init/02-execution.sql's
    # own comment on this column. False (paper) for every existing test.
    is_live_broker_order: bool = False
    # Live-broker-adapter P3 item 14 - see that column's own comment.
    live_trading_user_id: Optional[str] = None


@dataclass
class FakeAccount:
    segment: str
    starting_balance: float
    current_balance: float


@dataclass
class FakeOrder:
    """Stands in for ResolvedOrder in _resolve_signal_conflicts tests -
    only .action/.duplicate_signal_policy/.counter_signal_policy are read."""

    action: str
    duplicate_signal_policy: str = "add_position"
    counter_signal_policy: str = "skip"


def _accounts(balance: float = 1_000_000.0, segment: str = "NSE") -> dict:
    """A fresh {(user_id, segment): FakeAccount} dict per call - keyed to
    match _accounts_by_segment's real shape (None user_id = the
    automated-flow account every FakePosition above defaults to) -
    _apply_realized_pnl mutates the account object in place, so tests
    that assert on balance need their own isolated instance rather than a
    shared module-level one."""
    return {(None, segment): FakeAccount(segment=segment, starting_balance=balance, current_balance=balance)}


def test_compute_pnl_buy_is_long():
    assert compute_pnl("BUY", entry_price=100.0, exit_price=110.0, quantity=10) == 100.0


def test_compute_pnl_sell_is_short():
    assert compute_pnl("SELL", entry_price=100.0, exit_price=90.0, quantity=10) == 100.0


def test_compute_quantity_whole_shares_only():
    assert compute_quantity(capital_per_trade=50000, price=2500.0) == 20
    assert compute_quantity(capital_per_trade=50000, price=3333.0) == 15  # floors, not rounds (50000/3333 = 15.0015)


def test_compute_quantity_floors_to_one_share_when_capital_too_small():
    assert compute_quantity(capital_per_trade=1000, price=5000.0) == 1


def test_compute_quantity_lot_size_one_is_unchanged_default():
    # lot_size defaults to 1 - NSE spot's existing behavior is untouched.
    assert compute_quantity(capital_per_trade=50000, price=2500.0, lot_size=1) == 20


def test_compute_quantity_floors_to_whole_lots():
    # NIFTY future @ 24500, lot_size=65 -> one lot costs 1,592,500;
    # capital=2,000,000 affords exactly 1 lot (65 units), not a partial lot.
    assert compute_quantity(capital_per_trade=2_000_000, price=24500.0, lot_size=65) == 65


def test_compute_quantity_floors_to_minimum_one_lot_when_capital_too_small():
    # Even 1 lot (65 units * 24500) can't be afforded by this capital -
    # still floors to 1 lot (65 units), same "always opens" rule as spot.
    assert compute_quantity(capital_per_trade=1000, price=24500.0, lot_size=65) == 65


def test_compute_quantity_fractional_lot_size_for_crypto():
    # Delta Exchange India CRYPTO perpetuals have a real fractional
    # contract_value (BTCUSD=0.001 BTC/lot, confirmed live against
    # /v2/products - see market-data's DeltaProvider.get_lot_size) -
    # capital=1000 USD @ price=63000 -> floor(1000/(63000*0.001))=15 lots
    # -> 15 * 0.001 = 0.015 BTC total, not 15 whole BTC.
    assert compute_quantity(capital_per_trade=1000, price=63000.0, lot_size=0.001) == pytest.approx(0.015)


def test_is_supported_intraday_spot_or_future():
    assert is_supported("intraday", "spot") is True
    assert is_supported("intraday", "future") is True
    assert is_supported("positional", "future") is False
    assert is_supported("intraday", "option") is False


def test_is_within_intraday_window_before_square_off():
    # 09:00 UTC == 14:30 IST, before a 15:00 IST square-off.
    now = datetime(2026, 8, 11, 9, 0, tzinfo=timezone.utc)
    assert is_within_intraday_window(now, time(15, 0), "Asia/Kolkata") is True


def test_is_within_intraday_window_after_square_off():
    # 10:00 UTC == 15:30 IST, after a 15:00 IST square-off.
    now = datetime(2026, 8, 11, 10, 0, tzinfo=timezone.utc)
    assert is_within_intraday_window(now, time(15, 0), "Asia/Kolkata") is False


def test_is_within_intraday_window_none_never_rejects():
    # square_off_time is now the SEGMENT's own account.square_off_time
    # (execution.accounts), not a per-Strategy value - None means that
    # segment never force-closes (CRYPTO's default) - always within
    # window regardless of time of day.
    now = datetime(2026, 8, 11, 23, 59, tzinfo=timezone.utc)
    assert is_within_intraday_window(now, None, "Asia/Kolkata") is True


def test_compute_unrealized_pnl_marks_open_positions_only():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY", entry_price=2500, quantity=10),
        FakePosition(id="p2", status="CLOSED", exchange="NSE", symbol="TCS", action="BUY", entry_price=3400, quantity=5),
    ]
    result = compute_unrealized_pnl(positions, get_ltp_batch=lambda exchange, symbols: {s: 2550.0 for s in symbols})

    assert result == {"p1": (2550.0, 500.0)}  # (2550-2500)*10
    assert "p2" not in result  # CLOSED - already has real pnl, not marked


def test_compute_unrealized_pnl_batches_one_call_per_exchange():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY", entry_price=2500, quantity=10),
        FakePosition(id="p2", status="OPEN", exchange="NSE", symbol="TCS", action="SELL", entry_price=3400, quantity=5),
        FakePosition(id="p3", status="OPEN", exchange="NSE", symbol="RELIANCE", action="SELL", entry_price=2600, quantity=5),
    ]
    calls = []

    def fake_get_ltp_batch(exchange: str, symbols: list) -> dict:
        calls.append((exchange, sorted(symbols)))
        prices = {"RELIANCE": 2550.0, "TCS": 3350.0}
        return {s: prices[s] for s in symbols}

    result = compute_unrealized_pnl(positions, get_ltp_batch=fake_get_ltp_batch)

    assert len(calls) == 1  # one batch call covering both distinct symbols on this exchange
    assert calls[0] == ("NSE", ["RELIANCE", "TCS"])
    assert result["p1"] == (2550.0, 500.0)  # BUY: (2550-2500)*10
    assert result["p2"] == (3350.0, 250.0)  # SELL: (3400-3350)*5
    assert result["p3"] == (2550.0, 250.0)  # SELL: (2600-2550)*5


def test_compute_unrealized_pnl_omits_positions_when_batch_fails():
    positions = [FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY", entry_price=2500, quantity=10)]

    def failing_get_ltp_batch(exchange: str, symbols: list) -> dict:
        raise RuntimeError("quote batch unavailable")

    result = compute_unrealized_pnl(positions, get_ltp_batch=failing_get_ltp_batch)

    assert result == {}


def test_compute_unrealized_pnl_omits_positions_missing_from_batch_response():
    positions = [FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY", entry_price=2500, quantity=10)]

    result = compute_unrealized_pnl(positions, get_ltp_batch=lambda exchange, symbols: {})

    assert result == {}


# --- stop-loss / target percent pricing -------------------------------------------------


def test_compute_stop_loss_percent_price_buy_is_below_entry():
    assert compute_stop_loss_percent_price("BUY", entry_price=100.0, stop_loss_percent=2.0) == 98.0


def test_compute_stop_loss_percent_price_sell_is_above_entry():
    assert compute_stop_loss_percent_price("SELL", entry_price=100.0, stop_loss_percent=2.0) == 102.0


def test_compute_target_percent_price_buy_is_above_entry():
    assert compute_target_percent_price("BUY", entry_price=100.0, target_percent=4.0) == 104.0


def test_compute_target_percent_price_sell_is_below_entry():
    assert compute_target_percent_price("SELL", entry_price=100.0, target_percent=4.0) == 96.0


# --- risk-based quantity ------------------------------------------------------------------


def test_compute_risk_based_quantity_risk_binding():
    # risk_amount = 50000 * 1% = 500; stop_distance = 100-98 = 2 -> 250 shares risk-based
    # capital cap = floor(50000/100) = 500 shares - risk binds (smaller)
    qty = compute_risk_based_quantity(capital_per_trade=50000, risk_per_trade_pct=1.0, entry_price=100.0, stop_loss_price=98.0)
    assert qty == 250


def test_compute_risk_based_quantity_capital_cap_binding():
    # risk_amount = 50000 * 10% = 5000; stop_distance = 100-99 = 1 -> 5000 shares risk-based
    # capital cap = floor(50000/100) = 500 shares - capital cap binds (smaller)
    qty = compute_risk_based_quantity(capital_per_trade=50000, risk_per_trade_pct=10.0, entry_price=100.0, stop_loss_price=99.0)
    assert qty == 500


def test_compute_risk_based_quantity_floors_to_one_share_when_too_small():
    # risk_amount = 1000 * 0.1% = 1; stop_distance = 100 -> 0 shares risk-based, floors to 1
    qty = compute_risk_based_quantity(capital_per_trade=1000, risk_per_trade_pct=0.1, entry_price=1000.0, stop_loss_price=900.0)
    assert qty == 1


def test_compute_risk_based_quantity_lot_size_one_is_unchanged_default():
    qty = compute_risk_based_quantity(
        capital_per_trade=50000, risk_per_trade_pct=1.0, entry_price=100.0, stop_loss_price=98.0, lot_size=1
    )
    assert qty == 250  # same as test_compute_risk_based_quantity_risk_binding


def test_compute_risk_based_quantity_floors_to_whole_lots():
    # risk_amount = 2,000,000 * 1% = 20,000; stop_distance = 24500-24400=100;
    # lot_size=65 -> risk-based lots = floor(20000/(100*65)) = floor(3.08)=3 lots
    # capital cap lots = floor(2,000,000/(24500*65)) = floor(1.256)=1 lot -> capital binds
    qty = compute_risk_based_quantity(
        capital_per_trade=2_000_000, risk_per_trade_pct=1.0, entry_price=24500.0, stop_loss_price=24400.0, lot_size=65
    )
    assert qty == 65  # 1 lot, capital-capped
    assert qty % 65 == 0


def test_compute_risk_based_quantity_floors_to_minimum_one_lot():
    qty = compute_risk_based_quantity(
        capital_per_trade=1000, risk_per_trade_pct=0.1, entry_price=24500.0, stop_loss_price=24400.0, lot_size=65
    )
    assert qty == 65  # 1 whole lot, not 0


def test_compute_risk_based_quantity_fractional_lot_size_for_crypto():
    # BTCUSD, lot_size=0.001 - risk-based lots = floor(1000/(500*0.001)) = 2000 lots;
    # capital cap lots = floor(compute_quantity(50000, 63000, 0.001)/0.001) = floor(0.793/0.001*0.001)... -
    # capital binds: floor(50000/(63000*0.001))=793 lots -> 793*0.001=0.793 BTC.
    qty = compute_risk_based_quantity(
        capital_per_trade=50000, risk_per_trade_pct=2.0, entry_price=63000.0, stop_loss_price=62500.0, lot_size=0.001
    )
    assert qty == pytest.approx(0.793)


def test_compute_risk_based_quantity_capital_cap_not_off_by_one_lot_for_fractional_lot_size():
    # Regression test (contract-guardian caught this live): capital_capped_lots
    # used to be computed as compute_quantity(...) // lot_size - a multiply-
    # then-divide round trip that's exact for whole-number lot_size but
    # silently under-counts by 1 lot for many fractional (capital, price,
    # lot_size) combinations, since float division has no tolerance for the
    # representation error the earlier multiply introduced. capital=11,
    # price=1000, lot_size=0.001 is exactly such a combination - the old code
    # returned 0.01 (10 lots) instead of the correct 0.011 (11 lots).
    qty = compute_risk_based_quantity(
        capital_per_trade=11, risk_per_trade_pct=100.0, entry_price=1000.0, stop_loss_price=999.0, lot_size=0.001
    )
    assert qty == pytest.approx(0.011)


# --- account balance bookkeeping (_apply_realized_pnl) --------------------------------------


def test_apply_realized_pnl_credits_account_on_a_winner():
    account = FakeAccount(segment="NSE", starting_balance=200000.0, current_balance=200000.0)
    pos = FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY", entry_price=100.0, quantity=10)

    _apply_realized_pnl(pos, account, 500.0)

    assert pos.pnl == 500.0
    assert account.current_balance == 200500.0


def test_apply_realized_pnl_debits_account_on_a_loser():
    account = FakeAccount(segment="NSE", starting_balance=200000.0, current_balance=200000.0)
    pos = FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY", entry_price=100.0, quantity=10)

    _apply_realized_pnl(pos, account, -300.0)

    assert pos.pnl == -300.0
    assert account.current_balance == 199700.0


def test_apply_realized_pnl_sets_pnl_even_when_account_missing():
    pos = FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY", entry_price=100.0, quantity=10)

    _apply_realized_pnl(pos, None, 500.0)  # defensive path - shouldn't happen (segment is FK-enforced)

    assert pos.pnl == 500.0


# --- exit monitor: SL/target hits, priority, trailing --------------------------------------


def test_evaluate_exits_closes_buy_on_stop_loss_hit():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=98.0),
    ]
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 97.5}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["closed_stop_loss"] == 1
    assert positions[0].status == "CLOSED"
    assert positions[0].exit_reason == "stop_loss"
    assert positions[0].exit_price == 97.5
    assert positions[0].pnl == compute_pnl("BUY", 100.0, 97.5, 10)


def test_evaluate_exits_closes_sell_on_stop_loss_hit():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="SELL",
                     entry_price=100.0, quantity=10, stop_loss_price=102.0),
    ]
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 102.5}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["closed_stop_loss"] == 1
    assert positions[0].exit_reason == "stop_loss"


def test_evaluate_exits_flags_live_position_on_stop_loss_hit_instead_of_paper_closing_it():
    """Live-broker-adapter P2 - a live position's actual close must go
    through a real broker order (position_manager._settle_live_exit, the
    DB-committing wrapper check_exits calls), never this pure function's
    own paper write - see its own live_exits_needed comment."""
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=98.0, is_live_broker_order=True),
    ]
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 97.5}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["closed_stop_loss"] == 0
    assert result["live_exits_needed"] == [(positions[0], "stop_loss")]
    assert positions[0].status == "OPEN"  # untouched - not paper-closed


def test_evaluate_exits_flags_live_position_on_target_hit_instead_of_paper_closing_it():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, target_price=104.0, is_live_broker_order=True),
    ]
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 104.5}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["closed_target"] == 0
    assert result["live_exits_needed"] == [(positions[0], "target")]
    assert positions[0].status == "OPEN"


def test_evaluate_exits_still_trails_a_live_position_even_though_it_never_closes_it():
    """Trailing itself stays pure DB-state (pos.stop_loss_price) - only the
    ACTUAL close and the Modify Order call are deferred to the
    DB-committing wrapper (check_exits' own _reconcile_trailing_stop)."""
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=95.0, trailing_stop_enabled=True,
                     stop_loss_method="percent", stop_loss_percent=2.0, is_live_broker_order=True),
    ]
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 110.0}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["trailed"] == 1
    assert positions[0].stop_loss_price == compute_stop_loss_percent_price("BUY", 110.0, 2.0)
    assert positions[0].status == "OPEN"


def test_evaluate_exits_closes_buy_on_target_hit():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, target_price=104.0),
    ]
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 104.5}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["closed_target"] == 1
    assert positions[0].exit_reason == "target"


def test_evaluate_exits_closes_sell_on_target_hit():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="SELL",
                     entry_price=100.0, quantity=10, target_price=96.0),
    ]
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 95.0}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["closed_target"] == 1
    assert positions[0].exit_reason == "target"


def test_evaluate_exits_stop_loss_takes_priority_over_target_same_tick():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=98.0, target_price=99.0),
    ]
    # A single gappy tick that's past both the (lower) SL and the (also lower, oddly-configured) target -
    # SL must win.
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 97.0}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["closed_stop_loss"] == 1
    assert result["closed_target"] == 0
    assert positions[0].exit_reason == "stop_loss"


def test_evaluate_exits_leaves_position_open_when_neither_hit():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=98.0, target_price=104.0),
    ]
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 101.0}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["closed_stop_loss"] == 0
    assert result["closed_target"] == 0
    assert positions[0].status == "OPEN"


# --- Delta Exchange fee/liquidation simulation (CRYPTO futures only, added 2026-08-21) ------------


def test_net_pnl_with_costs_returns_raw_pnl_unchanged_when_no_costs_apply():
    # Every plain position (open_fee never set, margin_posted never set) -
    # zero behavior change from before this feature existed.
    pos = FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY", entry_price=100.0, quantity=10)
    assert _net_pnl_with_costs(pos, 105.0, raw_pnl=50.0) == 50.0
    assert pos.close_fee is None
    assert pos.interest_charged is None


def test_net_pnl_with_costs_nets_open_and_close_fee():
    from app.domain.delta_fees import compute_futures_trading_fee

    pos = FakePosition(
        id="p1", status="OPEN", exchange="CRYPTO", symbol="BTCUSD", action="BUY",
        entry_price=70_000.0, quantity=0.1, open_fee=4.13,
    )
    expected_close_fee = compute_futures_trading_fee(72_000.0 * 0.1)
    net = _net_pnl_with_costs(pos, exit_price=72_000.0, raw_pnl=200.0)

    assert pos.close_fee == pytest.approx(expected_close_fee)
    assert net == pytest.approx(200.0 - 4.13 - expected_close_fee)


# --- NSE MTF (margin trading facility) interest, added for positional spot holding ------------------


def test_net_pnl_with_costs_charges_interest_on_leveraged_nse_position():
    # capital posted (margin_posted) = notional/leverage - here notional =
    # 100*1000=100000, leverage 4x -> margin_posted=25000, borrowed=75000.
    # 2 calendar days held at 18%/yr -> 75000 * 0.18/365 * 2 = 73.97...
    pos = FakePosition(
        id="p1", status="OPEN", segment="NSE", exchange="NSE", symbol="RELIANCE", action="BUY",
        entry_price=100.0, quantity=1000, margin_posted=25_000.0, mtf_interest_rate_pct=18.0,
        entry_time=datetime(2026, 8, 1, 10, 0, tzinfo=timezone.utc),
        exit_time=datetime(2026, 8, 3, 10, 0, tzinfo=timezone.utc),
    )
    expected_interest = 75_000.0 * (18.0 / 100 / 365) * 2

    net = _net_pnl_with_costs(pos, exit_price=105.0, raw_pnl=5000.0)

    assert pos.interest_charged == pytest.approx(expected_interest)
    assert net == pytest.approx(5000.0 - expected_interest)


def test_net_pnl_with_costs_interest_floors_to_one_day_held():
    # Entry and exit on the same calendar day - still owes at least one
    # day's interest, not zero.
    pos = FakePosition(
        id="p1", status="OPEN", segment="NSE", exchange="NSE", symbol="RELIANCE", action="BUY",
        entry_price=100.0, quantity=1000, margin_posted=25_000.0, mtf_interest_rate_pct=18.0,
        entry_time=datetime(2026, 8, 1, 10, 0, tzinfo=timezone.utc),
        exit_time=datetime(2026, 8, 1, 14, 0, tzinfo=timezone.utc),
    )
    expected_interest = 75_000.0 * (18.0 / 100 / 365) * 1

    net = _net_pnl_with_costs(pos, exit_price=105.0, raw_pnl=5000.0)

    assert pos.interest_charged == pytest.approx(expected_interest)
    assert net == pytest.approx(5000.0 - expected_interest)


def test_net_pnl_with_costs_no_interest_for_unleveraged_nse_position():
    # margin_posted is None (leverage was 1, or not NSE at all) - no
    # interest, zero behavior change.
    pos = FakePosition(
        id="p1", status="OPEN", segment="NSE", exchange="NSE", symbol="RELIANCE", action="BUY",
        entry_price=100.0, quantity=1000,
        entry_time=datetime(2026, 8, 1, 10, 0, tzinfo=timezone.utc),
        exit_time=datetime(2026, 8, 3, 10, 0, tzinfo=timezone.utc),
    )
    assert _net_pnl_with_costs(pos, exit_price=105.0, raw_pnl=5000.0) == 5000.0
    assert pos.interest_charged is None


def test_net_pnl_with_costs_no_interest_for_intraday_mis_margin_position():
    """Regression: an intraday MIS margin position (leverage > 1) also sets
    margin_posted (same field MTF uses) but has NO mtf_interest_rate_pct at
    all (real intraday margin carries no funding cost) - this used to crash
    with TypeError: float() argument must be a string or a real number, not
    'NoneType' on close/square-off, since the interest branch only checked
    margin_posted, not mtf_interest_rate_pct too."""
    pos = FakePosition(
        id="p1", status="OPEN", segment="NSE", exchange="NSE", symbol="RELIANCE", action="BUY",
        entry_price=100.0, quantity=1000, margin_posted=25_000.0, mtf_interest_rate_pct=None,
        entry_time=datetime(2026, 8, 1, 10, 0, tzinfo=timezone.utc),
        exit_time=datetime(2026, 8, 1, 14, 0, tzinfo=timezone.utc),
    )
    assert _net_pnl_with_costs(pos, exit_price=105.0, raw_pnl=5000.0) == 5000.0
    assert pos.interest_charged is None


def test_is_supported_accepts_positional_spot():
    assert is_supported("positional", "spot") is True


def test_is_supported_rejects_positional_future():
    assert is_supported("positional", "future") is False


def test_is_supported_rejects_positional_option():
    assert is_supported("positional", "option") is False


def test_is_supported_still_accepts_intraday_spot_and_future():
    assert is_supported("intraday", "spot") is True
    assert is_supported("intraday", "future") is True


def test_evaluate_exits_liquidation_wipes_full_margin_and_fee():
    # BTCUSD long, margin_posted=$1,000 (entry $72,000 * qty 0.1389 / margin
    # derives leverage back out to ~10x internally) - CMP has crossed the
    # stored liquidation_price.
    positions = [
        FakePosition(
            id="p1", status="OPEN", exchange="CRYPTO", symbol="BTCUSD", action="BUY", segment="CRYPTO",
            entry_price=72_000.0, quantity=0.138888889, open_fee=5.90, margin_posted=1_000.0,
            liquidation_price=65_160.0, stop_loss_price=68_000.0,
        ),
    ]
    result = _evaluate_exits(
        positions, get_ltp_batch=lambda ex, syms: {"BTCUSD": 65_000.0}, get_previous_candle=lambda *a: None,
        accounts_by_segment=_accounts(segment="CRYPTO"),
    )

    assert result["closed_stop_loss"] == 1  # liquidation counts as a stop_loss-family close in the summary
    assert positions[0].status == "CLOSED"
    assert positions[0].exit_reason == "liquidation"
    assert positions[0].exit_price == 65_000.0
    # pnl = -(margin_posted) - liquidation_fee, NOT the raw price-distance loss
    assert positions[0].pnl < -1_000.0
    assert positions[0].close_fee is not None and positions[0].close_fee > 0


def test_evaluate_exits_liquidation_takes_priority_over_stop_loss():
    # stop_loss_price (68,000) would also trip at this CMP - liquidation
    # must win the exit_reason, matching a real exchange force-closing
    # regardless of the strategy's own configured stop.
    positions = [
        FakePosition(
            id="p1", status="OPEN", exchange="CRYPTO", symbol="BTCUSD", action="BUY", segment="CRYPTO",
            entry_price=72_000.0, quantity=0.138888889, open_fee=5.90, margin_posted=1_000.0,
            liquidation_price=65_160.0, stop_loss_price=68_000.0,
        ),
    ]
    result = _evaluate_exits(
        positions, get_ltp_batch=lambda ex, syms: {"BTCUSD": 64_000.0}, get_previous_candle=lambda *a: None,
        accounts_by_segment=_accounts(segment="CRYPTO"),
    )

    assert positions[0].exit_reason == "liquidation"
    assert result["closed_stop_loss"] == 1


def test_evaluate_exits_no_liquidation_when_price_above_threshold():
    positions = [
        FakePosition(
            id="p1", status="OPEN", exchange="CRYPTO", symbol="BTCUSD", action="BUY", segment="CRYPTO",
            entry_price=72_000.0, quantity=0.138888889, open_fee=5.90, margin_posted=1_000.0,
            liquidation_price=65_160.0,
        ),
    ]
    result = _evaluate_exits(
        positions, get_ltp_batch=lambda ex, syms: {"BTCUSD": 70_000.0}, get_previous_candle=lambda *a: None,
        accounts_by_segment=_accounts(segment="CRYPTO"),
    )

    assert result["closed_stop_loss"] == 0
    assert positions[0].status == "OPEN"


def test_evaluate_exits_nets_fees_on_stop_loss_close():
    positions = [
        FakePosition(
            id="p1", status="OPEN", exchange="CRYPTO", symbol="BTCUSD", action="BUY", segment="CRYPTO",
            entry_price=72_000.0, quantity=0.1, stop_loss_price=70_000.0, open_fee=4.25,
        ),
    ]
    result = _evaluate_exits(
        positions, get_ltp_batch=lambda ex, syms: {"BTCUSD": 69_000.0}, get_previous_candle=lambda *a: None,
        accounts_by_segment=_accounts(segment="CRYPTO"),
    )

    assert result["closed_stop_loss"] == 1
    raw_pnl = compute_pnl("BUY", 72_000.0, 69_000.0, 0.1)
    assert positions[0].close_fee is not None
    assert positions[0].pnl == pytest.approx(raw_pnl - 4.25 - positions[0].close_fee)


# --- CRYPTO USD -> INR conversion on balance credit (added 2026-08-21) ----------------------------
#
# current_balance is always INR-denominated (every segment) but a CRYPTO
# position's own pnl/fees are raw USD (entry_price/exit_price never get
# converted - see docs/architecture.md's USDINR section) - _apply_realized_
# pnl must convert through usdinr_rate for the BALANCE credit while leaving
# the stored pos.pnl itself in native USD (so it stays a meaningful ratio
# against entry_price for %-of-entry displays).


def test_apply_realized_pnl_converts_usd_to_inr_for_crypto():
    pos = FakePosition(id="p1", status="OPEN", exchange="CRYPTO", symbol="BTCUSD", action="BUY", segment="CRYPTO", entry_price=70_000.0, quantity=0.1)
    account = FakeAccount(segment="CRYPTO", starting_balance=200_000.0, current_balance=200_000.0)

    _apply_realized_pnl(pos, account, pnl=100.0, usdinr_rate=90.0)

    assert pos.pnl == 100.0  # stored pnl stays raw USD, unconverted
    assert account.current_balance == pytest.approx(200_000.0 + 100.0 * 90.0)  # balance credit IS converted


def test_apply_realized_pnl_leaves_non_crypto_pnl_unconverted():
    pos = FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY", segment="NSE", entry_price=100.0, quantity=10)
    account = FakeAccount(segment="NSE", starting_balance=1_000_000.0, current_balance=1_000_000.0)

    _apply_realized_pnl(pos, account, pnl=50.0, usdinr_rate=90.0)  # a stray usdinr_rate must be ignored for NSE

    assert pos.pnl == 50.0
    assert account.current_balance == 1_000_000.0 + 50.0


def test_apply_realized_pnl_crypto_without_rate_falls_back_to_unconverted():
    # Defensive fallback only - every real CRYPTO open path already
    # refuses to open at all without a configured rate, so this shouldn't
    # be reachable in practice.
    pos = FakePosition(id="p1", status="OPEN", exchange="CRYPTO", symbol="BTCUSD", action="BUY", segment="CRYPTO", entry_price=70_000.0, quantity=0.1)
    account = FakeAccount(segment="CRYPTO", starting_balance=200_000.0, current_balance=200_000.0)

    _apply_realized_pnl(pos, account, pnl=100.0, usdinr_rate=None)

    assert account.current_balance == 200_100.0


def test_evaluate_exits_liquidation_credits_inr_converted_loss():
    positions = [
        FakePosition(
            id="p1", status="OPEN", exchange="CRYPTO", symbol="BTCUSD", action="BUY", segment="CRYPTO",
            entry_price=72_000.0, quantity=0.138888889, open_fee=5.90, margin_posted=1_000.0,
            liquidation_price=65_160.0,
        ),
    ]
    accounts = _accounts(balance=200_000.0, segment="CRYPTO")
    result = _evaluate_exits(
        positions, get_ltp_batch=lambda ex, syms: {"BTCUSD": 65_000.0}, get_previous_candle=lambda *a: None,
        accounts_by_segment=accounts, usdinr_rate_by_user={None: 90.0},
    )

    assert result["closed_stop_loss"] == 1
    assert positions[0].exit_reason == "liquidation"
    # pos.pnl (USD) stays unconverted; the account (INR) is credited at 90x it.
    usd_loss = positions[0].pnl
    assert usd_loss < 0
    assert accounts[(None, "CRYPTO")].current_balance == pytest.approx(200_000.0 + usd_loss * 90.0)


def test_evaluate_exits_skips_position_when_quote_missing():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=98.0),
    ]
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["checked"] == 1
    assert result["closed_stop_loss"] == 0
    assert positions[0].status == "OPEN"


def test_evaluate_exits_trails_percent_stop_favorably_for_buy():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=98.0, trailing_stop_enabled=True,
                     stop_loss_method="percent", stop_loss_percent=2.0),
    ]
    # cmp=110 -> candidate stop = 110*0.98 = 107.8, well above the stored 98.0 -> ratchets up
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 110.0}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["trailed"] == 1
    assert positions[0].stop_loss_price == 107.8
    assert positions[0].status == "OPEN"


def test_evaluate_exits_percent_trailing_never_loosens():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=98.0, trailing_stop_enabled=True,
                     stop_loss_method="percent", stop_loss_percent=5.0),
    ]
    # cmp=100 -> candidate stop = 100*0.95 = 95.0, LESS favorable than the stored 98.0 -> must not move
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 100.0}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["trailed"] == 0
    assert positions[0].stop_loss_price == 98.0


def test_evaluate_exits_breakeven_triggers_and_snaps_to_entry_for_buy():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=99.5, trailing_stop_enabled=True,
                     stop_loss_method="breakeven", stop_loss_percent=0.5),
    ]
    # cmp=100.5 is exactly the +0.5% favorable threshold -> snaps to entry_price=100.0
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 100.5}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["trailed"] == 1
    assert positions[0].stop_loss_price == 100.0
    assert positions[0].breakeven_triggered is True
    assert positions[0].status == "OPEN"


def test_evaluate_exits_breakeven_does_not_trigger_before_threshold():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=99.5, trailing_stop_enabled=True,
                     stop_loss_method="breakeven", stop_loss_percent=0.5),
    ]
    # cmp=100.2 hasn't reached the +0.5% threshold yet -> stop stays put, not yet triggered
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 100.2}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["trailed"] == 0
    assert positions[0].stop_loss_price == 99.5
    assert positions[0].breakeven_triggered is False


def test_evaluate_exits_breakeven_freezes_after_triggering_once():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=100.0, trailing_stop_enabled=True,
                     stop_loss_method="breakeven", stop_loss_percent=0.5, breakeven_triggered=True),
    ]
    # Already triggered, already at entry - a further favorable move must NOT trail it any further ("let it ride").
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 105.0}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["trailed"] == 0
    assert positions[0].stop_loss_price == 100.0
    assert positions[0].breakeven_triggered is True


def test_evaluate_exits_breakeven_triggers_and_snaps_to_entry_for_sell():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="SELL",
                     entry_price=100.0, quantity=10, stop_loss_price=100.5, trailing_stop_enabled=True,
                     stop_loss_method="breakeven", stop_loss_percent=0.5),
    ]
    # SELL: cmp=99.5 is the -0.5% favorable threshold -> snaps to entry_price=100.0
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 99.5}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["trailed"] == 1
    assert positions[0].stop_loss_price == 100.0
    assert positions[0].breakeven_triggered is True


def test_evaluate_exits_breakeven_stop_hit_after_freeze_closes_position():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=100.0, trailing_stop_enabled=True,
                     stop_loss_method="breakeven", stop_loss_percent=0.5, breakeven_triggered=True),
    ]
    # sl_hit is method-agnostic - a frozen breakeven stop still closes the position like any other.
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 100.0}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["closed_stop_loss"] == 1
    assert positions[0].status == "CLOSED"
    assert positions[0].exit_reason == "stop_loss"


def test_evaluate_exits_trails_previous_candle_stop_and_dedupes_fetch():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=95.0, trailing_stop_enabled=True,
                     stop_loss_method="previous_candle", stop_loss_interval="5min"),
        FakePosition(id="p2", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=5, stop_loss_price=96.0, trailing_stop_enabled=True,
                     stop_loss_method="previous_candle", stop_loss_interval="5min"),
    ]
    calls = []

    def fake_get_previous_candle(exchange, symbol, interval):
        calls.append((exchange, symbol, interval))
        return {"low": 97.0, "high": 105.0}

    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 101.0}, get_previous_candle=fake_get_previous_candle, accounts_by_segment=_accounts())

    assert len(calls) == 1  # same (exchange, symbol, interval) - fetched once, reused for both positions
    assert result["trailed"] == 2  # 97.0 is more favorable than both 95.0 and 96.0
    assert positions[0].stop_loss_price == 97.0
    assert positions[1].stop_loss_price == 97.0


def test_compute_ema_seeds_with_sma_then_smooths():
    # period=2: seed = mean(closes[:2]) = 15.0 at index 1; k=2/3 thereafter -
    # same values regime.py's own compute_ema would produce for this input.
    assert compute_ema([10.0, 20.0], 2) == [None, 15.0]


def test_compute_ema_insufficient_closes_is_all_none():
    assert compute_ema([10.0], 2) == [None]


def test_compute_ema_matches_hand_traced_series():
    ema = compute_ema([20.0, 20.0, 20.0, 20.0, 8.0], 2)
    assert ema[0] is None
    assert ema[1] == pytest.approx(20.0)
    assert ema[2] == pytest.approx(20.0)
    assert ema[3] == pytest.approx(20.0)
    assert ema[4] == pytest.approx(12.0)


def test_stop_loss_compute_funcs_ema_dispatch():
    compute = _STOP_LOSS_COMPUTE_FUNCS["ema"]
    candles = [{"close": c} for c in [20.0, 20.0, 20.0, 20.0, 8.0]]
    assert compute(candles, {"period": 2}) == pytest.approx(12.0)


def test_stop_loss_compute_funcs_ema_insufficient_history_returns_none():
    compute = _STOP_LOSS_COMPUTE_FUNCS["ema"]
    assert compute([{"close": 10.0}], {"period": 2}) is None


def test_compute_atr_settles_to_the_constant_true_range():
    # Direct port of signal-generation's own test_compute_atr_settles_to_
    # the_constant_true_range (test_regime.py) - high=close+1/low=close-1,
    # constant true range of 2 on every bar, so ATR must settle to exactly
    # 2.0. Confirms this duplicated port matches the original.
    candles = [{"close": 50 + i, "high": 50 + i + 1, "low": 50 + i - 1} for i in range(20)]
    atr = compute_atr(candles, period=5)
    assert atr[-1] == pytest.approx(2.0)


def test_compute_supertrend_settles_below_price_in_a_steady_uptrend():
    # Same fixture/reasoning as signal-generation's
    # test_compute_supertrend_settles_below_price_in_a_steady_uptrend
    # (test_regime.py) - confirms this duplicated port matches the original.
    candles = [{"close": 50 + i, "high": 50 + i + 1, "low": 50 + i - 1} for i in range(20)]
    st = compute_supertrend(candles, period=5, multiplier=1.0)
    assert st[-1] == pytest.approx(candles[-1]["close"] - 2.0)


def test_stop_loss_compute_funcs_supertrend_dispatch():
    compute = _STOP_LOSS_COMPUTE_FUNCS["supertrend"]
    candles = [{"close": 50 + i, "high": 50 + i + 1, "low": 50 + i - 1} for i in range(20)]
    assert compute(candles, {"period": 5, "multiplier": 1.0}) == pytest.approx(candles[-1]["close"] - 2.0)


def test_stop_loss_compute_funcs_supertrend_insufficient_history_returns_none():
    compute = _STOP_LOSS_COMPUTE_FUNCS["supertrend"]
    candles = [{"close": 50 + i, "high": 50 + i + 1, "low": 50 + i - 1} for i in range(4)]
    assert compute(candles, {"period": 5, "multiplier": 1.0}) is None


def test_resolve_stop_loss_none_method_is_a_noop():
    price, reason = _resolve_stop_loss(
        None, "BUY", 100.0, None, None, None, None, "NSE", "RELIANCE", lambda *a: None, lambda *a: []
    )
    assert price is None
    assert reason is None


def test_resolve_stop_loss_percent():
    price, reason = _resolve_stop_loss(
        "percent", "BUY", 100.0, None, 2.0, None, None, "NSE", "RELIANCE", lambda *a: None, lambda *a: []
    )
    assert price == pytest.approx(98.0)
    assert reason is None


def test_resolve_stop_loss_previous_candle_uses_low_for_buy():
    price, reason = _resolve_stop_loss(
        "previous_candle", "BUY", 100.0, "5min", None, None, None, "NSE", "RELIANCE",
        lambda ex, sym, interval: {"low": 97.0, "high": 101.0}, lambda *a: [],
    )
    assert price == 97.0
    assert reason is None


def test_resolve_stop_loss_previous_candle_missing_is_rejected():
    price, reason = _resolve_stop_loss(
        "previous_candle", "BUY", 100.0, "5min", None, None, None, "NSE", "RELIANCE",
        lambda *a: None, lambda *a: [],
    )
    assert price is None
    assert "no completed 5min candle" in reason


def test_resolve_stop_loss_indicator_ema():
    candles = [{"close": 96.0}, {"close": 96.0}, {"close": 96.0}, {"close": 96.0}, {"close": 100.0}]
    price, reason = _resolve_stop_loss(
        "indicator", "BUY", 100.0, "5min", None, "ema", {"period": 2}, "NSE", "RELIANCE",
        lambda *a: None, lambda *a: candles,
    )
    assert price == pytest.approx(98.66666666666666)
    assert reason is None


def test_resolve_stop_loss_indicator_unrecognized_type_is_rejected():
    price, reason = _resolve_stop_loss(
        "indicator", "BUY", 100.0, "5min", None, "macd", {}, "NSE", "RELIANCE", lambda *a: None, lambda *a: [],
    )
    assert price is None
    assert "unrecognized stop_loss_indicator_type" in reason


def test_resolve_stop_loss_indicator_insufficient_history_is_rejected():
    price, reason = _resolve_stop_loss(
        "indicator", "BUY", 100.0, "5min", None, "ema", {"period": 20}, "NSE", "RELIANCE",
        lambda *a: None, lambda *a: [{"close": 96.0}],
    )
    assert price is None
    assert "not enough 5min history" in reason


def test_resolve_stop_loss_indicator_wrong_side_of_entry_is_rejected():
    # EMA candidate (102.0) sits ABOVE entry (100.0) - not a protective
    # stop for a BUY, same wrong-side guard _evaluate_exits' trailing path
    # already has for its own candidates.
    candles = [{"close": 102.0}, {"close": 102.0}]
    price, reason = _resolve_stop_loss(
        "indicator", "BUY", 100.0, "5min", None, "ema", {"period": 2}, "NSE", "RELIANCE",
        lambda *a: None, lambda *a: candles,
    )
    assert price is None
    assert "not on the protective side of entry" in reason


def test_evaluate_exits_trails_indicator_supertrend_stop():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="CRYPTO", symbol="BTCUSD", action="BUY",
                     entry_price=40.0, quantity=1, stop_loss_price=30.0, trailing_stop_enabled=True,
                     stop_loss_method="indicator", stop_loss_interval="5min",
                     stop_loss_indicator_type="supertrend", stop_loss_indicator_params={"period": 5, "multiplier": 1.0}),
    ]
    candles = [{"close": 50 + i, "high": 50 + i + 1, "low": 50 + i - 1} for i in range(20)]
    # SuperTrend settles to close[-1]-2.0 = 67.0, above the stored 30.0 -
    # a genuine tightening for this BUY.
    result = _evaluate_exits(
        positions, get_ltp_batch=lambda ex, syms: {"BTCUSD": 70.0}, get_previous_candle=lambda *a: None,
        accounts_by_segment=_accounts(), get_candle_history=lambda *a: candles,
    )

    assert result["trailed"] == 1
    assert positions[0].stop_loss_price == pytest.approx(67.0)


def test_evaluate_exits_trails_indicator_ema_stop_and_dedupes_fetch():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=95.0, trailing_stop_enabled=True,
                     stop_loss_method="indicator", stop_loss_interval="5min",
                     stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 2}),
        FakePosition(id="p2", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=5, stop_loss_price=96.0, trailing_stop_enabled=True,
                     stop_loss_method="indicator", stop_loss_interval="5min",
                     stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 2}),
    ]
    calls = []

    def fake_get_candle_history(exchange, symbol, interval, from_date, to_date):
        calls.append((exchange, symbol, interval))
        return [{"close": 96.0}, {"close": 96.0}, {"close": 96.0}, {"close": 96.0}, {"close": 100.0}]

    result = _evaluate_exits(
        positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 101.0}, get_previous_candle=lambda *a: None,
        accounts_by_segment=_accounts(), get_candle_history=fake_get_candle_history,
    )

    # period=2 EMA of [96,96,96,96,100]: seed=96.0, then 96*(1/3)+100*(2/3) = 98.667 -
    # same (exchange, symbol, interval) key, fetched once and reused for both positions.
    assert len(calls) == 1
    assert result["trailed"] == 2
    assert positions[0].stop_loss_price == pytest.approx(98.66666666666666)
    assert positions[1].stop_loss_price == pytest.approx(98.66666666666666)


def test_evaluate_exits_indicator_trailing_never_loosens():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=99.0, trailing_stop_enabled=True,
                     stop_loss_method="indicator", stop_loss_interval="5min",
                     stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 2}),
    ]
    # EMA candidate (96.0) is LESS favorable than the stored 99.0 for a BUY - must not move.
    result = _evaluate_exits(
        positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 101.0}, get_previous_candle=lambda *a: None,
        accounts_by_segment=_accounts(),
        get_candle_history=lambda *a: [{"close": 96.0}, {"close": 96.0}],
    )

    assert result["trailed"] == 0
    assert positions[0].stop_loss_price == 99.0


def test_evaluate_exits_indicator_trailing_rejects_candidate_on_wrong_side_of_cmp():
    # EMA candidate (102.0) sits ABOVE the current market price (101.0) -
    # not a protective stop for a BUY at all (a long's stop must stay
    # below price). The stale "more_favorable than the stored stop"
    # check alone would have waved this through (102 > 95, looks like a
    # tightening update) - reproduced live via backtest (a fake
    # "stop_loss" exit that was actually a profit, see
    # backtest.py's _indicator_stop_price for the full writeup). Must be
    # discarded, not applied.
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=95.0, trailing_stop_enabled=True,
                     stop_loss_method="indicator", stop_loss_interval="5min",
                     stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 2}),
    ]
    result = _evaluate_exits(
        positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 101.0}, get_previous_candle=lambda *a: None,
        accounts_by_segment=_accounts(),
        get_candle_history=lambda *a: [{"close": 102.0}, {"close": 102.0}],
    )

    assert result["trailed"] == 0
    assert positions[0].stop_loss_price == 95.0


def test_evaluate_exits_indicator_trailing_skipped_when_history_insufficient():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=95.0, trailing_stop_enabled=True,
                     stop_loss_method="indicator", stop_loss_interval="5min",
                     stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 20}),
    ]
    # Not enough history for a period=20 EMA (only 1 close) -> compute()
    # returns None -> no crash, candidate simply doesn't apply.
    result = _evaluate_exits(
        positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 101.0}, get_previous_candle=lambda *a: None,
        accounts_by_segment=_accounts(),
        get_candle_history=lambda *a: [{"close": 96.0}],
    )

    assert result["trailed"] == 0
    assert positions[0].stop_loss_price == 95.0


def test_evaluate_exits_indicator_trailing_skipped_when_no_get_candle_history_supplied():
    # get_candle_history defaults to None - existing callers/tests that
    # never pass it must not crash on an indicator-method position, same
    # backward-compatibility guarantee previous_candle/percent already had.
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=95.0, trailing_stop_enabled=True,
                     stop_loss_method="indicator", stop_loss_interval="5min",
                     stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 2}),
    ]
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 101.0}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["trailed"] == 0
    assert positions[0].stop_loss_price == 95.0


def test_evaluate_exits_trailing_skipped_when_disabled():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=98.0, trailing_stop_enabled=False,
                     stop_loss_method="percent", stop_loss_percent=2.0),
    ]
    result = _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 110.0}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())

    assert result["trailed"] == 0
    assert positions[0].stop_loss_price == 98.0


def test_evaluate_exits_credits_the_positions_own_segment_account():
    accounts = _accounts(balance=200000.0)
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=98.0, segment="NSE"),
    ]
    _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 104.0}, get_previous_candle=lambda *a: None, accounts_by_segment=accounts)

    # stop_loss_price=98 not hit at cmp=104, so this closes via... wait, no target set - stays open.
    assert positions[0].status == "OPEN"
    assert accounts[(None, "NSE")].current_balance == 200000.0  # untouched - nothing closed


def test_evaluate_exits_closing_a_loser_debits_its_segment_account():
    accounts = _accounts(balance=200000.0)
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=98.0, segment="NSE"),
    ]
    _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 97.5}, get_previous_candle=lambda *a: None, accounts_by_segment=accounts)

    expected_pnl = compute_pnl("BUY", 100.0, 97.5, 10)  # -25.0
    assert positions[0].pnl == expected_pnl
    assert accounts[(None, "NSE")].current_balance == 200000.0 + expected_pnl


# --- optional per-strategy dedicated account (execution.strategy_accounts) -
# _resolve_capital_account is the shared pick-one-account piece
# load_capital_account (the DB-touching single-lookup version, not
# directly tested here - same "pure logic only" convention this file
# already follows for load_account/_accounts_by_segment) mirrors. -------


def test_resolve_capital_account_prefers_a_dedicated_strategy_account():
    accounts = _accounts(balance=200000.0)
    dedicated = FakeAccount(segment="NSE", starting_balance=50000.0, current_balance=50000.0)
    pos = FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                        entry_price=100.0, quantity=10, segment="NSE", strategy_id="strat-1")

    resolved = _resolve_capital_account(pos, accounts, {"strat-1": dedicated})

    assert resolved is dedicated


def test_resolve_capital_account_falls_back_to_segment_when_no_dedicated_row():
    accounts = _accounts(balance=200000.0)
    pos = FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                        entry_price=100.0, quantity=10, segment="NSE", strategy_id="strat-1")

    resolved = _resolve_capital_account(pos, accounts, {})  # strat-1 has no dedicated row

    assert resolved is accounts[(None, "NSE")]


def test_resolve_capital_account_falls_back_to_segment_when_no_strategy_id_at_all():
    accounts = _accounts(balance=200000.0)
    dedicated = FakeAccount(segment="NSE", starting_balance=50000.0, current_balance=50000.0)
    pos = FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                        entry_price=100.0, quantity=10, segment="NSE", strategy_id=None)  # manual order

    resolved = _resolve_capital_account(pos, accounts, {"strat-1": dedicated})

    assert resolved is accounts[(None, "NSE")]


def test_resolve_capital_account_treats_none_strategy_accounts_as_empty():
    # strategy_accounts=None is what every pre-existing caller/test that
    # never passes it gets (the parameter's own default) - must behave
    # identically to {}, not crash on a NoneType .get() call.
    accounts = _accounts(balance=200000.0)
    pos = FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                        entry_price=100.0, quantity=10, segment="NSE", strategy_id="strat-1")

    resolved = _resolve_capital_account(pos, accounts, None)

    assert resolved is accounts[(None, "NSE")]


def test_evaluate_exits_credits_the_dedicated_strategy_account_when_one_exists():
    accounts = _accounts(balance=200000.0)
    strategy_accounts = {"strat-1": FakeAccount(segment="NSE", starting_balance=50000.0, current_balance=50000.0)}
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, target_price=104.0, segment="NSE", strategy_id="strat-1"),
    ]
    _evaluate_exits(
        positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 104.0}, get_previous_candle=lambda *a: None,
        accounts_by_segment=accounts, strategy_accounts=strategy_accounts,
    )

    expected_pnl = compute_pnl("BUY", 100.0, 104.0, 10)
    assert positions[0].status == "CLOSED"
    # Credited to the DEDICATED account, not the shared segment one.
    assert strategy_accounts["strat-1"].current_balance == 50000.0 + expected_pnl
    assert accounts[(None, "NSE")].current_balance == 200000.0  # untouched


def test_evaluate_square_off_due_credits_the_dedicated_strategy_account_when_one_exists():
    accounts = _accounts(balance=200000.0)
    strategy_accounts = {"strat-1": FakeAccount(segment="NSE", starting_balance=50000.0, current_balance=50000.0)}
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, square_off_time=time(14, 30), segment="NSE", strategy_id="strat-1"),
    ]
    _evaluate_square_off_due(
        positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 105.0}, now_local=time(14, 30),
        accounts_by_segment=accounts, strategy_accounts=strategy_accounts,
    )

    expected_pnl = compute_pnl("BUY", 100.0, 105.0, 10)
    assert strategy_accounts["strat-1"].current_balance == 50000.0 + expected_pnl
    assert accounts[(None, "NSE")].current_balance == 200000.0  # untouched


# --- periodic due-position closing (each position's own stored square_off_time) -----------


def test_evaluate_square_off_due_closes_position_past_its_own_time():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, square_off_time=time(14, 30)),
    ]
    result = _evaluate_square_off_due(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 105.0}, now_local=time(14, 30), accounts_by_segment=_accounts())

    assert result == {"closed": 1, "failed": 0, "checked": 1, "live_square_offs_needed": []}
    assert positions[0].status == "CLOSED"
    assert positions[0].exit_reason == "square_off"
    assert positions[0].exit_price == 105.0
    assert positions[0].pnl == compute_pnl("BUY", 100.0, 105.0, 10)


def test_evaluate_square_off_due_leaves_position_open_before_its_own_time():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, square_off_time=time(15, 0)),
    ]
    result = _evaluate_square_off_due(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 105.0}, now_local=time(14, 30), accounts_by_segment=_accounts())

    assert result == {"closed": 0, "failed": 0, "checked": 0, "live_square_offs_needed": []}
    assert positions[0].status == "OPEN"


def test_evaluate_square_off_due_respects_distinct_per_position_times():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, square_off_time=time(14, 0)),  # already due
        FakePosition(id="p2", status="OPEN", exchange="NSE", symbol="TCS", action="BUY",
                     entry_price=200.0, quantity=5, square_off_time=time(15, 30)),  # not due yet
    ]
    result = _evaluate_square_off_due(
        positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 101.0, "TCS": 205.0}, now_local=time(14, 45), accounts_by_segment=_accounts()
    )

    assert result["closed"] == 1
    assert result["checked"] == 1
    assert positions[0].status == "CLOSED"
    assert positions[1].status == "OPEN"


def test_evaluate_square_off_due_skips_positions_with_no_stored_time():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, square_off_time=None),
    ]
    result = _evaluate_square_off_due(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 105.0}, now_local=time(23, 0), accounts_by_segment=_accounts())

    assert result == {"closed": 0, "failed": 0, "checked": 0, "live_square_offs_needed": []}
    assert positions[0].status == "OPEN"


def test_evaluate_square_off_due_leaves_position_open_when_quote_fetch_fails():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, square_off_time=time(14, 0)),
    ]
    result = _evaluate_square_off_due(positions, get_ltp_batch=lambda ex, syms: {}, now_local=time(15, 0), accounts_by_segment=_accounts())

    assert result == {"closed": 0, "failed": 1, "checked": 1, "live_square_offs_needed": []}
    assert positions[0].status == "OPEN"


def test_evaluate_square_off_due_flags_live_position_instead_of_paper_closing_it():
    """Live-broker-adapter P2 - a live position due for square-off must
    close through a real broker order (the DB-committing wrapper,
    square_off_due_positions), never this pure function's own paper
    write - see its own live_square_offs_needed comment."""
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, square_off_time=time(14, 0), is_live_broker_order=True),
    ]
    result = _evaluate_square_off_due(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 105.0}, now_local=time(15, 0), accounts_by_segment=_accounts())

    assert result["closed"] == 0
    assert result["live_square_offs_needed"] == [positions[0]]
    assert positions[0].status == "OPEN"  # untouched - not paper-closed


def test_evaluate_square_off_due_credits_its_segment_account():
    accounts = _accounts(balance=200000.0)
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, square_off_time=time(14, 30), segment="NSE"),
    ]
    _evaluate_square_off_due(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 105.0}, now_local=time(14, 30), accounts_by_segment=accounts)

    expected_pnl = compute_pnl("BUY", 100.0, 105.0, 10)  # +50.0
    assert accounts[(None, "NSE")].current_balance == 200000.0 + expected_pnl


def test_evaluate_square_off_due_handles_missing_account_without_crashing():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, square_off_time=time(14, 30), segment="NSE"),
    ]
    # No 'NSE' key at all - defensive path, shouldn't happen given the FK, but must not crash the close.
    result = _evaluate_square_off_due(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 105.0}, now_local=time(14, 30), accounts_by_segment={})

    assert result["closed"] == 1
    assert positions[0].status == "CLOSED"
    assert positions[0].pnl == compute_pnl("BUY", 100.0, 105.0, 10)


# --- signal conflict resolution (duplicate/counter-signal policy) --------------------------


def _open_position(action: str, pos_id: str = "p1") -> FakePosition:
    return FakePosition(id=pos_id, status="OPEN", exchange="NSE", symbol="RELIANCE", action=action,
                         entry_price=100.0, quantity=10)


def test_resolve_signal_conflicts_no_open_positions_is_a_noop():
    order = FakeOrder(action="BUY")
    positions_to_close, reject_reason = _resolve_signal_conflicts([], order)
    assert positions_to_close == []
    assert reject_reason is None


def test_resolve_signal_conflicts_same_direction_skip_rejects():
    order = FakeOrder(action="BUY", duplicate_signal_policy="skip")
    positions_to_close, reject_reason = _resolve_signal_conflicts([_open_position("BUY")], order)
    assert positions_to_close == []
    assert reject_reason == "symbol already has an open position in the same direction and duplicate_signal_policy=skip"


def test_resolve_signal_conflicts_same_direction_add_position_allows_pyramid():
    order = FakeOrder(action="BUY", duplicate_signal_policy="add_position")
    positions_to_close, reject_reason = _resolve_signal_conflicts([_open_position("BUY")], order)
    assert positions_to_close == []
    assert reject_reason is None


def test_resolve_signal_conflicts_opposite_direction_close_and_flip_closes_it():
    order = FakeOrder(action="SELL", counter_signal_policy="close_and_flip")
    existing = _open_position("BUY")
    positions_to_close, reject_reason = _resolve_signal_conflicts([existing], order)
    assert positions_to_close == [existing]
    assert reject_reason is None


def test_resolve_signal_conflicts_opposite_direction_skip_leaves_it_open():
    order = FakeOrder(action="SELL", counter_signal_policy="skip")
    existing = _open_position("BUY")
    positions_to_close, reject_reason = _resolve_signal_conflicts([existing], order)
    assert positions_to_close == []
    assert reject_reason is None


def test_resolve_signal_conflicts_mixed_book_closes_opposite_and_still_blocks_same_direction():
    order = FakeOrder(action="BUY", duplicate_signal_policy="skip", counter_signal_policy="close_and_flip")
    same = _open_position("BUY", pos_id="p1")
    opposite = _open_position("SELL", pos_id="p2")
    positions_to_close, reject_reason = _resolve_signal_conflicts([same, opposite], order)
    assert positions_to_close == [opposite]
    assert reject_reason == "symbol already has an open position in the same direction and duplicate_signal_policy=skip"


def test_settle_live_position_exit_is_a_no_op_if_position_is_no_longer_open():
    """Live-broker-adapter P2's critical safety property: the postback
    handler and the exit-monitor/square-off scheduler jobs can both
    plausibly race to settle the same live position (a postback arriving
    just after the scheduler's own synchronous wait already settled it, or
    vice versa) - settle_live_position_exit must never double-apply
    realized P&L. Uses a plain FakePosition (no real DB) since the
    already-CLOSED short-circuit returns before touching load_capital_account/
    load_settings at all."""
    pos = FakePosition(id="p1", status="CLOSED", exchange="NSE", symbol="RELIANCE", action="BUY",
                        entry_price=100.0, quantity=10, exit_price=97.5, pnl=-25.0, exit_reason="stop_loss")

    settle_live_position_exit(db=None, pos=pos, exit_price=999.0, exit_reason="square_off")

    # Untouched - the guard returned before this could ever be reached.
    assert pos.status == "CLOSED"
    assert pos.exit_price == 97.5
    assert pos.pnl == -25.0
    assert pos.exit_reason == "stop_loss"


def test_live_status_reason_paper_only_when_not_enabled():
    assert _live_status_reason(live_enabled=False, kill_switch=False, daily_loss_tripped=False, has_user=True) == \
        "live_trading_enabled is false - paper only"


def test_live_status_reason_flags_missing_user_for_a_strategy():
    assert _live_status_reason(live_enabled=True, kill_switch=False, daily_loss_tripped=False, has_user=False) == \
        "live_trading_enabled but no live_trading_user_id set - can never go live"


def test_live_status_reason_flags_kill_switch_over_a_correctly_configured_row():
    assert _live_status_reason(live_enabled=True, kill_switch=True, daily_loss_tripped=False, has_user=True) == \
        "would be live, but the platform-wide LIVE_TRADING_KILL_SWITCH is on"


def test_live_status_reason_flags_tripped_daily_loss_cap():
    assert _live_status_reason(live_enabled=True, kill_switch=False, daily_loss_tripped=True, has_user=True) == \
        "would be live, but today's realized loss has reached its max_daily_loss cap"


def test_live_status_reason_none_when_actually_live():
    assert _live_status_reason(live_enabled=True, kill_switch=False, daily_loss_tripped=False, has_user=True) is None


def test_open_delta_fee_fields_intraday_nse_spot_no_leverage_is_unaffected():
    """leverage=1 (the default) must be a complete no-op - existing
    intraday NSE spot behavior stays exactly as it was before margin
    sizing existed."""
    account = SimpleNamespace(leverage=1)
    result = _open_delta_fee_fields("NSE", "spot", "intraday", "BUY", 100.0, 10, account, account)
    assert result == (None, None, None, None)


def test_open_delta_fee_fields_intraday_nse_spot_margin_computes_margin_posted_with_no_interest():
    """Intraday MIS margin reuses account.leverage (same field the
    positional MTF branch uses) but never charges interest - the position
    is always flat by end of day, unlike MTF's genuine overnight
    borrowing cost."""
    account = SimpleNamespace(leverage=5)
    open_fee, margin_posted, liquidation_price, interest = _open_delta_fee_fields(
        "NSE", "spot", "intraday", "BUY", 100.0, 10, account, account
    )
    assert open_fee is None
    assert margin_posted == pytest.approx(200.0)  # (100*10) / 5
    assert liquidation_price is None
    assert interest is None


def test_open_delta_fee_fields_intraday_nse_future_never_gets_margin():
    """Only spot - a future's own lot-based sizing already implicitly
    prices in margin, this branch must not double-apply leverage to it."""
    account = SimpleNamespace(leverage=5)
    result = _open_delta_fee_fields("NSE", "future", "intraday", "BUY", 100.0, 10, account, account)
    assert result == (None, None, None, None)


def test_open_delta_fee_fields_positional_nse_mtf_unaffected_by_intraday_branch():
    """Regression check - the pre-existing positional MTF branch (margin
    posted + a real interest rate) still fires exactly as before now that
    an intraday sibling branch exists alongside it."""
    account = SimpleNamespace(leverage=4, mtf_annual_interest_rate_pct=18.0)
    open_fee, margin_posted, liquidation_price, interest = _open_delta_fee_fields(
        "NSE", "spot", "positional", "BUY", 100.0, 10, account, account, use_margin=True
    )
    assert open_fee is None
    assert margin_posted == pytest.approx(250.0)  # (100*10) / 4
    assert liquidation_price is None
    assert interest == 18.0


def test_apply_nse_leverage_shaves_off_the_configured_buffer():
    """10,000 capital, 5x leverage, 10% buffer -> sizes against 45,000
    (50,000 leveraged notional minus a 10% slippage-headroom buffer), not
    the full 50,000 - see docs/architecture.md."""
    account = SimpleNamespace(leverage=5, leverage_buffer_pct=10)
    assert _apply_nse_leverage(10_000.0, account) == pytest.approx(45_000.0)


def test_apply_nse_leverage_zero_buffer_uses_the_full_leveraged_notional():
    account = SimpleNamespace(leverage=5, leverage_buffer_pct=0)
    assert _apply_nse_leverage(10_000.0, account) == pytest.approx(50_000.0)


def test_apply_nse_leverage_no_leverage_still_applies_the_buffer():
    """leverage=1 doesn't skip the buffer - only open_position/
    open_manual_position's own `leverage > 1` guard decides whether this
    function is called at all."""
    account = SimpleNamespace(leverage=1, leverage_buffer_pct=10)
    assert _apply_nse_leverage(10_000.0, account) == pytest.approx(9_000.0)


# --- Strategy performance (Money page "Performance" tab) -----------------


def test_compute_max_drawdown_on_a_rising_curve_is_zero():
    assert compute_max_drawdown([100.0, 50.0, 200.0]) == 0.0


def test_compute_max_drawdown_finds_the_worst_peak_to_trough_decline():
    # cumulative: 100, 300 (peak), 100 (dd=200), 150 (dd=150), 400 (new peak)
    assert compute_max_drawdown([100.0, 200.0, -200.0, 50.0, 250.0]) == pytest.approx(200.0)


def test_compute_max_drawdown_empty_is_zero():
    assert compute_max_drawdown([]) == 0.0


def test_compute_strategy_performance_buckets_by_strategy_and_status():
    positions = [
        FakePosition(id="p1", status="CLOSED", segment="NSE", exchange="NSE", symbol="A", action="BUY",
                     entry_price=100.0, quantity=10, strategy_id="s1", pnl=500.0,
                     exit_time=datetime(2026, 8, 1, tzinfo=timezone.utc)),
        FakePosition(id="p2", status="CLOSED", segment="NSE", exchange="NSE", symbol="A", action="BUY",
                     entry_price=100.0, quantity=10, strategy_id="s1", pnl=-200.0,
                     exit_time=datetime(2026, 8, 2, tzinfo=timezone.utc)),
        FakePosition(id="p3", status="OPEN", segment="NSE", exchange="NSE", symbol="A", action="BUY",
                     entry_price=100.0, quantity=10, strategy_id="s1"),
        FakePosition(id="p4", status="REJECTED", segment="NSE", exchange="NSE", symbol="B", action="SELL",
                     entry_price=50.0, quantity=5, strategy_id="s1"),
        # A manual/no-strategy position - must be excluded entirely.
        FakePosition(id="p5", status="CLOSED", segment="NSE", exchange="NSE", symbol="C", action="BUY",
                     entry_price=10.0, quantity=1, strategy_id=None, pnl=1000.0,
                     exit_time=datetime(2026, 8, 1, tzinfo=timezone.utc)),
    ]

    result = compute_strategy_performance(positions)

    assert set(result.keys()) == {"s1"}
    s1 = result["s1"]
    assert s1["trades_open"] == 1
    assert s1["trades_closed"] == 2
    assert s1["trades_rejected"] == 1
    assert s1["wins"] == 1
    assert s1["win_rate"] == pytest.approx(50.0)
    assert s1["total_realized_pnl"] == pytest.approx(300.0)
    assert s1["max_drawdown"] == pytest.approx(200.0)  # peak 500 -> 300


def test_compute_strategy_performance_no_closed_trades_yet():
    positions = [
        FakePosition(id="p1", status="OPEN", segment="NSE", exchange="NSE", symbol="A", action="BUY",
                     entry_price=100.0, quantity=10, strategy_id="s2"),
    ]
    result = compute_strategy_performance(positions)
    assert result["s2"]["trades_closed"] == 0
    assert result["s2"]["win_rate"] is None
    assert result["s2"]["max_drawdown"] == 0.0
    assert result["s2"]["total_realized_pnl"] == 0.0
