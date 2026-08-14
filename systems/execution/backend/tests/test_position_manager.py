from dataclasses import dataclass
from datetime import datetime, time, timezone
from typing import Optional

import pytest

from app.domain.position_manager import (
    _STOP_LOSS_COMPUTE_FUNCS,
    _apply_realized_pnl,
    _evaluate_exits,
    _evaluate_square_off_due,
    _resolve_signal_conflicts,
    compute_ema,
    compute_pnl,
    compute_quantity,
    compute_risk_based_quantity,
    compute_stop_loss_percent_price,
    compute_target_percent_price,
    compute_unrealized_pnl,
    is_supported,
    is_within_intraday_window,
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
    exit_price: Optional[float] = None
    exit_time: Optional[object] = None
    pnl: Optional[float] = None
    exit_reason: Optional[str] = None
    square_off_time: Optional[time] = None


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
    """A fresh {segment: FakeAccount} dict per call - _apply_realized_pnl
    mutates the account object in place, so tests that assert on balance
    need their own isolated instance rather than a shared module-level one."""
    return {segment: FakeAccount(segment=segment, starting_balance=balance, current_balance=balance)}


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
    assert is_supported("swing", "spot") is False
    assert is_supported("swing", "future") is False
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
    assert compute([20.0, 20.0, 20.0, 20.0, 8.0], {"period": 2}) == pytest.approx(12.0)


def test_stop_loss_compute_funcs_ema_insufficient_history_returns_none():
    compute = _STOP_LOSS_COMPUTE_FUNCS["ema"]
    assert compute([10.0], {"period": 2}) is None


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
    assert accounts["NSE"].current_balance == 200000.0  # untouched - nothing closed


def test_evaluate_exits_closing_a_loser_debits_its_segment_account():
    accounts = _accounts(balance=200000.0)
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, stop_loss_price=98.0, segment="NSE"),
    ]
    _evaluate_exits(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 97.5}, get_previous_candle=lambda *a: None, accounts_by_segment=accounts)

    expected_pnl = compute_pnl("BUY", 100.0, 97.5, 10)  # -25.0
    assert positions[0].pnl == expected_pnl
    assert accounts["NSE"].current_balance == 200000.0 + expected_pnl


# --- periodic due-position closing (each position's own stored square_off_time) -----------


def test_evaluate_square_off_due_closes_position_past_its_own_time():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, square_off_time=time(14, 30)),
    ]
    result = _evaluate_square_off_due(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 105.0}, now_local=time(14, 30), accounts_by_segment=_accounts())

    assert result == {"closed": 1, "failed": 0, "checked": 1}
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

    assert result == {"closed": 0, "failed": 0, "checked": 0}
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

    assert result == {"closed": 0, "failed": 0, "checked": 0}
    assert positions[0].status == "OPEN"


def test_evaluate_square_off_due_leaves_position_open_when_quote_fetch_fails():
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, square_off_time=time(14, 0)),
    ]
    result = _evaluate_square_off_due(positions, get_ltp_batch=lambda ex, syms: {}, now_local=time(15, 0), accounts_by_segment=_accounts())

    assert result == {"closed": 0, "failed": 1, "checked": 1}
    assert positions[0].status == "OPEN"


def test_evaluate_square_off_due_credits_its_segment_account():
    accounts = _accounts(balance=200000.0)
    positions = [
        FakePosition(id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY",
                     entry_price=100.0, quantity=10, square_off_time=time(14, 30), segment="NSE"),
    ]
    _evaluate_square_off_due(positions, get_ltp_batch=lambda ex, syms: {"RELIANCE": 105.0}, now_local=time(14, 30), accounts_by_segment=accounts)

    expected_pnl = compute_pnl("BUY", 100.0, 105.0, 10)  # +50.0
    assert accounts["NSE"].current_balance == 200000.0 + expected_pnl


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
