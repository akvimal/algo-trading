"""Tests for app/domain/generation/external_backtest.py - backtesting an
externally-supplied (symbol, timestamp) signal list (e.g. a Chartink alert
history CSV export) against a grid of exit configurations, reusing
backtest.py's simulate_trades/ExitConfig completely unchanged."""

from datetime import datetime, timedelta

import pytest

from app.domain.generation.backtest import ExitConfig
from app.domain.generation.external_backtest import (
    build_exit_config,
    expand_exit_grid,
    grid_search_external_signals,
    simulate_external_signals,
    simulate_external_signals_by_symbol,
)
from app.domain.generation.rules import CandleClose

_BASE_TS = datetime(2026, 8, 12, 9, 15)


def _ts(minute_offset: int) -> str:
    return (_BASE_TS + timedelta(minutes=minute_offset)).isoformat()


def _bar(minute_offset: int, close: float, high: float | None = None, low: float | None = None) -> CandleClose:
    return CandleClose(timestamp=_ts(minute_offset), close=close, high=high if high is not None else close, low=low if low is not None else close)


# --- simulate_external_signals: bias_fn from CSV timestamps ----------------------------------


def test_simulate_external_signals_opens_a_trade_at_the_signal_timestamp():
    candles = [_bar(0, 100), _bar(1, 102), _bar(2, 105), _bar(3, 103)]
    signals_by_symbol = {"RELIANCE": [_ts(1)]}

    trades = simulate_external_signals(signals_by_symbol, "bullish", {"RELIANCE": candles})

    assert len(trades) == 1
    assert trades[0].entry_time == _ts(1)
    assert trades[0].entry_price == 102
    assert trades[0].direction == "bullish"


def test_simulate_external_signals_fills_at_the_first_candle_at_or_after_a_signal_between_bars():
    """A real Chartink alert timestamp rarely lands exactly on a candle
    boundary - the fill happens at the first candle AT OR AFTER it."""
    candles = [_bar(0, 100), _bar(5, 102), _bar(10, 105)]
    signals_by_symbol = {"RELIANCE": [_ts(3)]}  # between the 0 and 5 minute bars

    trades = simulate_external_signals(signals_by_symbol, "bullish", {"RELIANCE": candles})

    assert len(trades) == 1
    assert trades[0].entry_time == _ts(5)
    assert trades[0].entry_price == 102


def test_simulate_external_signals_pools_trades_across_every_symbol():
    candles_a = [_bar(0, 100), _bar(1, 110)]
    candles_b = [_bar(0, 50), _bar(1, 45)]
    signals_by_symbol = {"A": [_ts(0)], "B": [_ts(0)]}

    trades = simulate_external_signals(signals_by_symbol, "bullish", {"A": candles_a, "B": candles_b})

    assert len(trades) == 2
    assert {t.entry_price for t in trades} == {100, 50}


def test_simulate_external_signals_by_symbol_keeps_each_symbols_trades_separate():
    """The /backtest-signals/trades route needs to attach a symbol to
    each trade - simulate_external_signals (the flat-list version, used
    by the grid search) intentionally throws that away, but the by-symbol
    version underneath it must keep it."""
    candles_a = [_bar(0, 100), _bar(1, 110)]
    candles_b = [_bar(0, 50), _bar(1, 45)]
    signals_by_symbol = {"A": [_ts(0)], "B": [_ts(0)]}

    by_symbol = simulate_external_signals_by_symbol(signals_by_symbol, "bullish", {"A": candles_a, "B": candles_b})

    assert set(by_symbol) == {"A", "B"}
    assert len(by_symbol["A"]) == 1
    assert by_symbol["A"][0].entry_price == 100
    assert len(by_symbol["B"]) == 1
    assert by_symbol["B"][0].entry_price == 50


def test_simulate_external_signals_is_simulate_external_signals_by_symbol_flattened():
    candles_a = [_bar(0, 100), _bar(1, 110)]
    candles_b = [_bar(0, 50), _bar(1, 45)]
    signals_by_symbol = {"A": [_ts(0)], "B": [_ts(0)]}

    flat = simulate_external_signals(signals_by_symbol, "bullish", {"A": candles_a, "B": candles_b})
    by_symbol = simulate_external_signals_by_symbol(signals_by_symbol, "bullish", {"A": candles_a, "B": candles_b})

    assert {t.entry_price for t in flat} == {t.entry_price for trades in by_symbol.values() for t in trades}


def test_simulate_external_signals_ignores_a_symbol_with_no_fetched_candles():
    signals_by_symbol = {"UNKNOWN": [_ts(0)], "A": [_ts(0)]}
    candles_a = [_bar(0, 100), _bar(1, 110)]

    trades = simulate_external_signals(signals_by_symbol, "bullish", {"A": candles_a})

    assert len(trades) == 1
    assert trades[0].entry_price == 100


def test_simulate_external_signals_a_second_signal_while_a_trade_is_open_is_skipped():
    """Mirrors live duplicate_signal_policy='skip' - only one trade open
    per symbol at a time, same as simulate_trades already enforces for
    every other bias_fn type."""
    candles = [_bar(0, 100), _bar(1, 101), _bar(2, 102), _bar(3, 103)]
    # A second signal at minute 1, while the minute-0 entry is presumably
    # still open (no exit config set - runs to end_of_data) - never opens
    # a second trade.
    signals_by_symbol = {"RELIANCE": [_ts(0), _ts(1)]}

    trades = simulate_external_signals(signals_by_symbol, "bullish", {"RELIANCE": candles})

    assert len(trades) == 1
    assert trades[0].entry_time == _ts(0)


def test_simulate_external_signals_respects_the_given_exit_config():
    candles = [_bar(0, 100), _bar(1, 90, high=95, low=88), _bar(2, 80)]
    signals_by_symbol = {"RELIANCE": [_ts(0)]}
    exit_config = ExitConfig(stop_loss_method="percent", stop_loss_percent=5)

    trades = simulate_external_signals(signals_by_symbol, "bullish", {"RELIANCE": candles}, exit_config)

    assert len(trades) == 1
    assert trades[0].exit_reason == "stop_loss"


# --- expand_exit_grid: cartesian product + cap ------------------------------------------------


def test_expand_exit_grid_cartesian_product():
    combos = expand_exit_grid([1.0, 2.0], [None, 4.0], [False, True])

    assert len(combos) == 8
    assert {"stop_loss_value": 1.0, "target_percent": None, "trailing_stop_enabled": False} in combos
    assert {"stop_loss_value": 2.0, "target_percent": 4.0, "trailing_stop_enabled": True} in combos


def test_expand_exit_grid_too_large_raises():
    with pytest.raises(ValueError, match="max is"):
        expand_exit_grid(list(range(20)), list(range(20)), [False, True])


def test_expand_exit_grid_empty_dimension_raises():
    with pytest.raises(ValueError):
        expand_exit_grid([], [None], [False])


# --- build_exit_config: combo -> ExitConfig ----------------------------------------------------


def test_build_exit_config_percent_method_maps_stop_loss_value_to_percent():
    combo = {"stop_loss_value": 2.5, "target_percent": 4.0, "trailing_stop_enabled": True}
    cfg = build_exit_config(combo, "percent", None)

    assert cfg.stop_loss_percent == 2.5
    assert cfg.stop_loss_indicator_params is None
    assert cfg.target_percent == 4.0
    assert cfg.trailing_stop_enabled is True


def test_build_exit_config_indicator_method_maps_stop_loss_value_to_indicator_params():
    combo = {"stop_loss_value": {"period": 20}, "target_percent": None, "trailing_stop_enabled": False}
    cfg = build_exit_config(combo, "indicator", "ema")

    assert cfg.stop_loss_indicator_params == {"period": 20}
    assert cfg.stop_loss_percent is None
    assert cfg.stop_loss_indicator_type == "ema"


# --- grid_search_external_signals: ranked report ------------------------------------------------


def test_grid_search_external_signals_ranks_by_hypothetical_pnl_descending():
    # A rally that a tight 1% stop gets shaken out of, a wide 10% stop rides.
    candles = [_bar(0, 100), _bar(1, 99, high=99, low=98.5), _bar(2, 120)]
    signals_by_symbol = {"RELIANCE": [_ts(0)]}
    combos = expand_exit_grid([1.0, 10.0], [None], [False])

    results = grid_search_external_signals(signals_by_symbol, "bullish", {"RELIANCE": candles}, combos, "percent", None)

    assert len(results) == 2
    assert results[0]["stop_loss_value"] == 10.0
    assert results[0]["hypothetical_pnl"] > results[1]["hypothetical_pnl"]


def test_grid_search_external_signals_reports_trade_count_and_win_rate():
    candles = [_bar(0, 100), _bar(1, 110)]
    signals_by_symbol = {"RELIANCE": [_ts(0)]}
    combos = expand_exit_grid([5.0], [None], [False])

    results = grid_search_external_signals(signals_by_symbol, "bullish", {"RELIANCE": candles}, combos, "percent", None)

    assert results[0]["trade_count"] == 1
    assert results[0]["win_rate"] == 100.0
