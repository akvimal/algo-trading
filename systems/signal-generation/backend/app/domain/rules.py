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
from typing import Literal, Optional

from app.domain.indicators import compute_indicator, compute_indicator_signal, indicator_warmup
from app.domain.models import CrossoverRuleConfig, RuleConfig

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
    monitoring."""

    timestamp: str
    close: float
    high: float
    low: float


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
        closes = [c.close for c in candles]
        value_series = compute_indicator(indicator_type, indicator_params, closes)
        signal_series = compute_indicator_signal(indicator_type, indicator_params, closes)
        return evaluate_crossover(value_series, signal_series)
    raise ValueError(f"no evaluator for rule type {type(rule).__name__}")  # pragma: no cover
