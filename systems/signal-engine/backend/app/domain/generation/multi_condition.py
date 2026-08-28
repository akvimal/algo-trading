"""Evaluator for MultiConditionRuleConfig (app/domain/rule.py) - a 4th,
structurally independent rule type: an arbitrary AND-combined list of
Conditions, each a comparison between two Terms, each with its OWN
interval (conditions can mix daily + 15min etc., unlike every other rule
type where the Rule's own `interval` is the one timeframe evaluated).
Built for recreating Chartink-style multi-filter scans - see
docs/architecture.md's "Rules module" section for the full design,
including why this reuses the generic backtest.replay/simulate_trades
exit engine (via a BiasFn closure) rather than forking a third bespoke
engine the way BreakoutRuleConfig's own breakout.py does.

`bisect_right` and this module's own `_INTERVAL_TIMEDELTA` do the
multi-interval alignment work backtest replay needs (mapping a fine-interval
bar to the last coarser-interval bar that had FULLY completed as of that
fine bar's own timestamp - never today's own not-yet-complete daily bar,
same no-lookahead rule Chartink's own "1 day ago X" semantics implies).
Live evaluation needs none of this - see evaluate_multi_condition_live."""

import bisect
from datetime import datetime, timedelta
from typing import Callable, Optional

from app.domain.generation.breakout import compute_donchian_high, compute_donchian_low
from app.domain.generation.indicators import compute_cci, compute_rsi, compute_sma
from app.domain.generation.regime import compute_ema
from app.domain.generation.rule import Condition, MultiConditionRuleConfig, Term, INTERVAL_SORT_MINUTES
from app.domain.generation.rules import Bias, CandleClose

_INTERVAL_TIMEDELTA = {
    "1min": timedelta(minutes=1),
    "3min": timedelta(minutes=3),
    "5min": timedelta(minutes=5),
    "15min": timedelta(minutes=15),
    "30min": timedelta(minutes=30),
    "60min": timedelta(minutes=60),
    "daily": timedelta(days=1),
}


def _field_series(field: str, candles: list[CandleClose]) -> list[float]:
    return [getattr(c, field) for c in candles]


def _apply_offset(series: list[Optional[float]], offset_bars: int) -> list[Optional[float]]:
    """result[i] = series[i - offset_bars], None for i < offset_bars -
    "N bars/days ago X". A no-op for offset_bars=0 (the common case)."""
    if offset_bars == 0:
        return series
    n = len(series)
    return [None] * min(offset_bars, n) + series[: max(0, n - offset_bars)]


def compute_term_series(term: Term, candles: list[CandleClose]) -> list[Optional[float]]:
    """One value per candle (oldest-first, same length as `candles`) -
    dispatches on term.kind. `highest`/`lowest` reuse breakout.py's
    compute_donchian_high/low as-is - both already exclude the CURRENT bar
    (rolling max/min of the PRIOR `period` bars), which is exactly "N days
    ago Max/Min" with offset_bars=0 already baked in (Chartink's own
    inclusive-of-today Max(N,...) shifted back 1 day covers the identical
    N prior days a Donchian window does) - offset_bars on a highest/lowest
    term is for shifting further back still, not required for the common
    "yesterday's N-day high" case. offset_bars/scale apply uniformly last,
    for every kind."""
    if term.kind == "constant":
        series: list[Optional[float]] = [term.value] * len(candles)
    elif term.kind == "price":
        series = list(_field_series(term.field, candles))
    elif term.kind == "volume":
        series = [c.volume for c in candles]
    elif term.kind == "candle_body":
        series = [abs(c.close - c.open) for c in candles]
    elif term.kind == "candle_range":
        series = [c.high - c.low for c in candles]
    elif term.kind == "sma":
        series = compute_sma(_field_series(term.field, candles), term.period)
    elif term.kind == "ema":
        series = compute_ema(_field_series(term.field, candles), term.period)
    elif term.kind == "highest":
        series = compute_donchian_high(_field_series(term.field, candles), term.period)
    elif term.kind == "lowest":
        series = compute_donchian_low(_field_series(term.field, candles), term.period)
    elif term.kind == "rsi":
        series = compute_rsi([c.close for c in candles], term.period)
    elif term.kind == "cci":
        series = compute_cci(candles, term.period)
    else:
        raise ValueError(f"no compute rule for term kind {term.kind!r}")

    series = _apply_offset(series, term.offset_bars)
    if term.scale != 1.0:
        series = [None if v is None else v * term.scale for v in series]
    return series


def _compare(left: float, right: float, operator: str) -> bool:
    if operator == ">":
        return left > right
    if operator == "<":
        return left < right
    if operator == ">=":
        return left >= right
    if operator == "<=":
        return left <= right
    raise ValueError(f"unknown operator {operator!r}")


def evaluate_condition(condition: Condition, candles_by_interval: dict[str, list[CandleClose]]) -> Optional[bool]:
    """True/False, or None if this condition's own interval has no data
    yet, or either side is still warming up (not enough history for its
    period/offset) - a None anywhere means the WHOLE rule can't fire this
    bar (see evaluate_multi_condition), same "insufficient data means no
    signal, not a crash" precedent every other rule type already follows."""
    candles = candles_by_interval.get(condition.interval)
    if not candles:
        return None
    left_series = compute_term_series(condition.left, candles)
    right_series = compute_term_series(condition.right, candles)
    left_value, right_value = left_series[-1], right_series[-1]
    if left_value is None or right_value is None:
        return None
    return _compare(left_value, right_value, condition.operator)


def evaluate_multi_condition(rule: MultiConditionRuleConfig, candles_by_interval: dict[str, list[CandleClose]]) -> Optional[Bias]:
    """rule.direction if EVERY condition evaluates True against the LATEST
    candle of its own interval, else None. Mirrors rules.evaluate's role
    for CrossoverRuleConfig. `candles_by_interval` values are each
    expected to already end at "now" (or, for backtest per-bar use, at
    whatever moment is being evaluated) - see evaluate_multi_condition_live
    for the live-tick caller and build_multi_condition_bias_fn for the
    backtest-replay caller, which precomputes rather than calling this
    function fresh per bar (see that function's own docstring for why)."""
    for condition in rule.conditions:
        result = evaluate_condition(condition, candles_by_interval)
        if not result:  # None (insufficient data) or False both stop the rule
            return None
    return rule.direction


def evaluate_multi_condition_live(
    rule: MultiConditionRuleConfig, candles_by_interval: dict[str, list[CandleClose]]
) -> Optional[tuple[Bias, str]]:
    """Live-tick entry point (app/domain/engine.py's _run_one_multi_condition)
    - mirrors evaluate_breakout_live/evaluate_range_breakout_live's
    Optional[tuple[Bias, str]] shape (the str is the dedupe timestamp).
    No alignment needed here (unlike backtest replay): each interval's
    candles are independently fetched "up to now", and a daily fetch
    naturally excludes today's own still-forming bar, exactly matching
    Chartink's own "yesterday's completed daily bar" semantics for free.
    Dedupe timestamp is the FINEST interval's own latest candle (the
    interval Rule.interval is required to equal - see
    validate_multi_condition_interval_consistency)."""
    finest_interval = min(candles_by_interval, key=lambda iv: INTERVAL_SORT_MINUTES[iv])
    fine_candles = candles_by_interval[finest_interval]
    if not fine_candles:
        return None
    bias = evaluate_multi_condition(rule, candles_by_interval)
    if bias is None:
        return None
    return bias, fine_candles[-1].timestamp


def multi_condition_warmup(rule: MultiConditionRuleConfig) -> dict[str, int]:
    """Max bars needed per distinct interval used across all conditions -
    a coarse over-estimate (same "extra empty bars cost nothing"
    philosophy as indicator_warmup/regime_indicator_warmup), used to size
    each interval's own history-fetch window."""
    warmup: dict[str, int] = {}
    for condition in rule.conditions:
        need = max(_term_warmup(condition.left), _term_warmup(condition.right))
        warmup[condition.interval] = max(warmup.get(condition.interval, 0), need)
    return warmup


def _term_warmup(term: Term) -> int:
    base = term.period if term.period is not None else 1
    return base + term.offset_bars


def align_fine_to_coarse_indices(fine_candles: list[CandleClose], coarse_candles: list[CandleClose], coarse_interval: str) -> list[int]:
    """For each fine bar i, the index into coarse_candles of the last
    coarse candle whose own period had FULLY elapsed as of
    fine_candles[i]'s own timestamp - i.e. the coarse bar actually knowable
    (non-lookahead) at that moment. -1 if none yet (still warming up).
    Binary-search based (bisect_right over each coarse candle's own END
    time) - O((n+m) log n), not the O(n*m) a naive per-bar rescan would
    cost. Mirrors breakout.py's own HTF/LTF boundary-finding
    (_ltf_in_window) generalized to an arbitrary pair of intervals rather
    than hardcoded to exactly 2."""
    duration = _INTERVAL_TIMEDELTA[coarse_interval]
    coarse_end_times = [datetime.fromisoformat(c.timestamp) + duration for c in coarse_candles]
    indices = []
    for fine_candle in fine_candles:
        fine_ts = datetime.fromisoformat(fine_candle.timestamp)
        indices.append(bisect.bisect_right(coarse_end_times, fine_ts) - 1)
    return indices


def build_multi_condition_bias_fn(
    rule: MultiConditionRuleConfig, candles_by_interval: dict[str, list[CandleClose]]
) -> Callable[[list[CandleClose]], Optional[Bias]]:
    """Backtest-replay entry point (app/api/routes/rules.py's
    _backtest_multi_condition) - a drop-in BiasFn for the GENERIC
    backtest.replay/simulate_trades (same reuse rationale
    build_crossover_bias_fn already established for CrossoverRuleConfig:
    precompute every condition's own term series ONCE up front rather than
    recomputing it from scratch on every bar of the scan loop, which is
    exactly the O(n^2) pitfall a prior session's commit already fixed for
    crossover backtests - see that fix's own commit message).
    candles_by_interval must include the FINEST interval used (the one
    Rule.interval equals, and the one `window` arguments below are drawn
    from) plus every other interval any condition references, each
    already covering the full backtest range plus warm-up."""
    finest_interval = min(candles_by_interval, key=lambda iv: INTERVAL_SORT_MINUTES[iv])
    fine_candles = candles_by_interval[finest_interval]

    per_condition: list[tuple[list[Optional[float]], list[Optional[float]], str, list[int]]] = []
    for condition in rule.conditions:
        condition_candles = candles_by_interval[condition.interval]
        left_series = compute_term_series(condition.left, condition_candles)
        right_series = compute_term_series(condition.right, condition_candles)
        if condition.interval == finest_interval:
            index_map = list(range(len(fine_candles)))
        else:
            index_map = align_fine_to_coarse_indices(fine_candles, condition_candles, condition.interval)
        per_condition.append((left_series, right_series, condition.operator, index_map))

    def bias_fn(window: list[CandleClose]) -> Optional[Bias]:
        i = len(window) - 1  # same index-into-precomputed-series trick build_crossover_bias_fn uses
        for left_series, right_series, operator, index_map in per_condition:
            idx = index_map[i]
            if idx < 0 or idx >= len(left_series):
                return None
            left_value, right_value = left_series[idx], right_series[idx]
            if left_value is None or right_value is None:
                return None
            if not _compare(left_value, right_value, operator):
                return None
        return rule.direction

    return bias_fn
