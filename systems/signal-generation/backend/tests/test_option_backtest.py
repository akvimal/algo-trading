"""Tests for app/domain/option_backtest.py (Phase 4c of the options
trading module - see docs/architecture.md). Pure functions, hand-built
fake candle series - no network/mocking needed, same style as
test_backtest.py."""

from datetime import datetime, timedelta

from app.domain.backtest import ExitConfig
from app.domain.option_backtest import (
    combined_series,
    legs_for_direction,
    simulate_option_trades,
)
from app.domain.rules import CandleClose

_BASE_TS = datetime(2026, 8, 12, 9, 15)


def _ts(minute_offset: int) -> str:
    return (_BASE_TS + timedelta(minutes=minute_offset)).isoformat()


def _bar(minute_offset: int, close: float, high: float | None = None, low: float | None = None) -> CandleClose:
    return CandleClose(timestamp=_ts(minute_offset), close=close, high=high if high is not None else close, low=low if low is not None else close)


# --- legs_for_direction -----------------------------------------------------------------------


def test_legs_for_direction_bullish_is_bull_call_spread():
    assert legs_for_direction("bullish") == ("CE", "ATM", "ATM+2")


def test_legs_for_direction_bearish_is_bear_put_spread():
    assert legs_for_direction("bearish") == ("PE", "ATM", "ATM-2")


# --- combined_series ---------------------------------------------------------------------------


def test_combined_series_computes_close_and_worst_best_case_high_low():
    long_candles = [_bar(0, close=100, high=105, low=95)]
    short_candles = [_bar(0, close=40, high=45, low=35)]

    combined = combined_series(long_candles, short_candles)

    assert len(combined) == 1
    c = combined[0]
    assert c.close == 60  # 100 - 40
    assert c.high == 70  # long.high(105) - short.low(35) - best case
    assert c.low == 50  # long.low(95) - short.high(45) - worst case


def test_combined_series_drops_bars_missing_on_either_leg():
    long_candles = [_bar(0, close=100), _bar(1, close=101)]
    short_candles = [_bar(0, close=40)]  # no bar at minute 1

    combined = combined_series(long_candles, short_candles)

    assert len(combined) == 1
    assert combined[0].timestamp == _ts(0)


# --- simulate_option_trades --------------------------------------------------------------------


def _bias_fn_always_bullish_once(window: list[CandleClose]):
    """Fires bullish exactly once, on the 3rd bar (index 2) - enough bars
    to have a real window, never re-fires (mirrors a real rule that only
    signals on a fresh crossover, not every bar)."""
    if len(window) == 3:
        return "bullish"
    return None


def test_simulate_option_trades_closes_on_combined_stop_loss():
    underlying_candles = [_bar(i, close=100 + i) for i in range(6)]  # entry at bar index 2 (minute 2)

    # Long CE stays flat, short CE spikes up (premium the trader is short
    # rises against them) - combined premium (long-short) drops, should
    # hit combined_stop_loss before the window's own natural end.
    long_leg = [_bar(i, close=50, high=50, low=50) for i in range(2, 6)]
    short_leg = [
        _bar(2, close=20, high=20, low=20),
        _bar(3, close=25, high=25, low=25),
        _bar(4, close=40, high=40, low=15),  # combined low = 50-40=10 vs entry 30 -> way below any reasonable SL
        _bar(5, close=40, high=40, low=15),
    ]

    def leg_fetcher(option_type, strike):
        assert option_type == "CE"
        return long_leg if strike == "ATM" else short_leg

    exit_config = ExitConfig(stop_loss_percent=10.0)  # entry combined = 50-20=30, SL at 27
    trades = simulate_option_trades(_bias_fn_always_bullish_once, 3, underlying_candles, "WEEK", exit_config, leg_fetcher)

    assert len(trades) == 1
    trade = trades[0]
    assert trade["direction"] == "bullish"
    assert trade["exit_reason"] == "combined_stop_loss"
    assert trade["entry_price"] == 30  # 50 - 20
    assert trade["legs"]["option_type"] == "CE"
    assert trade["legs"]["long_strike"] == "ATM"
    assert trade["legs"]["short_strike"] == "ATM+2"


def test_simulate_option_trades_falls_through_to_outer_window_reason_when_no_sl_target_hit():
    underlying_candles = [_bar(i, close=100 + i) for i in range(6)]

    long_leg = [_bar(i, close=50, high=50, low=50) for i in range(2, 6)]
    short_leg = [_bar(i, close=20, high=20, low=20) for i in range(2, 6)]

    def leg_fetcher(option_type, strike):
        return long_leg if strike == "ATM" else short_leg

    # No SL/target configured -> combined position rides to the window's
    # own natural boundary (end_of_data, since no opposite signal ever
    # fires and no square_off_time is configured here).
    trades = simulate_option_trades(_bias_fn_always_bullish_once, 3, underlying_candles, "WEEK", ExitConfig(), leg_fetcher)

    assert len(trades) == 1
    assert trades[0]["exit_reason"] == "end_of_data"
    assert trades[0]["pnl"] == 0  # flat legs the whole way


def test_simulate_option_trades_skips_window_when_legs_unresolvable():
    underlying_candles = [_bar(i, close=100 + i) for i in range(6)]

    def leg_fetcher(option_type, strike):
        return None  # unresolvable underlying/strike on market-data's side

    trades = simulate_option_trades(_bias_fn_always_bullish_once, 3, underlying_candles, "WEEK", ExitConfig(), leg_fetcher)

    assert trades == []
