from datetime import datetime, timedelta

from app.domain.generation.rule import RangeBreakoutRuleConfig
from app.domain.generation.range_breakout import (
    evaluate_range_breakout,
    evaluate_range_breakout_live,
    range_breakout_warmup,
)
from app.domain.generation.rules import CandleClose

BASE = datetime(2026, 8, 12, 9, 15)
RULE = RangeBreakoutRuleConfig(breakout_period=4)


def _bar(minute_offset: int, close: float) -> CandleClose:
    """Flat candle (high=low=close) - fine here since compute_donchian_high/low
    (already covered by test_breakout.py) is the only thing reading high/low;
    these tests only exercise the close-vs-channel comparison."""
    ts = (BASE + timedelta(minutes=minute_offset)).isoformat()
    return CandleClose(timestamp=ts, close=close, high=close, low=close)


def _candles(closes: list[float]) -> list[CandleClose]:
    return [_bar(i, c) for i, c in enumerate(closes)]


def test_range_breakout_warmup():
    assert range_breakout_warmup(RULE) == 6  # breakout_period(4) + 2


def test_evaluate_range_breakout_fresh_bullish_breakout():
    # prior 4 closes: 10,10,10,10 -> donchian_high=10; last close 15 > 10.
    candles = _candles([10, 10, 10, 10, 15])
    assert evaluate_range_breakout(RULE, candles) == "bullish"


def test_evaluate_range_breakout_fresh_bearish_breakout():
    # prior 4 closes: 10,10,10,10 -> donchian_low=10; last close 5 < 10.
    candles = _candles([10, 10, 10, 10, 5])
    assert evaluate_range_breakout(RULE, candles) == "bearish"


def test_evaluate_range_breakout_inside_range_is_none():
    candles = _candles([10, 10, 10, 10, 10])
    assert evaluate_range_breakout(RULE, candles) is None


def test_evaluate_range_breakout_insufficient_warmup_is_none():
    # len(candles) == breakout_period - not even one bar past the channel.
    candles = _candles([10, 10, 10, 10])
    assert evaluate_range_breakout(RULE, candles) is None


def test_evaluate_range_breakout_reuses_full_window_not_just_latest_bars():
    # A longer window still only cares about the latest bar vs the
    # channel formed by the breakout_period bars immediately before it.
    candles = _candles([50, 50, 10, 10, 10, 10, 15])
    assert evaluate_range_breakout(RULE, candles) == "bullish"


def test_evaluate_range_breakout_live_returns_bias_and_latest_timestamp():
    candles = _candles([10, 10, 10, 10, 15])
    result = evaluate_range_breakout_live(RULE, candles)
    assert result is not None
    bias, ts = result
    assert bias == "bullish"
    assert ts == candles[-1].timestamp


def test_evaluate_range_breakout_live_none_when_no_breakout():
    candles = _candles([10, 10, 10, 10, 10])
    assert evaluate_range_breakout_live(RULE, candles) is None
