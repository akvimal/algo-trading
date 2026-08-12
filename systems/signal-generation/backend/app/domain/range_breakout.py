"""Single-timeframe Donchian breakout - "close greater than the last N
candles' high" (or below their low, for a bearish signal), on the
strategy's own `interval`. Structurally much closer to CrossoverRuleConfig
than to app/domain/breakout.py's multi-timeframe rule: no indicator, but
also no htf/ltf split and no rule-intrinsic exit scheme - the generic
stop-loss/target/square-off/trailing/opposite-signal exit engine in
app/domain/backtest.py (simulate_trades/replay, generalized to take any
bias_fn) applies as-is, same as crossover. Reuses breakout.py's
compute_donchian_high/compute_donchian_low directly rather than
duplicating that math."""

from typing import Optional

from app.domain.breakout import compute_donchian_high, compute_donchian_low
from app.domain.models import RangeBreakoutRuleConfig
from app.domain.rules import Bias, CandleClose


def range_breakout_warmup(rule: RangeBreakoutRuleConfig) -> int:
    """Bars needed before this rule can produce anything - same "coarse
    over-estimate" philosophy as breakout.breakout_warmup/
    engine.history_window."""
    return rule.breakout_period + 2


def evaluate_range_breakout(rule: RangeBreakoutRuleConfig, candles: list[CandleClose]) -> Optional[Bias]:
    """The latest candle in `candles` (any window length >= warmup) vs the
    Donchian channel of the `breakout_period` candles before it - used as
    the bias_fn passed into backtest.py's simulate_trades/replay for
    backtesting, and by evaluate_range_breakout_live below for the live
    tick (a single-candle-window special case of the same check)."""
    if len(candles) <= rule.breakout_period:
        return None
    highs = [c.high for c in candles]
    lows = [c.low for c in candles]
    donchian_high = compute_donchian_high(highs, rule.breakout_period)
    donchian_low = compute_donchian_low(lows, rule.breakout_period)
    i = len(candles) - 1
    close = candles[i].close
    if donchian_high[i] is not None and close > donchian_high[i]:
        return "bullish"
    if donchian_low[i] is not None and close < donchian_low[i]:
        return "bearish"
    return None


def evaluate_range_breakout_live(rule: RangeBreakoutRuleConfig, candles: list[CandleClose]) -> Optional[tuple[Bias, str]]:
    """The live engine tick's entry point - same check as
    evaluate_range_breakout, but also returns the triggering candle's
    timestamp for engine_runs' last_signal_candle_ts dedupe (mirrors
    breakout.evaluate_breakout_live's return shape)."""
    bias = evaluate_range_breakout(rule, candles)
    if bias is None:
        return None
    return bias, candles[-1].timestamp
