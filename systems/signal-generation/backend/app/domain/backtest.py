"""Signal replay + realistic paper-trade simulation - reuses rules.evaluate
(the exact same dispatch the live engine tick calls) in a sliding window
across a historical candle series, instead of just the freshest window.

simulate_trades is the actual engine: it opens a simulated trade on each
fresh signal and closes it the same way execution's real position_manager
would close a real one - a stop-loss/target hit (checked against each
subsequent bar's high/low, the closest a candle-only backtest can get to
execution's continuous CMP monitoring), square_off_time, or - with no
SL/target/square-off configured, or none yet triggered - the next
opposite-direction signal. `replay()` is the route-facing wrapper that
turns a list of simulated trades into a report. A fresh signal can also be
gated on Rule.regime_indicator_ids (resolved by the route layer into
`regime_indicators` - see app/api/routes/rules.py) before it's even
allowed to open - the same per-Rule regime gate app/domain/engine.py's
live tick applies (its own _regime_confirmed helper). Still not a full
sizing/account simulation against execution's real order logic (no
position sizing, no lot sizes, no account balance) - see
docs/architecture.md."""

import itertools
from dataclasses import dataclass
from datetime import datetime, time
from typing import Callable, Optional

from pydantic import ValidationError

from app.domain.indicators import evaluate_regime_indicator
from app.domain.rule import RuleConfig, validate_indicator_params
from app.domain.rules import Bias, CandleClose, SimulatedTrade, bars_needed, evaluate

# A resolved (indicator_type, params) pair per regime indicator a Rule
# references (Rule.regime_indicator_ids) - the route layer resolves ids to
# real Indicator rows once per request (app/api/routes/rules.py), not
# re-fetched per bar. Empty (the default) means no regime gate at all.
RegimeIndicators = list[tuple[str, dict]]

# What simulate_trades/_simulate_one_trade actually need to compute a bias
# from a candle window - decoupled from HOW that bias is derived (an
# indicator's crossover, a Donchian breakout, anything else) so this exit
# engine (SL/target/trailing/square-off/opposite-signal/end-of-data) is
# reusable by any rule type, not just indicator-based ones. See
# app/domain/range_breakout.py for a non-indicator caller.
BiasFn = Callable[[list[CandleClose]], Optional[Bias]]

# A cap on total combinations, not on any one param's value list - keeps a
# single grid-search request bounded (each combination re-runs a full
# `replay` over the candle range) without needing a job queue for
# something meant to stay "lightweight," same philosophy as this module's
# single-backtest replay.
MAX_GRID_COMBINATIONS = 100


@dataclass(frozen=True)
class ExitConfig:
    """Mirrors the subset of Strategy's own stop-loss/target/square-off
    fields simulate_trades needs - built directly from the strategy row
    at the route layer (app/api/routes/strategies.py), not stored here.
    Every field defaults to "not configured," so ExitConfig() alone
    reproduces the old next-opposite-signal-only replay exactly."""

    stop_loss_method: Optional[str] = None  # "percent" | "previous_candle" | None
    stop_loss_percent: Optional[float] = None
    target_percent: Optional[float] = None
    trailing_stop_enabled: bool = False
    square_off_time: Optional[time] = None


def _stop_loss_percent_price(direction: Bias, entry_price: float, stop_loss_percent: float) -> float:
    """Mirrors execution's own compute_stop_loss_percent_price
    (systems/execution/backend/app/domain/position_manager.py) - can't
    import it directly (no cross-system imports between systems/*, see
    docs/architecture.md), so this is the same tiny formula, owned here."""
    if direction == "bullish":
        return entry_price * (1 - stop_loss_percent / 100)
    return entry_price * (1 + stop_loss_percent / 100)


def _target_percent_price(direction: Bias, entry_price: float, target_percent: float) -> float:
    """Mirrors execution's compute_target_percent_price - see
    _stop_loss_percent_price's docstring for why this is duplicated, not
    imported."""
    if direction == "bullish":
        return entry_price * (1 + target_percent / 100)
    return entry_price * (1 - target_percent / 100)


def _previous_candle_stop_price(
    direction: Bias, sl_candles: list[CandleClose], reference_timestamp: str
) -> Optional[float]:
    """The most recently completed sl_candles bar strictly before
    reference_timestamp - the backtest analog of execution's
    get_previous_candle (the freshest completed candle as of "now"),
    looked up against a pre-fetched series instead of a live call.
    `sl_candles` must be oldest-first. None if no such bar exists yet
    (e.g. right at the start of the fetched range)."""
    ref = datetime.fromisoformat(reference_timestamp)
    candidate: Optional[CandleClose] = None
    for c in sl_candles:
        if datetime.fromisoformat(c.timestamp) >= ref:
            break
        candidate = c
    if candidate is None:
        return None
    return candidate.low if direction == "bullish" else candidate.high


def _pnl(direction: Bias, entry_price: float, exit_price: float) -> float:
    return exit_price - entry_price if direction == "bullish" else entry_price - exit_price


def _initial_stop_loss_price(
    direction: Bias,
    entry_price: float,
    entry_timestamp: str,
    exit_config: ExitConfig,
    sl_candles: Optional[list[CandleClose]],
) -> Optional[float]:
    if exit_config.stop_loss_method == "percent" and exit_config.stop_loss_percent is not None:
        return _stop_loss_percent_price(direction, entry_price, exit_config.stop_loss_percent)
    if exit_config.stop_loss_method == "previous_candle" and sl_candles:
        return _previous_candle_stop_price(direction, sl_candles, entry_timestamp)
    return None


def _close(
    entry_candle: CandleClose, direction: Bias, entry_price: float, exit_candle: CandleClose, exit_price: float, reason: str
) -> SimulatedTrade:
    return SimulatedTrade(
        entry_time=entry_candle.timestamp,
        direction=direction,
        entry_price=entry_price,
        exit_time=exit_candle.timestamp,
        exit_price=exit_price,
        exit_reason=reason,
        pnl=_pnl(direction, entry_price, exit_price),
    )


def _simulate_one_trade(
    candles: list[CandleClose],
    entry_index: int,
    direction: Bias,
    bias_fn: BiasFn,
    exit_config: ExitConfig,
    sl_candles: Optional[list[CandleClose]],
) -> tuple[SimulatedTrade, int]:
    """Scans forward from entry_index+1 for the first bar the position
    would close on. Priority per bar: square_off_time (a bar that starts
    at/after it means the real position would already have been closed
    by execution's continuous local-time monitoring before this bar's own
    price action even began) - then a stop-loss/target hit, checked
    against that bar's high/low - then, only if trailing_stop_enabled and
    nothing closed yet, ratchet the stop toward the current price (never
    loosens) - then a fresh opposite-direction signal (the fallback close
    when nothing more specific is configured, or once configured
    conditions stop applying). Returns the trade and the absolute index
    of the bar it closed on."""
    entry_candle = candles[entry_index]
    entry_price = entry_candle.close

    stop_loss_price = _initial_stop_loss_price(direction, entry_price, entry_candle.timestamp, exit_config, sl_candles)
    target_price = (
        _target_percent_price(direction, entry_price, exit_config.target_percent)
        if exit_config.target_percent is not None
        else None
    )

    for j in range(entry_index + 1, len(candles)):
        bar = candles[j]

        if exit_config.square_off_time is not None:
            if datetime.fromisoformat(bar.timestamp).time() >= exit_config.square_off_time:
                return _close(entry_candle, direction, entry_price, bar, bar.close, "square_off"), j

        sl_hit = stop_loss_price is not None and (
            (direction == "bullish" and bar.low <= stop_loss_price) or (direction == "bearish" and bar.high >= stop_loss_price)
        )
        target_hit = target_price is not None and (
            (direction == "bullish" and bar.high >= target_price) or (direction == "bearish" and bar.low <= target_price)
        )
        if sl_hit or target_hit:
            # SL takes priority over target if both would fire on the same
            # (gappy/wide) bar - same tie-break execution's own
            # _evaluate_exits uses.
            exit_price = stop_loss_price if sl_hit else target_price
            reason = "stop_loss" if sl_hit else "target"
            return _close(entry_candle, direction, entry_price, bar, exit_price, reason), j

        if exit_config.trailing_stop_enabled and stop_loss_price is not None:
            candidate: Optional[float] = None
            if exit_config.stop_loss_method == "percent":
                candidate = _stop_loss_percent_price(direction, bar.close, exit_config.stop_loss_percent)
            elif exit_config.stop_loss_method == "previous_candle" and sl_candles:
                candidate = _previous_candle_stop_price(direction, sl_candles, bar.timestamp)
            if candidate is not None:
                more_favorable = candidate > stop_loss_price if direction == "bullish" else candidate < stop_loss_price
                if more_favorable:
                    stop_loss_price = candidate

        opposite = bias_fn(candles[: j + 1])
        if opposite is not None and opposite != direction:
            return _close(entry_candle, direction, entry_price, bar, bar.close, "opposite_signal"), j

    last = candles[-1]
    return _close(entry_candle, direction, entry_price, last, last.close, "end_of_data"), len(candles) - 1


def simulate_trades(
    bias_fn: BiasFn,
    min_bars: int,
    candles: list[CandleClose],
    exit_config: Optional[ExitConfig] = None,
    sl_candles: Optional[list[CandleClose]] = None,
    regime_indicators: RegimeIndicators = (),
) -> list[SimulatedTrade]:
    """The generic exit engine (SL/target/trailing/square-off/
    opposite-signal/end-of-data) - `bias_fn` is however a specific rule
    type decides "bullish"/"bearish"/None from a candle window (an
    indicator crossover, a Donchian breakout, ...); this function knows
    nothing about how that decision is made. `min_bars` is that rule's
    own warm-up requirement (e.g. bars_needed(...) + 1 for a crossover
    rule - the caller computes this, this function just uses it as the
    scan's starting index).

    `candles` must be oldest-first, completed bars only, covering the
    full range to backtest - including whatever warm-up bars the rule
    needs before the range actually of interest (callers should fetch a
    slightly wider range than they report on, same as the live engine
    does via engine.history_window). `sl_candles` (a separately-fetched
    series at the strategy's own stop_loss_interval) is only used for
    stop_loss_method='previous_candle'; ignored otherwise (callers should
    pass the same series as `candles` when the two intervals match, to
    skip a second market-data fetch - see app/api/routes/strategies.py).

    Only one simulated trade is open at a time: while one is open, no bar
    is scanned for a fresh entry (mirrors a Strategy's
    duplicate_signal_policy='skip' - this simulation always behaves this
    way regardless of the strategy's actual configured policy, a known
    simplification; it never simulates 'add_position' pyramiding) - a
    trade only closes via SL/target/square-off/opposite-signal, never a
    same-direction re-signal. A signal whose own bar is already at or
    past square_off_time never opens at all, mirroring
    is_within_intraday_window's real rejection in execution. When
    `regime_indicators` is non-empty, a fresh signal is also skipped (not
    opened) unless EVERY listed (indicator_type, params) pair's
    evaluate_regime_indicator confirms `direction` on the same growing
    window - the exact same all-must-agree gate app/domain/engine.py's
    live tick applies via its own _regime_confirmed, single-timeframe
    (the same `candles`/interval, no separate higher-timeframe fetch)."""
    exit_config = exit_config or ExitConfig()
    trades: list[SimulatedTrade] = []
    n = len(candles)
    i = min_bars
    while i <= n:
        window = candles[:i]
        direction = bias_fn(window)
        if direction is None:
            i += 1
            continue

        if regime_indicators and not all(
            evaluate_regime_indicator(indicator_type, params, window, direction) for indicator_type, params in regime_indicators
        ):
            i += 1
            continue

        entry_index = i - 1
        if exit_config.square_off_time is not None:
            entry_dt = datetime.fromisoformat(candles[entry_index].timestamp)
            if entry_dt.time() >= exit_config.square_off_time:
                i += 1
                continue  # would be rejected outside the intraday window, same as execution

        trade, exit_index = _simulate_one_trade(candles, entry_index, direction, bias_fn, exit_config, sl_candles)
        trades.append(trade)
        if exit_index >= n - 1:
            break  # consumed through the last available candle - nothing left to scan
        i = exit_index + 1

    return trades


def replay(
    bias_fn: BiasFn,
    min_bars: int,
    candles: list[CandleClose],
    exit_config: Optional[ExitConfig] = None,
    sl_candles: Optional[list[CandleClose]] = None,
    regime_indicators: RegimeIndicators = (),
) -> dict:
    """The route-facing report: runs simulate_trades and totals the
    result. See simulate_trades' own docstring for what "hypothetical_pnl"
    does and doesn't account for."""
    trades = simulate_trades(bias_fn, min_bars, candles, exit_config, sl_candles, regime_indicators)
    return {
        "trade_count": len(trades),
        "hypothetical_pnl": sum(t.pnl for t in trades),
        "trades": [
            {
                "entry_time": t.entry_time,
                "direction": t.direction,
                "entry_price": t.entry_price,
                "exit_time": t.exit_time,
                "exit_price": t.exit_price,
                "exit_reason": t.exit_reason,
                "pnl": t.pnl,
            }
            for t in trades
        ],
    }


def expand_grid(base_params: dict, param_grid: dict[str, list]) -> list[dict]:
    """The cartesian product of param_grid's value lists, each combination
    merged onto base_params - any indicator param NOT named in param_grid
    stays fixed at its value in base_params (typically the strategy's
    currently-referenced Indicator's own params). Raises ValueError for a
    param name that isn't one of base_params's own keys (a typo guard - it
    doesn't need to know indicator-type-specific field names, since
    base_params already came from a real Indicator's validated params) or
    a grid too large to run in one request."""
    unknown = set(param_grid) - set(base_params)
    if unknown:
        raise ValueError(f"unknown indicator param(s) for grid search: {sorted(unknown)}")

    keys = list(param_grid)
    combos = list(itertools.product(*(param_grid[k] for k in keys)))
    if not combos:
        raise ValueError("param_grid must have at least one candidate value per param")
    if len(combos) > MAX_GRID_COMBINATIONS:
        raise ValueError(
            f"grid search would run {len(combos)} combinations - max is {MAX_GRID_COMBINATIONS}, narrow the param_grid"
        )
    return [{**base_params, **dict(zip(keys, combo))} for combo in combos]


def grid_search(
    rule: RuleConfig,
    indicator_type: str,
    combos: list[dict],
    candles: list[CandleClose],
    exit_config: Optional[ExitConfig] = None,
    sl_candles: Optional[list[CandleClose]] = None,
    regime_indicators: RegimeIndicators = (),
) -> dict:
    """Runs `replay` once per combination in `combos` (see expand_grid),
    against the same candle series (and the same exit_config/sl_candles/
    regime_indicators - none of those depend on indicator params) for all
    of them. `candles` must already cover the
    widest warm-up any combination needs - callers compute this up front
    from `combos` (via rules.bars_needed) since candidate params aren't
    known until the grid is expanded, see app/api/routes/strategies.py.
    Results are sorted by hypothetical_pnl descending (best first); a
    combination that fails its own param validation (e.g. period=1,
    below RsiParams's gt=1 floor) is reported with an `error` instead of
    being silently dropped or crashing the whole request."""
    results = []
    for candidate_params in combos:
        try:
            validated = validate_indicator_params(indicator_type, candidate_params).model_dump()
        except ValidationError as exc:
            message = exc.errors()[0]["msg"] if exc.errors() else str(exc)
            results.append({"params": candidate_params, "error": message})
            continue
        outcome = replay(
            lambda window, p=validated: evaluate(rule, indicator_type, p, window),
            bars_needed(rule, indicator_type, validated) + 1,
            candles,
            exit_config,
            sl_candles,
            regime_indicators,
        )
        results.append(
            {
                "params": candidate_params,
                "trade_count": outcome["trade_count"],
                "hypothetical_pnl": outcome["hypothetical_pnl"],
            }
        )

    results.sort(key=lambda r: r.get("hypothetical_pnl", float("-inf")), reverse=True)
    return {"combinations_tested": len(combos), "results": results}
