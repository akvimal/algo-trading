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
from dataclasses import dataclass, replace
from datetime import datetime, time
from typing import Callable, Optional

from pydantic import ValidationError

from app.domain.indicators import evaluate_regime_indicator
from app.domain.regime import compute_ema
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

    stop_loss_method: Optional[str] = None  # "percent" | "previous_candle" | "indicator" | None
    stop_loss_percent: Optional[float] = None
    # stop_loss_method='indicator' only - see app/domain/rule.py's
    # validate_stop_loss_indicator_params/_STOP_LOSS_INDICATOR_PARAMS_MODELS
    # for the type->params-shape dispatch, and _STOP_LOSS_COMPUTE_FUNCS
    # below for the type->candidate-value dispatch.
    stop_loss_indicator_type: Optional[str] = None
    stop_loss_indicator_params: Optional[dict] = None
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


def _ema_stop_value(closes: list[float], params: dict) -> Optional[float]:
    ema = compute_ema(closes, params["period"])
    return ema[-1] if ema and ema[-1] is not None else None


# stop_loss_indicator_type -> (closes, params) -> candidate stop value, no
# direction concept here (unlike _previous_candle_stop_price's low/high
# split) - the caller decides whether a given candidate is more favorable
# based on direction, this only computes the raw indicator value. Mirrors
# execution's own _STOP_LOSS_COMPUTE_FUNCS (position_manager.py) exactly -
# a deliberate duplicate, not shared, since execution can't import this
# module (systems/* self-contained). Adding a second indicator type means
# a new entry here AND there, plus widening both CHECK constraints - see
# app/domain/rule.py's own comment on this.
_STOP_LOSS_COMPUTE_FUNCS: dict[str, Callable[[list[float], dict], Optional[float]]] = {
    "ema": _ema_stop_value,
}


def _indicator_stop_price(
    sl_candles: list[CandleClose], reference_timestamp: str, indicator_type: str, indicator_params: dict
) -> Optional[float]:
    """Indicator value computed only from sl_candles strictly before
    reference_timestamp - same as-of-this-point-in-time semantics
    _previous_candle_stop_price already uses, to avoid lookahead bias.
    None if there isn't enough history yet or indicator_type is
    unrecognized."""
    ref = datetime.fromisoformat(reference_timestamp)
    closes = [c.close for c in sl_candles if datetime.fromisoformat(c.timestamp) < ref]
    compute = _STOP_LOSS_COMPUTE_FUNCS.get(indicator_type)
    if compute is None or not closes:
        return None
    return compute(closes, indicator_params)


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
    if exit_config.stop_loss_method == "indicator" and sl_candles and exit_config.stop_loss_indicator_type and exit_config.stop_loss_indicator_params:
        return _indicator_stop_price(
            sl_candles, entry_timestamp, exit_config.stop_loss_indicator_type, exit_config.stop_loss_indicator_params
        )
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
            elif exit_config.stop_loss_method == "indicator" and sl_candles and exit_config.stop_loss_indicator_type and exit_config.stop_loss_indicator_params:
                candidate = _indicator_stop_price(
                    sl_candles, bar.timestamp, exit_config.stop_loss_indicator_type, exit_config.stop_loss_indicator_params
                )
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


def _win_rate(trades: list[SimulatedTrade]) -> float:
    """% of trades with pnl > 0 - a trade with pnl == 0 (e.g. an
    end-of-data exit at the same price it entered) counts as neither a
    win nor a loss, so it still lowers the rate, same as a real loss
    would for "did this trade make money" purposes."""
    if not trades:
        return 0.0
    wins = sum(1 for t in trades if t.pnl > 0)
    return wins / len(trades) * 100


def _max_drawdown(trades: list[SimulatedTrade]) -> float:
    """Largest peak-to-trough decline in CUMULATIVE hypothetical_pnl,
    walking trades in the order they actually closed (exit_time, not
    entry_time - pnl realizes at close) - not a real equity-curve
    drawdown (simulate_trades models no position sizing/capital, see its
    own docstring), just how much the running total ever gave back from
    its own high-water mark. Always >= 0; 0.0 for no trades or a
    cumulative total that never dipped below its own running peak."""
    if not trades:
        return 0.0
    ordered = sorted(trades, key=lambda t: t.exit_time)
    cumulative = 0.0
    peak = 0.0
    max_dd = 0.0
    for t in ordered:
        cumulative += t.pnl
        peak = max(peak, cumulative)
        max_dd = max(max_dd, peak - cumulative)
    return max_dd


def _time_of_day_breakdown(trades: list[SimulatedTrade], bucket_minutes: int) -> list[dict]:
    """Groups trades by their ENTRY time's clock-time-of-day into
    bucket_minutes-wide buckets, clock-aligned to midnight (same
    alignment convention market-data's aggregate_candles already uses for
    its own N-minute bars) - not aligned to market open, so results are
    comparable across segments with different session start times (NSE
    vs CRYPTO's 24/7). Only buckets with at least one trade are
    returned, sorted by start time - answers "which time of day is this
    rule most/least profitable," the point of surfacing this at all."""
    buckets: dict[int, list[SimulatedTrade]] = {}
    for t in trades:
        entry_dt = datetime.fromisoformat(t.entry_time)
        minute_of_day = entry_dt.hour * 60 + entry_dt.minute
        bucket_start = (minute_of_day // bucket_minutes) * bucket_minutes
        buckets.setdefault(bucket_start, []).append(t)

    def _fmt(minute_of_day: int) -> str:
        return f"{(minute_of_day // 60) % 24:02d}:{minute_of_day % 60:02d}"

    return [
        {
            "start": _fmt(bucket_start),
            "end": _fmt(bucket_start + bucket_minutes),
            "trade_count": len(bucket_trades),
            "hypothetical_pnl": sum(t.pnl for t in bucket_trades),
            "win_rate": _win_rate(bucket_trades),
        }
        for bucket_start, bucket_trades in sorted(buckets.items())
    ]


def replay(
    bias_fn: BiasFn,
    min_bars: int,
    candles: list[CandleClose],
    exit_config: Optional[ExitConfig] = None,
    sl_candles: Optional[list[CandleClose]] = None,
    regime_indicators: RegimeIndicators = (),
    time_bucket_minutes: Optional[int] = None,
) -> dict:
    """The route-facing report: runs simulate_trades and totals the
    result. See simulate_trades' own docstring for what "hypothetical_pnl"
    does and doesn't account for. win_rate/max_drawdown are always
    included (cheap, always useful, including for grid_search's own
    per-combination calls below). time_of_day_breakdown is opt-in
    (time_bucket_minutes given) - a full per-bucket table on every one of
    a grid search's combinations would be far more data than that report
    is meant to carry, so only the single-backtest route requests it."""
    trades = simulate_trades(bias_fn, min_bars, candles, exit_config, sl_candles, regime_indicators)
    report = {
        "trade_count": len(trades),
        "hypothetical_pnl": sum(t.pnl for t in trades),
        "win_rate": _win_rate(trades),
        "max_drawdown": _max_drawdown(trades),
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
    if time_bucket_minutes is not None:
        report["time_of_day_breakdown"] = _time_of_day_breakdown(trades, time_bucket_minutes)
    return report


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


def expand_stop_loss_grid(param_grid: dict[str, list]) -> list[dict]:
    """Same cartesian-product shape as expand_grid, for
    stop_loss_indicator_params instead of the rule's own indicator params
    - no "base_params to merge non-swept keys onto" concept here, unlike
    expand_grid: every stop-loss indicator type's params model is small
    enough (one field, 'period', for 'ema' today - see
    _STOP_LOSS_INDICATOR_PARAMS_MODELS in app/domain/rule.py) that every
    key must be named in the grid itself, there's no sensible "current
    value" to fall back to the way a real Indicator row provides one for
    expand_grid. Raises ValueError for an empty grid or one too large to
    run (same MAX_GRID_COMBINATIONS cap, applied to THIS dimension alone -
    the route layer caps the combined total against the indicator grid)."""
    keys = list(param_grid)
    combos = list(itertools.product(*(param_grid[k] for k in keys)))
    if not combos:
        raise ValueError("stop_loss_indicator_param_grid must have at least one candidate value per param")
    if len(combos) > MAX_GRID_COMBINATIONS:
        raise ValueError(
            f"stop-loss grid search would run {len(combos)} combinations - max is {MAX_GRID_COMBINATIONS}, narrow it"
        )
    return [dict(zip(keys, combo)) for combo in combos]


def grid_search(
    rule: RuleConfig,
    indicator_type: str,
    combos: list[dict],
    candles: list[CandleClose],
    exit_config: Optional[ExitConfig] = None,
    sl_candles: Optional[list[CandleClose]] = None,
    regime_indicators: RegimeIndicators = (),
    stop_loss_indicator_combos: Optional[list[dict]] = None,
) -> dict:
    """Runs `replay` once per combination in `combos` (see expand_grid),
    against the same candle series (and the same sl_candles/
    regime_indicators - neither depends on indicator params) for all of
    them. `candles` must already cover the widest warm-up any combination
    needs - callers compute this up front from `combos` (via
    rules.bars_needed) since candidate params aren't known until the grid
    is expanded, see app/api/routes/strategies.py.

    stop_loss_indicator_combos (see expand_stop_loss_grid): when given
    (exit_config.stop_loss_method must be 'indicator'), a SECOND sweep
    dimension - every (indicator params, stop-loss params) pair gets its
    own replay run, exit_config.stop_loss_indicator_params overridden per
    stop-loss combo (dataclasses.replace, ExitConfig is frozen). None (the
    default) keeps the pre-existing one-dimensional behavior: exit_config's
    own fixed stop_loss_indicator_params applies to every combo unchanged.
    Each result row gets an extra stop_loss_indicator_params key only when
    this second dimension is active, so single-dimension callers/tests see
    the exact same result shape as before this parameter existed.

    Results are sorted by hypothetical_pnl descending (best first); a
    combination that fails its own param validation (e.g. period=1,
    below RsiParams's gt=1 floor) is reported with an `error` instead of
    being silently dropped or crashing the whole request - this only
    applies to the indicator dimension, stop-loss combos are pre-validated
    by the route layer before reaching here (see validate_stop_loss_indicator_params)."""
    sl_combos = stop_loss_indicator_combos if stop_loss_indicator_combos is not None else [None]
    results = []
    for candidate_params in combos:
        try:
            validated = validate_indicator_params(indicator_type, candidate_params).model_dump()
        except ValidationError as exc:
            message = exc.errors()[0]["msg"] if exc.errors() else str(exc)
            results.append({"params": candidate_params, "error": message})
            continue
        for sl_params in sl_combos:
            effective_exit_config = exit_config
            if sl_params is not None and exit_config is not None:
                effective_exit_config = replace(exit_config, stop_loss_indicator_params=sl_params)
            outcome = replay(
                lambda window, p=validated: evaluate(rule, indicator_type, p, window),
                bars_needed(rule, indicator_type, validated) + 1,
                candles,
                effective_exit_config,
                sl_candles,
                regime_indicators,
            )
            result_row = {
                "params": candidate_params,
                "trade_count": outcome["trade_count"],
                "hypothetical_pnl": outcome["hypothetical_pnl"],
            }
            if sl_params is not None:
                result_row["stop_loss_indicator_params"] = sl_params
            results.append(result_row)

    results.sort(key=lambda r: r.get("hypothetical_pnl", float("-inf")), reverse=True)
    return {"combinations_tested": len(results), "results": results}
