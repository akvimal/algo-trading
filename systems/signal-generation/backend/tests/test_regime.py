import pytest

from app.domain.regime import (
    ALL_REGIME_CHECKS,
    DEFAULT_REGIME_PARAMS,
    RegimeParams,
    RegimeResult,
    check_adx,
    check_dmi_direction,
    check_efficiency_ratio,
    check_ema_slope,
    check_structure,
    check_supertrend,
    classify_regime,
    classify_structure,
    compute_adx_dmi,
    compute_atr,
    compute_efficiency_ratio,
    compute_ema,
    compute_ema_slope,
    compute_supertrend,
    direction_confirmed,
    find_pivots,
    regime_warmup,
)
from app.domain.rules import CandleClose


def _flat(closes: list[float]) -> list[CandleClose]:
    return [CandleClose(timestamp=f"t{i}", close=c, high=c, low=c) for i, c in enumerate(closes)]


def _ranged(values: list[tuple[float, float, float]]) -> list[CandleClose]:
    """values: (close, high, low) triples."""
    return [CandleClose(timestamp=f"t{i}", close=c, high=h, low=l) for i, (c, h, l) in enumerate(values)]


# --- find_pivots / classify_structure --------------------------------------------------------


def test_find_pivots_and_classify_structure_bullish():
    # Zigzag with clear higher highs and higher lows (lookback=2).
    closes = [10, 12, 15, 12, 10, 13, 17, 14, 11, 15, 19, 16, 13]
    candles = _flat(closes)

    pivot_highs, pivot_lows = find_pivots(candles, lookback=2)

    assert pivot_highs == [2, 6, 10]
    assert pivot_lows == [4, 8]
    assert classify_structure(candles, pivot_highs, pivot_lows) == "HH_HL"


def test_find_pivots_and_classify_structure_bearish():
    # Mirror of the bullish fixture - lower highs, lower lows.
    closes = [19, 17, 14, 17, 19, 16, 12, 15, 18, 14, 10, 13, 16]
    candles = _flat(closes)

    pivot_highs, pivot_lows = find_pivots(candles, lookback=2)
    structure = classify_structure(candles, pivot_highs, pivot_lows)

    assert structure == "LH_LL"


def test_classify_structure_mixed_when_contradictory():
    # A higher high but a LOWER low - contradictory, not a clean trend.
    candles = _flat([10, 12, 15, 12, 10, 13, 17, 14, 8, 15, 19, 16, 13])
    pivot_highs, pivot_lows = find_pivots(candles, lookback=2)
    assert classify_structure(candles, pivot_highs, pivot_lows) == "MIXED"


def test_classify_structure_insufficient_with_too_few_pivots():
    candles = _flat([10, 12, 15, 12, 10])
    pivot_highs, pivot_lows = find_pivots(candles, lookback=2)
    assert classify_structure(candles, pivot_highs, pivot_lows) == "insufficient"


# --- compute_efficiency_ratio: the source document's own two examples ------------------------


def test_efficiency_ratio_strong_directional_move_is_close_to_one():
    closes = [100, 102, 104, 106, 108]
    assert compute_efficiency_ratio(closes, period=4) == pytest.approx(1.0)


def test_efficiency_ratio_choppy_move_is_low():
    closes = [100, 103, 99, 102, 98, 101]
    er = compute_efficiency_ratio(closes, period=5)
    assert er == pytest.approx(1 / 17)
    assert er < 0.25


def test_efficiency_ratio_none_before_enough_bars():
    assert compute_efficiency_ratio([100, 101], period=5) is None


# --- compute_atr / compute_ema: exact-value sanity checks ------------------------------------


def test_compute_atr_settles_to_the_constant_true_range():
    # close rises by 1 each bar, high=close+1/low=close-1 (constant range,
    # no gaps) - true range is exactly 2 on every bar, so ATR must settle
    # to exactly 2.0.
    candles = _ranged([(50 + i, 50 + i + 1, 50 + i - 1) for i in range(20)])
    atr = compute_atr(candles, period=5)
    assert atr[-1] == pytest.approx(2.0)


def test_compute_ema_of_a_constant_series_equals_that_constant():
    closes = [50.0] * 30
    ema = compute_ema(closes, period=10)
    assert ema[9] == pytest.approx(50.0)
    assert ema[-1] == pytest.approx(50.0)


def test_compute_ema_none_before_enough_bars():
    assert compute_ema([1.0, 2.0], period=5)[-1] is None


# --- compute_supertrend: used as stop_loss_indicator_type='supertrend' -----------------------


def test_compute_supertrend_none_before_enough_bars():
    candles = _ranged([(50 + i, 50 + i + 1, 50 + i - 1) for i in range(4)])
    assert compute_supertrend(candles, period=5, multiplier=1.0)[-1] is None


def test_compute_supertrend_settles_below_price_in_a_steady_uptrend():
    # Constant true range of 2 (high=close+1/low=close-1, matching
    # test_compute_atr_settles_to_the_constant_true_range) means ATR
    # settles to exactly 2.0 immediately - once the line has locked into
    # the uptrend it should track close - multiplier*ATR = close - 2.0
    # bar-for-bar, hand-verified by running the function.
    candles = _ranged([(50 + i, 50 + i + 1, 50 + i - 1) for i in range(20)])
    st = compute_supertrend(candles, period=5, multiplier=1.0)
    assert st[-1] == pytest.approx(candles[-1].close - 2.0)
    assert st[-1] < candles[-1].close  # below price - a valid bullish stop


def test_compute_supertrend_settles_above_price_in_a_steady_downtrend():
    candles = _ranged([(100 - i, 100 - i + 1, 100 - i - 1) for i in range(20)])
    st = compute_supertrend(candles, period=5, multiplier=1.0)
    assert st[-1] == pytest.approx(candles[-1].close + 2.0)
    assert st[-1] > candles[-1].close  # above price - a valid bearish stop


def test_compute_ema_slope_zero_for_a_flat_series():
    candles = _ranged([(50.0, 50.5, 49.5) for _ in range(30)])
    closes = [c.close for c in candles]
    atr = compute_atr(candles, period=14)
    slope = compute_ema_slope(closes, atr, ema_period=20, lookback=5)
    assert slope == pytest.approx(0.0)


def test_compute_ema_slope_positive_for_a_rising_series():
    candles = _ranged([(50 + i * 0.5, 50 + i * 0.5 + 0.5, 50 + i * 0.5 - 0.5) for i in range(40)])
    closes = [c.close for c in candles]
    atr = compute_atr(candles, period=14)
    slope = compute_ema_slope(closes, atr, ema_period=20, lookback=5)
    assert slope is not None
    assert slope > 0


# --- compute_adx_dmi: directional sanity checks (not hand-traced Wilder math) -----------------


def _monotonic_trend_candles(n: int, step: float) -> list[CandleClose]:
    candles = []
    price = 100.0
    for i in range(n):
        price += step
        candles.append(CandleClose(timestamp=f"t{i}", close=price, high=price + 0.3, low=price - 0.3))
    return candles


def test_adx_dmi_plus_di_dominates_in_a_steady_uptrend():
    candles = _monotonic_trend_candles(60, step=1.0)
    atr = compute_atr(candles, period=14)
    adx, plus_di, minus_di = compute_adx_dmi(candles, period=14, atr_series=atr)

    assert adx[-1] is not None
    assert plus_di[-1] > minus_di[-1]
    assert adx[-1] > DEFAULT_REGIME_PARAMS.adx_trend_threshold


def test_adx_dmi_minus_di_dominates_in_a_steady_downtrend():
    candles = _monotonic_trend_candles(60, step=-1.0)
    atr = compute_atr(candles, period=14)
    adx, plus_di, minus_di = compute_adx_dmi(candles, period=14, atr_series=atr)

    assert adx[-1] is not None
    assert minus_di[-1] > plus_di[-1]
    assert adx[-1] > DEFAULT_REGIME_PARAMS.adx_trend_threshold


def test_adx_dmi_none_before_enough_bars():
    candles = _monotonic_trend_candles(10, step=1.0)
    atr = compute_atr(candles, period=14)
    adx, plus_di, minus_di = compute_adx_dmi(candles, period=14, atr_series=atr)
    assert adx[-1] is None


# --- classify_regime: end-to-end on synthetic fixtures ----------------------------------------


def _staircase_candles(n_cycles: int, up_bars: int, up_step: float, down_bars: int, down_step: float) -> list[CandleClose]:
    """Repeating multi-bar up-leg then multi-bar down-leg (not a single
    pullback bar) - each leg is longer than the pivot lookback (3) so the
    top/bottom of each leg is a genuine local extreme on both sides, while
    the net drift per cycle (up_bars*up_step - down_bars*down_step) still
    trends. A single-bar pullback riding on a steep climb never registers
    as a real local low against bars further back in the same climb -
    this is why a proper multi-bar leg is needed, not just a bigger step."""
    candles = []
    price = 100.0
    i = 0
    for _ in range(n_cycles):
        for _ in range(up_bars):
            price += up_step
            candles.append(CandleClose(timestamp=f"t{i}", close=price, high=price + 0.3, low=price - 0.3))
            i += 1
        for _ in range(down_bars):
            price -= down_step
            candles.append(CandleClose(timestamp=f"t{i}", close=price, high=price + 0.3, low=price - 0.3))
            i += 1
    return candles


def test_classify_regime_uptrend():
    # A small pullback relative to the up-leg keeps Efficiency Ratio high
    # (net movement dominates total movement) while the pullback leg is
    # still long enough (4 bars > lookback=3) to register a real pivot.
    candles = _staircase_candles(n_cycles=15, up_bars=4, up_step=2.0, down_bars=4, down_step=0.3)
    result = classify_regime(candles)
    assert result.regime == "uptrend"
    assert result.structure == "HH_HL"
    assert result.confidence == 100


def test_classify_regime_downtrend():
    candles = _staircase_candles(n_cycles=15, up_bars=4, up_step=-2.0, down_bars=4, down_step=-0.3)
    result = classify_regime(candles)
    assert result.regime == "downtrend"
    assert result.structure == "LH_LL"
    assert result.confidence == 100


def test_classify_regime_range_for_a_bounded_oscillation():
    cycle = [100, 102, 100, 98]
    closes = (cycle * 25)[:100]
    candles = _ranged([(c, c + 0.3, c - 0.3) for c in closes])
    result = classify_regime(candles)
    assert result.regime == "range"


def test_classify_regime_transition_with_too_few_bars():
    candles = _flat([100, 101, 102, 103, 104])
    result = classify_regime(candles)
    assert result.regime == "transition"
    assert result.confidence == 0


# --- regime_warmup / direction_confirmed -------------------------------------------------------


def test_regime_warmup_is_a_positive_int():
    assert regime_warmup(DEFAULT_REGIME_PARAMS) > 0
    assert isinstance(regime_warmup(DEFAULT_REGIME_PARAMS), int)


def _result(structure: str, er: float, adx: float, plus_di: float, minus_di: float, slope: float) -> RegimeResult:
    return RegimeResult("n/a", 0, structure, er, adx, plus_di, minus_di, slope)


# Every one of the 5 sub-conditions passes for "bullish" (and fails for "bearish").
_ALL_BULLISH = _result("HH_HL", er=0.5, adx=30.0, plus_di=20.0, minus_di=10.0, slope=1.0)
_ALL_BEARISH = _result("LH_LL", er=0.5, adx=30.0, plus_di=10.0, minus_di=20.0, slope=-1.0)
_RANGE_LIKE = _result("MIXED", er=0.1, adx=5.0, plus_di=15.0, minus_di=15.0, slope=0.0)


def test_direction_confirmed_with_all_checks_matches_classify_regime_semantics():
    assert direction_confirmed("bullish", _ALL_BULLISH) is True
    assert direction_confirmed("bearish", _ALL_BEARISH) is True
    assert direction_confirmed("bullish", _ALL_BEARISH) is False
    assert direction_confirmed("bearish", _ALL_BULLISH) is False
    assert direction_confirmed("bullish", _RANGE_LIKE) is False
    assert direction_confirmed("bearish", _RANGE_LIKE) is False


def test_direction_confirmed_never_confirms_when_structure_is_insufficient():
    insufficient = _result("insufficient", er=0.5, adx=30.0, plus_di=20.0, minus_di=10.0, slope=1.0)
    assert direction_confirmed("bullish", insufficient) is False
    assert direction_confirmed("bullish", insufficient, enabled_checks=frozenset()) is False  # even with nothing required


def test_direction_confirmed_never_confirms_with_missing_data():
    missing_adx = _result("HH_HL", er=0.5, adx=None, plus_di=20.0, minus_di=10.0, slope=1.0)
    assert direction_confirmed("bullish", missing_adx) is False


def test_direction_confirmed_selective_checks_allow_a_partial_match():
    # structure/ER/DMI/slope all say bullish, but ADX (10) is below the
    # trend threshold (20) - the ADX check alone fails.
    mostly_bullish = _result("HH_HL", er=0.5, adx=10.0, plus_di=20.0, minus_di=10.0, slope=1.0)

    assert direction_confirmed("bullish", mostly_bullish, enabled_checks=ALL_REGIME_CHECKS) is False
    assert direction_confirmed("bullish", mostly_bullish, enabled_checks=frozenset({"adx"})) is False
    assert (
        direction_confirmed(
            "bullish", mostly_bullish, enabled_checks=frozenset({"structure", "efficiency_ratio", "dmi_direction", "ema_slope"})
        )
        is True
    )
    assert direction_confirmed("bullish", mostly_bullish, enabled_checks=frozenset({"structure"})) is True


def test_direction_confirmed_empty_checks_confirms_trivially_once_data_is_sufficient():
    # A real but degenerate configuration - the filter is "on" but
    # requires nothing, so it always confirms once past the insufficient-
    # data guard.
    assert direction_confirmed("bullish", _RANGE_LIKE, enabled_checks=frozenset()) is True


# --- check_structure/check_efficiency_ratio/check_adx/check_dmi_direction/check_ema_slope -----
# The 5 regime checks decomposed into independent, Optional[bool]-returning
# functions (see app/domain/rule.py's 5 new IndicatorTypes) - each reuses
# the exact same math as _direction_checks/classify_regime above, just
# computed independently per check instead of bundled into one
# RegimeParams pass. Reuses this file's own fixtures throughout.


def test_check_structure_confirms_bullish_and_denies_bearish():
    candles = _staircase_candles(n_cycles=15, up_bars=4, up_step=2.0, down_bars=4, down_step=0.3)
    assert check_structure(candles, "bullish", swing_lookback=3) is True
    assert check_structure(candles, "bearish", swing_lookback=3) is False


def test_check_structure_confirms_bearish_and_denies_bullish():
    candles = _staircase_candles(n_cycles=15, up_bars=4, up_step=-2.0, down_bars=4, down_step=-0.3)
    assert check_structure(candles, "bearish", swing_lookback=3) is True
    assert check_structure(candles, "bullish", swing_lookback=3) is False


def test_check_structure_none_with_too_few_pivots():
    candles = _flat([10, 12, 15, 12, 10])
    assert check_structure(candles, "bullish", swing_lookback=2) is None
    assert check_structure(candles, "bearish", swing_lookback=2) is None


def test_check_efficiency_ratio_above_threshold_confirms_either_bias():
    # Bias-independent - ER only measures how efficiently price moved, not
    # which direction, so both biases pass together above threshold.
    closes = [100, 102, 104, 106, 108]
    candles = _flat(closes)
    assert check_efficiency_ratio(candles, "bullish", period=4, trend_threshold=0.5) is True
    assert check_efficiency_ratio(candles, "bearish", period=4, trend_threshold=0.5) is True


def test_check_efficiency_ratio_below_threshold_denies_either_bias():
    closes = [100, 103, 99, 102, 98, 101]
    candles = _flat(closes)
    assert check_efficiency_ratio(candles, "bullish", period=5, trend_threshold=0.25) is False
    assert check_efficiency_ratio(candles, "bearish", period=5, trend_threshold=0.25) is False


def test_check_efficiency_ratio_none_before_enough_bars():
    candles = _flat([100, 101])
    assert check_efficiency_ratio(candles, "bullish", period=5, trend_threshold=0.35) is None


def test_check_adx_above_threshold_confirms_either_bias():
    # Bias-independent - ADX measures trend strength, not direction.
    candles = _monotonic_trend_candles(60, step=1.0)
    assert check_adx(candles, "bullish", period=14, trend_threshold=20.0) is True
    assert check_adx(candles, "bearish", period=14, trend_threshold=20.0) is True


def test_check_adx_below_threshold_denies_either_bias():
    candles = _monotonic_trend_candles(60, step=1.0)
    assert check_adx(candles, "bullish", period=14, trend_threshold=1000.0) is False
    assert check_adx(candles, "bearish", period=14, trend_threshold=1000.0) is False


def test_check_adx_none_before_enough_bars():
    candles = _monotonic_trend_candles(10, step=1.0)
    assert check_adx(candles, "bullish", period=14, trend_threshold=20.0) is None


def test_check_dmi_direction_confirms_bullish_in_an_uptrend():
    candles = _monotonic_trend_candles(60, step=1.0)
    assert check_dmi_direction(candles, "bullish", period=14) is True
    assert check_dmi_direction(candles, "bearish", period=14) is False


def test_check_dmi_direction_confirms_bearish_in_a_downtrend():
    candles = _monotonic_trend_candles(60, step=-1.0)
    assert check_dmi_direction(candles, "bearish", period=14) is True
    assert check_dmi_direction(candles, "bullish", period=14) is False


def test_check_dmi_direction_none_before_enough_bars():
    candles = _monotonic_trend_candles(10, step=1.0)
    assert check_dmi_direction(candles, "bullish", period=14) is None


def test_check_ema_slope_confirms_bullish_for_a_rising_series():
    candles = _ranged([(50 + i * 0.5, 50 + i * 0.5 + 0.5, 50 + i * 0.5 - 0.5) for i in range(40)])
    assert check_ema_slope(candles, "bullish", ema_period=20, slope_lookback=5, slope_threshold=0.15, atr_period=14) is True
    assert check_ema_slope(candles, "bearish", ema_period=20, slope_lookback=5, slope_threshold=0.15, atr_period=14) is False


def test_check_ema_slope_confirms_bearish_for_a_falling_series():
    candles = _ranged([(50 - i * 0.5, 50 - i * 0.5 + 0.5, 50 - i * 0.5 - 0.5) for i in range(40)])
    assert check_ema_slope(candles, "bearish", ema_period=20, slope_lookback=5, slope_threshold=0.15, atr_period=14) is True
    assert check_ema_slope(candles, "bullish", ema_period=20, slope_lookback=5, slope_threshold=0.15, atr_period=14) is False


def test_check_ema_slope_denies_a_flat_series():
    candles = _ranged([(50.0, 50.5, 49.5) for _ in range(30)])
    assert check_ema_slope(candles, "bullish", ema_period=20, slope_lookback=5, slope_threshold=0.15, atr_period=14) is False
    assert check_ema_slope(candles, "bearish", ema_period=20, slope_lookback=5, slope_threshold=0.15, atr_period=14) is False


def test_check_ema_slope_none_before_enough_bars():
    candles = _ranged([(1.0, 1.1, 0.9), (2.0, 2.1, 1.9)])
    assert check_ema_slope(candles, "bullish", ema_period=20, slope_lookback=5, slope_threshold=0.15, atr_period=14) is None


def test_check_supertrend_confirms_bullish_in_a_steady_uptrend():
    candles = _ranged([(50 + i, 50 + i + 1, 50 + i - 1) for i in range(20)])
    assert check_supertrend(candles, "bullish", period=5, multiplier=1.0) is True
    assert check_supertrend(candles, "bearish", period=5, multiplier=1.0) is False


def test_check_supertrend_confirms_bearish_in_a_steady_downtrend():
    candles = _ranged([(100 - i, 100 - i + 1, 100 - i - 1) for i in range(20)])
    assert check_supertrend(candles, "bearish", period=5, multiplier=1.0) is True
    assert check_supertrend(candles, "bullish", period=5, multiplier=1.0) is False


def test_check_supertrend_none_before_enough_bars():
    candles = _ranged([(50 + i, 50 + i + 1, 50 + i - 1) for i in range(4)])
    assert check_supertrend(candles, "bullish", period=5, multiplier=1.0) is None
