"""Signal rules - pure functions from a candle series to a bullish/bearish
decision (or None). This is the single source of truth both the live
engine (engine.py, on the freshest window) and the backtest replay
(backtest.py, in a sliding window across history) call, so the two can
never silently disagree about what counts as a signal.

Deliberately indicator-agnostic: a rule takes already-computed series (or,
for the top-level `evaluate`/`bars_needed` dispatchers, an indicator type
+ params it delegates to app/domain/indicators.py for) - nothing here
hardcodes RSI. An indicator's own signal line (e.g. RSI's SMA-of-itself)
is computed by indicators.py, as part of the indicator's own definition -
not a rule parameter, see CrossoverRuleConfig. Adding a second rule type
later means adding a new evaluate_* function and a new RuleConfig variant
(see domain/models.py), not touching existing functions; adding a second
indicator type means a change in indicators.py only, not here."""

from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Literal, Optional

from app.domain.generation.indicators import compute_indicator, compute_indicator_signal, indicator_warmup
from app.domain.generation.rule import CrossoverRuleConfig, RuleConfig

Bias = Literal["bullish", "bearish"]


@dataclass(frozen=True)
class CandleClose:
    """The shape a rule/backtest needs from a candle - deliberately not
    market-data's Candle Pydantic model (no cross-system imports; see
    docs/architecture.md). app/adapters/market_data/client.py converts
    market-data's JSON response into this. `high`/`low` aren't used by
    any indicator/rule (those only ever look at `close`) - they exist for
    app/domain/backtest.py's stop-loss/target hit detection, the closest
    a candle-only backtest can get to execution's continuous CMP
    monitoring. `open`/`volume` exist for app/domain/multi_condition.py's
    Term primitives (candle_body/candle_range need open, a volume
    condition needs volume) - every other rule type still ignores both.
    Both default to 0.0 so every pre-existing CandleClose(...) call site
    (crossover/breakout/range_breakout code and their tests, none of which
    ever populated these) keeps working unchanged - only
    app/adapters/market_data/client.py (the real construction site) and
    multi_condition's own tests need to actually populate them."""

    timestamp: str
    close: float
    high: float
    low: float
    open: float = 0.0
    volume: float = 0.0


@dataclass
class SimulatedTrade:
    """A simulated paper trade, produced by app/domain/backtest.py's
    crossover-rule simulation or app/domain/breakout.py's breakout-rule
    simulation - lives here (not in either of those) so both can construct
    one without a circular import between them."""

    entry_time: str
    direction: Bias
    entry_price: float
    exit_time: str
    exit_price: float
    exit_reason: str  # "stop_loss" | "target" | "square_off" | "opposite_signal" | "end_of_data" | "initial_stop_loss" | "reversal_exit"
    pnl: float


def evaluate_crossover(value_series: list[Optional[float]], signal_series: list[Optional[float]]) -> Optional[Bias]:
    """Fires when `value_series` crosses `signal_series` on the latest bar
    (comparing the last two value-vs-signal relationships) - None if
    there's not enough data yet, or no fresh crossover on the latest bar
    (value was already on the same side of signal the bar before). Takes
    two plain already-computed series - has no idea what indicator
    produced them or how the signal series was derived (an indicator's
    own SMA-of-itself, or anything else a future indicator type computes
    as its signal line) - that's the whole point of the split from rules
    that used to be RSI-specific."""
    if len(value_series) < 2 or len(signal_series) < 2:
        return None
    if value_series[-1] is None or value_series[-2] is None:
        return None
    if signal_series[-1] is None or signal_series[-2] is None:
        return None

    prev_above = value_series[-2] > signal_series[-2]
    curr_above = value_series[-1] > signal_series[-1]
    if prev_above == curr_above:
        return None

    return "bullish" if curr_above else "bearish"


def evaluate_crossover_at(
    value_series: list[Optional[float]], signal_series: list[Optional[float]], index: int
) -> Optional[Bias]:
    """Same check as evaluate_crossover, against an explicit 0-based bar
    index into an already-computed full series (the "window ending at
    index" is candles[:index+1]) instead of always the series' own last
    two elements - evaluate_crossover(value_series, signal_series) is
    exactly evaluate_crossover_at(value_series, signal_series,
    len(value_series) - 1). Exists so build_crossover_bias_fn below can
    precompute value_series/signal_series ONCE for a whole candle range
    and do an O(1) lookup per bar of backtest.py's scan loop, instead of
    evaluate()'s own re-slice-and-recompute-the-whole-series-from-scratch
    behavior repeated on every bar (each of those was itself
    O(bars-so-far), making the whole scan O(n^2) for an n-bar backtest -
    confirmed live: ~90s-2min for a ~9,400-bar 15min/3-month range)."""
    if index < 1:
        return None
    if value_series[index] is None or value_series[index - 1] is None:
        return None
    if signal_series[index] is None or signal_series[index - 1] is None:
        return None

    prev_above = value_series[index - 1] > signal_series[index - 1]
    curr_above = value_series[index] > signal_series[index]
    if prev_above == curr_above:
        return None

    return "bullish" if curr_above else "bearish"


def find_crossovers_since(
    rule: RuleConfig, indicator_type: str, indicator_params: dict, candles: list[CandleClose], since_ts: Optional[datetime]
) -> list[tuple[int, Bias]]:
    """Every crossover on a bar strictly after `since_ts` (None = only ever
    check the single latest bar, same as evaluate()'s own scope - so
    activating a strategy for the first time never replays its whole
    fetched history as a burst of backdated signals), in chronological
    order as (candle index, bias) pairs.

    Exists because a live engine tick's own 60s poll cadence isn't
    guaranteed to align with the candle cadence - if 2+ candles complete
    between one tick and the next (processing lag, or plain phase drift
    between the poll timer and the exchange's minute boundaries), comparing
    only the newest bar-pair (evaluate()'s own behavior, still what
    build_crossover_bias_fn's backtest callers use - a sliding window that
    never skips a bar) can silently miss a crossover-then-reversal that
    happened entirely within the skipped bars - reproduced live 2026-08-21
    (RSI crossed back within the very next 1min bar after a signal, and
    that reversal was never posted). engine.py's _run_one is the only
    caller - it acts on EVERY crossover this returns, not just the last."""
    if not isinstance(rule, CrossoverRuleConfig):
        raise ValueError(f"no crossover scan for rule type {type(rule).__name__}")  # pragma: no cover
    if not candles:
        return []

    value_series = compute_indicator(indicator_type, indicator_params, candles)
    signal_series = compute_indicator_signal(indicator_type, indicator_params, candles)

    if since_ts is None:
        start = len(candles) - 1
    else:
        start = next((i for i, c in enumerate(candles) if datetime.fromisoformat(c.timestamp) > since_ts), len(candles))

    found: list[tuple[int, Bias]] = []
    for i in range(max(start, 1), len(candles)):
        bias = evaluate_crossover_at(value_series, signal_series, i)
        if bias is not None:
            found.append((i, bias))
    return found


def bars_needed(rule: RuleConfig, indicator_type: str, indicator_params: dict) -> int:
    """How many candles a (rule, indicator) pair needs before it can
    produce its first evaluation - used to size a history request
    (engine.py) or the warm-up prefix of a backtest range (backtest.py)."""
    if isinstance(rule, CrossoverRuleConfig):
        return indicator_warmup(indicator_type, indicator_params)
    raise ValueError(f"no bars_needed rule for rule type {type(rule).__name__}")  # pragma: no cover


def evaluate(rule: RuleConfig, indicator_type: str, indicator_params: dict, candles: list[CandleClose]) -> Optional[Bias]:
    """Dispatches to the right rule function for `rule`'s type, computing
    the indicator's value/signal series via app/domain/indicators.py
    first - the one place that needs a new branch when a second rule type
    ships."""
    if isinstance(rule, CrossoverRuleConfig):
        value_series = compute_indicator(indicator_type, indicator_params, candles)
        signal_series = compute_indicator_signal(indicator_type, indicator_params, candles)
        return evaluate_crossover(value_series, signal_series)
    raise ValueError(f"no evaluator for rule type {type(rule).__name__}")  # pragma: no cover


def build_crossover_bias_fn(
    rule: RuleConfig, indicator_type: str, indicator_params: dict, candles: list[CandleClose]
) -> Callable[[list[CandleClose]], Optional[Bias]]:
    """Backtest-only optimization: precomputes the indicator's value/
    signal series ONCE over the full candle range up front, returning a
    bias_fn (same (window) -> Optional[Bias] shape evaluate() itself has -
    a drop-in for backtest.py's simulate_trades/replay/grid_search bias_fn
    parameter) that does an O(1) lookup per bar via evaluate_crossover_at
    instead of evaluate()'s own recompute-the-whole-series-from-scratch
    behavior. Safe because every indicator this can dispatch to
    (compute_rsi, compute_sma, compute_supertrend) is causal - index i's
    value only ever depends on candles[0..i], never future data - so
    precomputing over the FULL series and later reading index i produces
    exactly what evaluate() would compute fresh from just candles[:i+1],
    not an approximation. evaluate() itself is untouched and still what
    the live engine tick (engine.py) uses, which only ever evaluates one
    fixed window once per tick - its own per-call recompute cost was
    never accumulated in a loop there, so it was never worth this
    complexity."""
    if not isinstance(rule, CrossoverRuleConfig):
        raise ValueError(f"no crossover bias_fn for rule type {type(rule).__name__}")  # pragma: no cover

    value_series = compute_indicator(indicator_type, indicator_params, candles)
    signal_series = compute_indicator_signal(indicator_type, indicator_params, candles)

    def bias_fn(window: list[CandleClose]) -> Optional[Bias]:
        return evaluate_crossover_at(value_series, signal_series, len(window) - 1)

    return bias_fn
