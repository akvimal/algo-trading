"""Tests for app/domain/multi_condition.py - the MultiConditionRuleConfig
evaluator (compute_term_series, evaluate_condition/evaluate_multi_condition,
the multi-interval alignment helper, and the backtest bias_fn builder)."""

import pytest

from app.domain.multi_condition import (
    align_fine_to_coarse_indices,
    build_multi_condition_bias_fn,
    compute_term_series,
    evaluate_condition,
    evaluate_multi_condition,
    evaluate_multi_condition_live,
    multi_condition_warmup,
)
from app.domain.rule import Condition, MultiConditionRuleConfig, Term
from app.domain.rules import CandleClose


def _candle(timestamp: str, o: float, h: float, lo: float, c: float, v: float = 0.0) -> CandleClose:
    return CandleClose(timestamp=timestamp, close=c, high=h, low=lo, open=o, volume=v)


def _daily(day: int, o: float, h: float, lo: float, c: float, v: float = 0.0) -> CandleClose:
    return _candle(f"2026-01-{day:02d}T00:00:00", o, h, lo, c, v)


def _min15(day: int, hour: int, o: float, h: float, lo: float, c: float, v: float = 0.0) -> CandleClose:
    return _candle(f"2026-01-{day:02d}T{hour:02d}:00:00", o, h, lo, c, v)


# --- compute_term_series: one per kind ---------------------------------------------------------


def test_compute_term_series_constant():
    candles = [_daily(1, 1, 1, 1, 1), _daily(2, 1, 1, 1, 1)]
    series = compute_term_series(Term(kind="constant", value=42.0), candles)
    assert series == [42.0, 42.0]


def test_compute_term_series_price_field():
    candles = [_daily(1, 10, 12, 9, 11), _daily(2, 11, 13, 10, 12)]
    assert compute_term_series(Term(kind="price", field="close"), candles) == [11, 12]
    assert compute_term_series(Term(kind="price", field="open"), candles) == [10, 11]


def test_compute_term_series_volume():
    candles = [_daily(1, 1, 1, 1, 1, v=100), _daily(2, 1, 1, 1, 1, v=200)]
    assert compute_term_series(Term(kind="volume"), candles) == [100, 200]


def test_compute_term_series_candle_body_and_range():
    candles = [_daily(1, o=10, h=15, lo=8, c=13)]
    assert compute_term_series(Term(kind="candle_body"), candles) == [3]  # |13-10|
    assert compute_term_series(Term(kind="candle_range"), candles) == [7]  # 15-8


def test_compute_term_series_sma_of_close():
    candles = [_daily(i, 1, 1, 1, c) for i, c in enumerate([10.0, 20.0, 30.0], start=1)]
    series = compute_term_series(Term(kind="sma", field="close", period=3), candles)
    assert series == [None, None, 20.0]


def test_compute_term_series_ema_matches_regime_compute_ema():
    from app.domain.regime import compute_ema

    closes = [10.0, 11.0, 12.0, 13.0, 14.0]
    candles = [_daily(i, 1, 1, 1, c) for i, c in enumerate(closes, start=1)]
    series = compute_term_series(Term(kind="ema", field="close", period=3), candles)
    assert series == compute_ema(closes, 3)


def test_compute_term_series_rsi_matches_compute_rsi():
    from app.domain.indicators import compute_rsi

    closes = [10.0, 11.0, 10.0, 13.0, 20.0]
    candles = [_daily(i, 1, 1, 1, c) for i, c in enumerate(closes, start=1)]
    series = compute_term_series(Term(kind="rsi", period=2), candles)
    assert series == compute_rsi(closes, 2)


def test_compute_term_series_cci_matches_compute_cci():
    from app.domain.indicators import compute_cci

    candles = [_daily(i, 1, h, lo, c) for i, (h, lo, c) in enumerate([(10, 8, 9), (12, 10, 11), (14, 12, 13)], start=1)]
    assert compute_term_series(Term(kind="cci", period=3), candles) == compute_cci(candles, 3)


def test_compute_term_series_highest_excludes_current_bar():
    # Donchian semantics (breakout.compute_donchian_high) - period=2 window
    # is the 2 bars BEFORE the current one, so this already IS "N days ago
    # highest", no offset_bars needed for the common case.
    highs = [10.0, 20.0, 5.0, 30.0]
    candles = [_daily(i, 1, h, 1, 1) for i, h in enumerate(highs, start=1)]
    series = compute_term_series(Term(kind="highest", field="high", period=2), candles)
    assert series == [None, None, 20.0, 20.0]  # index 3 (5.0): max(highs[1:3]) = max(20,5) = 20


def test_compute_term_series_lowest():
    lows = [10.0, 5.0, 8.0, 30.0]
    candles = [_daily(i, 1, 1, lo, 1) for i, lo in enumerate(lows, start=1)]
    series = compute_term_series(Term(kind="lowest", field="low", period=2), candles)
    assert series == [None, None, 5.0, 5.0]


def test_compute_term_series_offset_bars_shifts_series():
    candles = [_daily(i, 1, 1, 1, c) for i, c in enumerate([10.0, 20.0, 30.0, 40.0], start=1)]
    plain = compute_term_series(Term(kind="price", field="close"), candles)
    shifted = compute_term_series(Term(kind="price", field="close", offset_bars=2), candles)
    assert plain == [10.0, 20.0, 30.0, 40.0]
    assert shifted == [None, None, 10.0, 20.0]


def test_compute_term_series_scale_multiplies_final_value():
    candles = [_daily(1, o=10, h=15, lo=8, c=13)]
    series = compute_term_series(Term(kind="candle_range", scale=0.25), candles)
    assert series == [7 * 0.25]


# --- Term shape validation (app/domain/rule.py) -------------------------------------------------


def test_term_price_requires_field():
    with pytest.raises(ValueError):
        Term(kind="price")


def test_term_constant_requires_value():
    with pytest.raises(ValueError):
        Term(kind="constant")


def test_term_volume_rejects_field():
    with pytest.raises(ValueError):
        Term(kind="volume", field="close")


def test_term_sma_requires_period():
    with pytest.raises(ValueError):
        Term(kind="sma", field="close")


# --- evaluate_condition / evaluate_multi_condition ----------------------------------------------


def test_evaluate_condition_true():
    candles = [_daily(1, o=10, h=11, lo=9, c=12)]
    condition = Condition(interval="daily", left=Term(kind="price", field="close"), operator=">", right=Term(kind="price", field="open"))
    assert evaluate_condition(condition, {"daily": candles}) is True


def test_evaluate_condition_false():
    candles = [_daily(1, o=12, h=13, lo=9, c=10)]
    condition = Condition(interval="daily", left=Term(kind="price", field="close"), operator=">", right=Term(kind="price", field="open"))
    assert evaluate_condition(condition, {"daily": candles}) is False


def test_evaluate_condition_none_when_interval_missing():
    condition = Condition(interval="daily", left=Term(kind="price", field="close"), operator=">", right=Term(kind="price", field="open"))
    assert evaluate_condition(condition, {}) is None


def test_evaluate_condition_none_when_still_warming_up():
    candles = [_daily(1, 1, 1, 1, 10.0), _daily(2, 1, 1, 1, 20.0)]  # only 2 bars, sma period=5
    condition = Condition(interval="daily", left=Term(kind="sma", field="close", period=5), operator=">", right=Term(kind="constant", value=0))
    assert evaluate_condition(condition, {"daily": candles}) is None


def test_evaluate_multi_condition_all_true_returns_direction():
    candles = [_daily(1, o=10, h=15, lo=8, c=13)]
    rule = MultiConditionRuleConfig(
        direction="bullish",
        conditions=[
            Condition(interval="daily", left=Term(kind="price", field="close"), operator=">", right=Term(kind="price", field="open")),
            Condition(interval="daily", left=Term(kind="candle_body"), operator=">", right=Term(kind="constant", value=1)),
        ],
    )
    assert evaluate_multi_condition(rule, {"daily": candles}) == "bullish"


def test_evaluate_multi_condition_one_false_returns_none():
    candles = [_daily(1, o=10, h=15, lo=8, c=13)]
    rule = MultiConditionRuleConfig(
        direction="bullish",
        conditions=[
            Condition(interval="daily", left=Term(kind="price", field="close"), operator=">", right=Term(kind="price", field="open")),
            Condition(interval="daily", left=Term(kind="candle_body"), operator=">", right=Term(kind="constant", value=100)),  # false
        ],
    )
    assert evaluate_multi_condition(rule, {"daily": candles}) is None


def test_evaluate_multi_condition_live_returns_bias_and_finest_timestamp():
    daily = [_daily(1, o=10, h=15, lo=8, c=13)]
    fine = [_min15(1, 9, o=1, h=2, lo=1, c=1.5), _candle("2026-01-01T09:30:00", 1, 2, 1, 2)]
    rule = MultiConditionRuleConfig(
        direction="bullish",
        conditions=[Condition(interval="15min", left=Term(kind="price", field="close"), operator=">", right=Term(kind="price", field="open"))],
    )
    result = evaluate_multi_condition_live(rule, {"daily": daily, "15min": fine})
    assert result == ("bullish", "2026-01-01T09:30:00")


# --- multi_condition_warmup ---------------------------------------------------------------------


def test_multi_condition_warmup_max_per_interval():
    rule = MultiConditionRuleConfig(
        direction="bullish",
        conditions=[
            Condition(interval="daily", left=Term(kind="sma", field="close", period=20), operator=">", right=Term(kind="constant", value=0)),
            Condition(interval="daily", left=Term(kind="ema", field="close", period=200), operator=">", right=Term(kind="constant", value=0)),
            Condition(interval="15min", left=Term(kind="cci", period=200), operator=">", right=Term(kind="constant", value=100)),
        ],
    )
    warmup = multi_condition_warmup(rule)
    assert warmup["daily"] == 200  # max(20, 200)
    assert warmup["15min"] == 200


# --- align_fine_to_coarse_indices: the no-lookahead multi-interval mapping ----------------------


def test_align_fine_to_coarse_indices_no_lookahead():
    # 2 daily bars: day1 (completes at day2 00:00), day2 (completes at day3 00:00).
    daily = [_daily(1, 1, 1, 1, 1), _daily(2, 1, 1, 1, 1)]
    fine = [
        _candle("2026-01-01T10:00:00", 1, 1, 1, 1),  # during day1, before it's complete -> no coarse bar known
        _candle("2026-01-02T10:00:00", 1, 1, 1, 1),  # after day1 completed (day2 00:00) -> index 0
        _candle("2026-01-03T10:00:00", 1, 1, 1, 1),  # after day2 completed (day3 00:00) -> index 1
    ]
    indices = align_fine_to_coarse_indices(fine, daily, "daily")
    assert indices == [-1, 0, 1]


# --- build_multi_condition_bias_fn: end-to-end backtest bias_fn ---------------------------------


def test_build_multi_condition_bias_fn_mixed_interval():
    daily = [_daily(1, o=10, h=12, lo=9, c=11), _daily(2, o=11, h=14, lo=10, c=13)]
    fine = [
        _candle("2026-01-02T09:15:00", o=13, h=14, lo=13, c=13.5),  # day1 known (close 11 > open 10 -> true)
        _candle("2026-01-03T09:15:00", o=13, h=14, lo=13, c=13.5),  # day2 known (close 13 > open 11 -> true)
    ]
    rule = MultiConditionRuleConfig(
        direction="bullish",
        conditions=[
            Condition(interval="daily", left=Term(kind="price", field="close"), operator=">", right=Term(kind="price", field="open")),
            Condition(interval="15min", left=Term(kind="price", field="close"), operator=">", right=Term(kind="price", field="open")),
        ],
    )
    bias_fn = build_multi_condition_bias_fn(rule, {"daily": daily, "15min": fine})
    assert bias_fn(fine[:1]) == "bullish"
    assert bias_fn(fine[:2]) == "bullish"


def test_build_multi_condition_bias_fn_returns_none_before_coarse_interval_known():
    daily = [_daily(1, o=10, h=12, lo=9, c=11)]
    fine = [_candle("2026-01-01T09:15:00", o=1, h=2, lo=1, c=2)]  # same day as the only daily bar - not yet known
    rule = MultiConditionRuleConfig(
        direction="bullish",
        conditions=[Condition(interval="daily", left=Term(kind="price", field="close"), operator=">", right=Term(kind="price", field="open"))],
    )
    bias_fn = build_multi_condition_bias_fn(rule, {"daily": daily, "15min": fine})
    assert bias_fn(fine[:1]) is None
