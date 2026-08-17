"""Market regime classification - UPTREND/DOWNTREND/RANGE/TRANSITION from a
single candle series, combining confirmed swing structure (HH/HL vs LH/LL),
Efficiency Ratio, ADX/DMI, and ATR-normalized EMA slope. Source: a shared
trading-analysis document recommending exactly this combination (market
structure as the primary signal, the rest as supporting evidence) rather
than any one indicator alone.

Deliberately NOT wired through Indicator/RuleConfig (app/domain/models.py) -
those are built around a scalar series + its own signal line (RSI + SMA-of-
RSI) consumed by one rule ("value crosses signal"). A regime classifier is a
categorical, multi-input composite, not a scalar series - forcing it into
that shape would break compute_indicator's list[Optional[float]] contract
for no reuse benefit. Instead this is a self-contained gate: engine.py and
backtest.py call classify_regime()/direction_confirmed() *after*
rules.evaluate() finds a crossover signal, to decide whether to act on it -
regime is supporting evidence, the crossover stays the actual trigger.

classify_regime()'s own "regime" label always combines all 5 sub-conditions
(structure, Efficiency Ratio, ADX, DMI direction, EMA slope) - it's a fixed,
general-purpose classification. direction_confirmed() is the actual gate a
Strategy uses, and can require only a SUBSET of those 5
(`Strategy.regime_filter_checks`) rather than all of them - see
REGIME_CHECK_NAMES.

DEFAULT_REGIME_PARAMS below are the source document's own suggested
starting thresholds, not yet backtested/tuned for this platform's actual
instruments - same caveat the document itself makes ("the exact threshold
should come from backtesting"). Single-timeframe only, by deliberate
choice: classify_regime always runs on the same candle series/interval the
caller already has (typically Strategy.interval) - no higher-timeframe
fetch. A multi-timeframe version (15m regime / execution-timeframe trigger,
per the source document) is a documented future option, not built here."""

from dataclasses import dataclass
from typing import Optional

from app.domain.rules import Bias, CandleClose

Regime = str  # "uptrend" | "downtrend" | "range" | "transition"


@dataclass(frozen=True)
class RegimeParams:
    swing_lookback: int = 3  # bars each side required to confirm a pivot
    er_period: int = 14
    adx_period: int = 14
    ema_period: int = 20
    ema_slope_lookback: int = 5
    er_trend_threshold: float = 0.35
    er_range_threshold: float = 0.25
    adx_trend_threshold: float = 20.0
    ema_slope_threshold: float = 0.15


DEFAULT_REGIME_PARAMS = RegimeParams()


@dataclass
class RegimeResult:
    regime: Regime
    confidence: int  # 0-100 - how many of the 5 sub-conditions agreed, not a fitted score
    structure: str  # "HH_HL" | "LH_LL" | "MIXED" | "insufficient"
    efficiency_ratio: Optional[float]
    adx: Optional[float]
    plus_di: Optional[float]
    minus_di: Optional[float]
    ema_slope: Optional[float]


# The 5 sub-conditions classify_regime combines. A Strategy can require
# only a subset of these to confirm a signal's direction (see
# direction_confirmed) rather than all 5 - classify_regime's own "regime"
# label always uses all 5 (it's a fixed, general-purpose classification
# used for display/reporting), independent of what any one strategy's
# filter is configured to require.
REGIME_CHECK_NAMES = ("structure", "efficiency_ratio", "adx", "dmi_direction", "ema_slope")
ALL_REGIME_CHECKS: frozenset[str] = frozenset(REGIME_CHECK_NAMES)


def find_pivots(candles: list[CandleClose], lookback: int) -> tuple[list[int], list[int]]:
    """Confirmed swing highs/lows: index i is a pivot high if high[i] is
    strictly greater than every high in [i-lookback, i+lookback] excluding
    i itself (the low equivalent for pivot lows). A pivot at i is only
    knowable once index i+lookback exists - avoids repainting, per the
    source document. Returns (pivot_high_indices, pivot_low_indices),
    oldest-first."""
    n = len(candles)
    pivot_highs: list[int] = []
    pivot_lows: list[int] = []
    for i in range(lookback, n - lookback):
        window_highs = [candles[j].high for j in range(i - lookback, i + lookback + 1) if j != i]
        if candles[i].high > max(window_highs):
            pivot_highs.append(i)
        window_lows = [candles[j].low for j in range(i - lookback, i + lookback + 1) if j != i]
        if candles[i].low < min(window_lows):
            pivot_lows.append(i)
    return pivot_highs, pivot_lows


def classify_structure(candles: list[CandleClose], pivot_highs: list[int], pivot_lows: list[int]) -> str:
    """HH_HL (bullish) needs BOTH the latest pivot high and low strictly
    above their predecessors; LH_LL (bearish) needs both strictly below.
    Anything else - a contradictory mix (higher high but lower low), or
    an equal/overlapping swing on either side, per the source document's
    "overlapping/equal swings -> range" - is MIXED. "insufficient" if
    fewer than two pivots of either type have been confirmed yet."""
    if len(pivot_highs) < 2 or len(pivot_lows) < 2:
        return "insufficient"
    last_high, prev_high = candles[pivot_highs[-1]].high, candles[pivot_highs[-2]].high
    last_low, prev_low = candles[pivot_lows[-1]].low, candles[pivot_lows[-2]].low
    if last_high > prev_high and last_low > prev_low:
        return "HH_HL"
    if last_high < prev_high and last_low < prev_low:
        return "LH_LL"
    return "MIXED"


def compute_efficiency_ratio(closes: list[float], period: int) -> Optional[float]:
    """Kaufman's Efficiency Ratio: net movement over `period` bars divided
    by the total movement traveled to get there - close to 1 means price
    moved efficiently in one direction, close to 0 means lots of back-and-
    forth with little net progress. None before `period` bars exist."""
    if len(closes) <= period:
        return None
    net = abs(closes[-1] - closes[-1 - period])
    total = sum(abs(closes[i] - closes[i - 1]) for i in range(len(closes) - period, len(closes)))
    if total == 0:
        return 0.0
    return net / total


def compute_atr(candles: list[CandleClose], period: int) -> list[Optional[float]]:
    """Wilder-smoothed true range (ATR) - same smoothing recurrence
    compute_rsi already uses for avg gain/loss (simple average to seed,
    then (prev*(period-1)+new)/period). Shared by compute_adx_dmi (its
    denominator) and compute_ema_slope (its normalizer)."""
    n = len(candles)
    atr: list[Optional[float]] = [None] * n
    if n <= period:
        return atr

    true_ranges = [
        max(
            candles[i].high - candles[i].low,
            abs(candles[i].high - candles[i - 1].close),
            abs(candles[i].low - candles[i - 1].close),
        )
        for i in range(1, n)
    ]  # true_ranges[k] corresponds to candles[k+1]

    avg_tr = sum(true_ranges[:period]) / period
    atr[period] = avg_tr
    for i in range(period, len(true_ranges)):
        avg_tr = (avg_tr * (period - 1) + true_ranges[i]) / period
        atr[i + 1] = avg_tr
    return atr


def compute_adx_dmi(
    candles: list[CandleClose], period: int, atr_series: list[Optional[float]]
) -> tuple[list[Optional[float]], list[Optional[float]], list[Optional[float]]]:
    """Wilder's ADX/+DI/-DI. +DM/-DM and DX are Wilder-smoothed the same
    way ATR is (see compute_atr); +DI/-DI are +DM/-DM smoothed then scaled
    by the already-computed ATR (not recomputed here). ADX is DX,
    Wilder-smoothed again over `period`. Returns (adx, plus_di, minus_di),
    same length/None-padding convention as compute_atr."""
    n = len(candles)
    adx: list[Optional[float]] = [None] * n
    plus_di: list[Optional[float]] = [None] * n
    minus_di: list[Optional[float]] = [None] * n
    if n <= period * 2:
        return adx, plus_di, minus_di

    plus_dm = [0.0] * n
    minus_dm = [0.0] * n
    for i in range(1, n):
        up_move = candles[i].high - candles[i - 1].high
        down_move = candles[i - 1].low - candles[i].low
        plus_dm[i] = up_move if (up_move > down_move and up_move > 0) else 0.0
        minus_dm[i] = down_move if (down_move > up_move and down_move > 0) else 0.0

    avg_plus_dm = sum(plus_dm[1 : period + 1]) / period
    avg_minus_dm = sum(minus_dm[1 : period + 1]) / period
    dx_series: list[Optional[float]] = [None] * n

    def _set_di(i: int, ap: float, am: float) -> None:
        atr_i = atr_series[i]
        if not atr_i:
            return
        plus_di[i] = 100 * (ap / atr_i)
        minus_di[i] = 100 * (am / atr_i)
        di_sum = plus_di[i] + minus_di[i]
        dx_series[i] = 100 * abs(plus_di[i] - minus_di[i]) / di_sum if di_sum else 0.0

    _set_di(period, avg_plus_dm, avg_minus_dm)
    for i in range(period + 1, n):
        avg_plus_dm = (avg_plus_dm * (period - 1) + plus_dm[i]) / period
        avg_minus_dm = (avg_minus_dm * (period - 1) + minus_dm[i]) / period
        _set_di(i, avg_plus_dm, avg_minus_dm)

    first_dx_idx = next((i for i in range(n) if dx_series[i] is not None), None)
    if first_dx_idx is None:
        return adx, plus_di, minus_di

    dx_window_end = first_dx_idx + period
    dx_window = [dx_series[i] for i in range(first_dx_idx, dx_window_end) if dx_series[i] is not None]
    if len(dx_window) < period or dx_window_end > n:
        return adx, plus_di, minus_di

    avg_dx = sum(dx_window) / period
    adx[dx_window_end - 1] = avg_dx
    for i in range(dx_window_end, n):
        if dx_series[i] is None:
            continue
        avg_dx = (avg_dx * (period - 1) + dx_series[i]) / period
        adx[i] = avg_dx

    return adx, plus_di, minus_di


def compute_ema(closes: list[float], period: int) -> list[Optional[float]]:
    """Standard EMA - doesn't exist elsewhere in the codebase (indicators.py
    only has SMA today)."""
    n = len(closes)
    ema: list[Optional[float]] = [None] * n
    if n < period:
        return ema
    seed = sum(closes[:period]) / period
    ema[period - 1] = seed
    k = 2 / (period + 1)
    for i in range(period, n):
        ema[i] = closes[i] * k + ema[i - 1] * (1 - k)
    return ema


def compute_supertrend(candles: list[CandleClose], period: int, multiplier: float) -> list[Optional[float]]:
    """Standard SuperTrend line (ATR-based, via compute_atr above) - used
    as app/domain/backtest.py's stop_loss_indicator_type='supertrend'
    trailing stop (see _STOP_LOSS_COMPUTE_FUNCS there). Returns one flat
    scalar series like compute_ema, not the separate
    upper-band/lower-band/trend-direction triple a charting library would
    want: the caller (_indicator_stop_price) already has its own
    direction-vs-reference-price guard (added after the EMA wrong-side-
    of-entry bug - see that function's docstring), so a SuperTrend value
    that's momentarily on the wrong side after a trend flip is rejected
    the same generic way an EMA value would be, without this function
    needing to know which side is "protective" for a given trade.

    Same None-padding convention as compute_atr/compute_ema (an index has
    a value only once ATR itself does, i.e. index >= period)."""
    n = len(candles)
    atr = compute_atr(candles, period)
    supertrend: list[Optional[float]] = [None] * n
    final_upper: list[Optional[float]] = [None] * n
    final_lower: list[Optional[float]] = [None] * n
    direction: list[Optional[int]] = [None] * n  # 1 = up (line trails below price), -1 = down (trails above)

    for i in range(n):
        if atr[i] is None:
            continue
        mid = (candles[i].high + candles[i].low) / 2
        basic_upper = mid + multiplier * atr[i]
        basic_lower = mid - multiplier * atr[i]

        prev = i - 1
        if prev < 0 or final_upper[prev] is None:
            final_upper[i] = basic_upper
            final_lower[i] = basic_lower
            direction[i] = -1 if candles[i].close <= basic_upper else 1
            supertrend[i] = final_upper[i] if direction[i] == -1 else final_lower[i]
            continue

        final_upper[i] = (
            basic_upper if (basic_upper < final_upper[prev] or candles[prev].close > final_upper[prev]) else final_upper[prev]
        )
        final_lower[i] = (
            basic_lower if (basic_lower > final_lower[prev] or candles[prev].close < final_lower[prev]) else final_lower[prev]
        )

        if direction[prev] == 1:
            if candles[i].close < final_lower[i]:
                direction[i] = -1
                supertrend[i] = final_upper[i]
            else:
                direction[i] = 1
                supertrend[i] = final_lower[i]
        else:
            if candles[i].close > final_upper[i]:
                direction[i] = 1
                supertrend[i] = final_lower[i]
            else:
                direction[i] = -1
                supertrend[i] = final_upper[i]

    return supertrend


def compute_ema_slope(
    closes: list[float], atr_series: list[Optional[float]], ema_period: int, lookback: int
) -> Optional[float]:
    """(EMA[t] - EMA[t-lookback]) / ATR[t] - ATR-normalized so the slope is
    comparable across instruments/price levels, per the source document."""
    ema = compute_ema(closes, ema_period)
    if len(ema) <= lookback or ema[-1] is None or ema[-1 - lookback] is None:
        return None
    atr = atr_series[-1] if atr_series else None
    if not atr:
        return None
    return (ema[-1] - ema[-1 - lookback]) / atr


def _direction_checks(
    bias: Bias,
    structure: str,
    er: float,
    adx: float,
    plus_di: float,
    minus_di: float,
    slope: float,
    params: RegimeParams,
) -> dict[str, bool]:
    """The 5 sub-conditions' pass/fail for `bias`, keyed by
    REGIME_CHECK_NAMES - the one place the actual per-check thresholds
    live, shared by classify_regime (which always combines all 5, for its
    general-purpose "regime" label) and direction_confirmed (which
    combines only whichever subset a Strategy requires)."""
    wanted_structure = "HH_HL" if bias == "bullish" else "LH_LL"
    dmi_ok = plus_di > minus_di if bias == "bullish" else minus_di > plus_di
    slope_ok = slope > params.ema_slope_threshold if bias == "bullish" else slope < -params.ema_slope_threshold
    return {
        "structure": structure == wanted_structure,
        "efficiency_ratio": er > params.er_trend_threshold,
        "adx": adx > params.adx_trend_threshold,
        "dmi_direction": dmi_ok,
        "ema_slope": slope_ok,
    }


def classify_regime(candles: list[CandleClose], params: RegimeParams = DEFAULT_REGIME_PARAMS) -> RegimeResult:
    """Combines structure/ER/ADX-DMI/EMA-slope via the source document's own
    AND-conditions (not a majority vote): a trend call requires ALL 5
    sub-conditions to agree, a range call requires its own 4 conditions to
    agree, and anything else - including not-yet-enough-data - is
    "transition," the document's explicit fourth state ("don't force every
    candle into trend or range"). This is a fixed, general-purpose
    classification (always all 5) - see direction_confirmed for a
    strategy-selectable subset."""
    closes = [c.close for c in candles]
    pivot_highs, pivot_lows = find_pivots(candles, params.swing_lookback)
    structure = classify_structure(candles, pivot_highs, pivot_lows)

    er = compute_efficiency_ratio(closes, params.er_period)
    atr_series = compute_atr(candles, params.adx_period)
    adx_series, plus_di_series, minus_di_series = compute_adx_dmi(candles, params.adx_period, atr_series)
    adx = adx_series[-1] if adx_series else None
    plus_di = plus_di_series[-1] if plus_di_series else None
    minus_di = minus_di_series[-1] if minus_di_series else None
    slope = compute_ema_slope(closes, atr_series, params.ema_period, params.ema_slope_lookback)

    if structure == "insufficient" or None in (er, adx, plus_di, minus_di, slope):
        return RegimeResult("transition", 0, structure, er, adx, plus_di, minus_di, slope)

    bullish = _direction_checks("bullish", structure, er, adx, plus_di, minus_di, slope, params)
    bearish = _direction_checks("bearish", structure, er, adx, plus_di, minus_di, slope, params)
    is_range = (
        er < params.er_range_threshold
        and adx < params.adx_trend_threshold
        and abs(slope) < params.ema_slope_threshold
        and structure == "MIXED"
    )

    if all(bullish.values()):
        return RegimeResult("uptrend", 100, structure, er, adx, plus_di, minus_di, slope)
    if all(bearish.values()):
        return RegimeResult("downtrend", 100, structure, er, adx, plus_di, minus_di, slope)
    if is_range:
        return RegimeResult("range", 100, structure, er, adx, plus_di, minus_di, slope)

    confidence = round(max(sum(bullish.values()), sum(bearish.values())) / len(REGIME_CHECK_NAMES) * 100)
    return RegimeResult("transition", confidence, structure, er, adx, plus_di, minus_di, slope)


def regime_warmup(params: RegimeParams = DEFAULT_REGIME_PARAMS) -> int:
    """A coarse over-estimate of bars needed before classify_regime can
    produce anything but "transition" from lack of data - same "extra
    empty bars cost nothing" philosophy engine.history_window already
    documents, not a tight bound."""
    swing_settle = params.swing_lookback * 8  # ~2 confirmed pivots of each type
    er_settle = params.er_period + 1
    adx_settle = params.adx_period * 3  # DM smoothing + DX-into-ADX smoothing both need to settle
    ema_settle = params.ema_period + params.ema_slope_lookback
    return max(swing_settle, er_settle, adx_settle, ema_settle)


def check_structure(candles: list[CandleClose], bias: Bias, swing_lookback: int = 3) -> Optional[bool]:
    """Decomposed from _direction_checks' "structure" check - confirmed
    swing structure (see find_pivots/classify_structure) agrees with
    `bias` (HH_HL for bullish, LH_LL for bearish). None until at least two
    pivots of each type have confirmed - "insufficient data," not "no"."""
    pivot_highs, pivot_lows = find_pivots(candles, swing_lookback)
    structure = classify_structure(candles, pivot_highs, pivot_lows)
    if structure == "insufficient":
        return None
    wanted = "HH_HL" if bias == "bullish" else "LH_LL"
    return structure == wanted


def check_efficiency_ratio(
    candles: list[CandleClose], bias: Bias, period: int = 14, trend_threshold: float = 0.35
) -> Optional[bool]:
    """Decomposed from _direction_checks' "efficiency_ratio" check -
    Kaufman's ER above `trend_threshold` means price is moving efficiently
    (trending), regardless of `bias` - direction comes from the other
    checks, this one only measures how "clean" the move is. None before
    `period` bars exist."""
    closes = [c.close for c in candles]
    er = compute_efficiency_ratio(closes, period)
    if er is None:
        return None
    return er > trend_threshold


def check_adx(candles: list[CandleClose], bias: Bias, period: int = 14, trend_threshold: float = 20.0) -> Optional[bool]:
    """Decomposed from _direction_checks' "adx" check - ADX above
    `trend_threshold` means the trend (whichever way) has strength,
    regardless of `bias` - same "direction is a different check" split as
    check_efficiency_ratio. None until Wilder's DX has had `period` bars
    to smooth into an ADX value (see compute_adx_dmi)."""
    atr_series = compute_atr(candles, period)
    adx_series, _, _ = compute_adx_dmi(candles, period, atr_series)
    adx = adx_series[-1] if adx_series else None
    if adx is None:
        return None
    return adx > trend_threshold


def check_dmi_direction(candles: list[CandleClose], bias: Bias, period: int = 14) -> Optional[bool]:
    """Decomposed from _direction_checks' "dmi_direction" check - +DI vs
    -DI agrees with `bias`. None until compute_adx_dmi has enough bars to
    produce a DI pair."""
    atr_series = compute_atr(candles, period)
    _, plus_di_series, minus_di_series = compute_adx_dmi(candles, period, atr_series)
    plus_di = plus_di_series[-1] if plus_di_series else None
    minus_di = minus_di_series[-1] if minus_di_series else None
    if plus_di is None or minus_di is None:
        return None
    return plus_di > minus_di if bias == "bullish" else minus_di > plus_di


def check_ema_slope(
    candles: list[CandleClose],
    bias: Bias,
    ema_period: int = 20,
    slope_lookback: int = 5,
    slope_threshold: float = 0.15,
    atr_period: int = 14,
) -> Optional[bool]:
    """Decomposed from _direction_checks' "ema_slope" check - ATR-normalized
    EMA slope agrees with `bias` (positive-and-above-threshold for
    bullish, negative-and-below for bearish). `atr_period` is independent
    of `ema_period` - it only sizes the ATR used to normalize the slope
    (matching classify_regime's own RegimeParams.adx_period reuse for the
    same purpose), not the EMA itself. None until both the EMA and its own
    ATR have enough bars."""
    closes = [c.close for c in candles]
    atr_series = compute_atr(candles, atr_period)
    slope = compute_ema_slope(closes, atr_series, ema_period, slope_lookback)
    if slope is None:
        return None
    return slope > slope_threshold if bias == "bullish" else slope < -slope_threshold


def check_supertrend(
    candles: list[CandleClose], bias: Bias, period: int = 10, multiplier: float = 3.0
) -> Optional[bool]:
    """6th regime check (added alongside structure/efficiency_ratio/adx/
    dmi_direction/ema_slope, not part of classify_regime's fixed 5 -
    reuses compute_supertrend, the same trend line
    stop_loss_indicator_type='supertrend' trails against). Confirmed
    bullish when the latest close is above the SuperTrend line (line
    trailing below price = uptrend), bearish when below - mirrors
    compute_supertrend's own direction convention. None until ATR (and so
    the line itself) has `period` bars to settle."""
    line = compute_supertrend(candles, period, multiplier)
    value = line[-1] if line else None
    if value is None:
        return None
    close = candles[-1].close
    return close > value if bias == "bullish" else close < value


def direction_confirmed(
    bias: Bias,
    result: RegimeResult,
    params: RegimeParams = DEFAULT_REGIME_PARAMS,
    enabled_checks: frozenset[str] = ALL_REGIME_CHECKS,
) -> bool:
    """Whether `bias` is confirmed by `result`, requiring only the
    sub-conditions named in `enabled_checks` (a subset of
    REGIME_CHECK_NAMES) to agree - NOT classify_regime's own "regime"
    label, which always requires all 5. This is what lets a Strategy
    require e.g. just structure+ADX rather than the full combination.
    `enabled_checks` defaults to all 5, reproducing "confirmed only when
    classify_regime's own label agrees" exactly. An empty `enabled_checks`
    trivially confirms everything (all([]) is True) - a real but
    degenerate configuration (the filter is enabled but requires
    nothing), not specially guarded against here.

    Never confirms while the underlying data is still insufficient
    (`result.structure == "insufficient"` or any raw value is still
    `None`), regardless of which checks are enabled - matches
    classify_regime's own "transition" fallback for the same case. Both
    engine.py and backtest.py call this (and classify_regime) so live
    behavior and a backtest can never disagree about what the regime
    filter allows, same principle rules.evaluate already established for
    the crossover rule itself."""
    if result.structure == "insufficient":
        return False
    if None in (result.efficiency_ratio, result.adx, result.plus_di, result.minus_di, result.ema_slope):
        return False
    checks = _direction_checks(
        bias, result.structure, result.efficiency_ratio, result.adx, result.plus_di, result.minus_di, result.ema_slope, params
    )
    return all(checks[name] for name in enabled_checks)
