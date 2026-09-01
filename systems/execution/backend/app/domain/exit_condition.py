"""Evaluator for a Strategy's optional exit_condition - a single Condition
(signal-engine's app/domain/generation/rule.py Term/Condition shape, the
same one MultiConditionRuleConfig's own `conditions` list uses, reused
verbatim on the wire - see docs/contracts/resolved-order.schema.json's own
exit_condition entry). Duplicated here, not imported - execution can't
import signal-engine's code (systems/* self-contained, see
docs/architecture.md) - same "duplicate, don't cross-import" precedent
position_manager.py's own compute_ema/compute_atr/compute_supertrend
already established for stop-loss indicators. Keep in sync with
signal-engine's rule.py (Term/Condition/TermKind) and multi_condition.py
(compute_term_series/evaluate_condition) if either shape changes.

Only the TermKinds actually useful for a live per-tick exit watch are
ported: price/sma/ema/rsi/cci/constant - 'volume'/'candle_body'/
'candle_range'/'highest'/'lowest' aren't (yet). An unsupported kind raises
ValueError, caught by position_manager._evaluate_exits' own try/except the
same way a failed candle fetch already is (logged, treated as "not
decidable this tick" rather than crashing the whole exit-monitor run).

Operates on the raw candle dicts get_candle_history returns (each with at
least open/high/low/close/volume), not signal-engine's CandleClose
dataclass - same convention _STOP_LOSS_COMPUTE_FUNCS already uses."""

import logging
from typing import Optional

logger = logging.getLogger(__name__)

_SUPPORTED_TERM_KINDS = frozenset({"price", "sma", "ema", "rsi", "cci", "constant"})


def compute_sma(values: list[Optional[float]], period: int) -> list[Optional[float]]:
    """Direct port of signal-engine's app/domain/generation/indicators.py
    compute_sma."""
    result: list[Optional[float]] = [None] * len(values)
    for i in range(len(values)):
        window = values[max(0, i - period + 1) : i + 1]
        if len(window) < period or any(v is None for v in window):
            continue
        result[i] = sum(window) / period
    return result


def _rsi_from_averages(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def compute_rsi(closes: list[float], period: int) -> list[Optional[float]]:
    """Direct port of signal-engine's app/domain/generation/indicators.py
    compute_rsi (Wilder's RSI)."""
    n = len(closes)
    rsi: list[Optional[float]] = [None] * n
    if n <= period:
        return rsi

    deltas = [closes[i] - closes[i - 1] for i in range(1, n)]
    gains = [d if d > 0 else 0.0 for d in deltas]
    losses = [-d if d < 0 else 0.0 for d in deltas]

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    rsi[period] = _rsi_from_averages(avg_gain, avg_loss)

    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        rsi[i + 1] = _rsi_from_averages(avg_gain, avg_loss)

    return rsi


def compute_ema(closes: list[float], period: int) -> list[Optional[float]]:
    """Same shape as position_manager.py's own compute_ema - duplicated
    again here rather than imported from there, to keep this module
    import-cycle-free (position_manager.py imports THIS module)."""
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


def compute_cci(candles: list[dict], period: int) -> list[Optional[float]]:
    """Direct port of signal-engine's app/domain/generation/indicators.py
    compute_cci (Lambert's original constant-0.015 scaling) - operates on
    raw candle dicts (high/low/close keys) rather than CandleClose."""
    typical = [(c["high"] + c["low"] + c["close"]) / 3 for c in candles]
    sma_tp = compute_sma(typical, period)
    n = len(candles)
    cci: list[Optional[float]] = [None] * n
    for i in range(n):
        if sma_tp[i] is None:
            continue
        window = typical[i - period + 1 : i + 1]
        mean_deviation = sum(abs(v - sma_tp[i]) for v in window) / period
        cci[i] = 0.0 if mean_deviation == 0 else (typical[i] - sma_tp[i]) / (0.015 * mean_deviation)
    return cci


def _field_series(field: str, candles: list[dict]) -> list[float]:
    return [c[field] for c in candles]


def compute_term_series(term: dict, candles: list[dict]) -> list[Optional[float]]:
    """One value per candle (oldest-first, same length as `candles`) -
    dispatches on term['kind']. Mirrors signal-engine's own
    multi_condition.py compute_term_series for the ported subset of kinds
    (see _SUPPORTED_TERM_KINDS) - offset_bars/scale apply uniformly last,
    same as there. Raises ValueError for any other kind."""
    kind = term["kind"]
    if kind not in _SUPPORTED_TERM_KINDS:
        raise ValueError(f"exit_condition term kind {kind!r} not supported live - only {sorted(_SUPPORTED_TERM_KINDS)}")

    if kind == "constant":
        series: list[Optional[float]] = [term["value"]] * len(candles)
    elif kind == "price":
        series = list(_field_series(term["field"], candles))
    elif kind == "sma":
        series = compute_sma(_field_series(term["field"], candles), term["period"])
    elif kind == "ema":
        series = compute_ema([c["close"] for c in candles], term["period"])
    elif kind == "rsi":
        series = compute_rsi([c["close"] for c in candles], term["period"])
    else:  # kind == "cci"
        series = compute_cci(candles, term["period"])

    offset_bars = term.get("offset_bars") or 0
    if offset_bars:
        n = len(series)
        series = [None] * min(offset_bars, n) + series[: max(0, n - offset_bars)]
    scale = term.get("scale", 1.0)
    if scale != 1.0:
        series = [None if v is None else v * scale for v in series]
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


def evaluate_exit_condition(condition: dict, candles: list[dict]) -> Optional[bool]:
    """condition is the position's own exit_condition dict (copied from
    ResolvedOrder.exit_condition at open time) - {"interval", "left"
    (Term), "operator", "right" (Term)}. `candles` is that SAME interval's
    own history, already fetched by the caller
    (position_manager._evaluate_exits) - this function doesn't know or
    care which interval it's for. None (not True/False) if there isn't
    enough history yet to compute both sides - treated as "not decidable
    this tick", same as signal-engine's own evaluate_condition, never a
    crash."""
    if not candles:
        return None
    left_series = compute_term_series(condition["left"], candles)
    right_series = compute_term_series(condition["right"], candles)
    left_value, right_value = left_series[-1], right_series[-1]
    if left_value is None or right_value is None:
        return None
    return _compare(left_value, right_value, condition["operator"])


def exit_condition_warmup(condition: dict) -> int:
    """Bars needed to evaluate this Condition once - mirrors signal-engine's
    own multi_condition.py _term_warmup (period + offset_bars, 1 as the
    floor for a period-less term like price/constant), maxed across both
    sides. Passed to position_manager._indicator_history_window as the
    'period' arg to size the candle-history fetch window."""

    def term_warmup(term: dict) -> int:
        base = term.get("period") or 1
        return base + (term.get("offset_bars") or 0)

    return max(term_warmup(condition["left"]), term_warmup(condition["right"]))
