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
gated on app/domain/regime.py's market regime classifier
(`regime_filter_enabled`) before it's even allowed to open - the same
single-timeframe check app/domain/engine.py's live tick applies. Still not
a full sizing/account simulation against execution's real order logic (no
position sizing, no lot sizes, no account balance) - see
docs/architecture.md."""

import itertools
from dataclasses import dataclass
from datetime import datetime, time
from typing import Optional

from pydantic import ValidationError

from app.domain import regime
from app.domain.models import RuleConfig, validate_indicator_params
from app.domain.rules import Bias, CandleClose, SimulatedTrade, bars_needed, evaluate

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
    rule: RuleConfig,
    indicator_type: str,
    indicator_params: dict,
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

        opposite = evaluate(rule, indicator_type, indicator_params, candles[: j + 1])
        if opposite is not None and opposite != direction:
            return _close(entry_candle, direction, entry_price, bar, bar.close, "opposite_signal"), j

    last = candles[-1]
    return _close(entry_candle, direction, entry_price, last, last.close, "end_of_data"), len(candles) - 1


def simulate_trades(
    rule: RuleConfig,
    indicator_type: str,
    indicator_params: dict,
    candles: list[CandleClose],
    exit_config: Optional[ExitConfig] = None,
    sl_candles: Optional[list[CandleClose]] = None,
    regime_filter_enabled: bool = False,
    regime_checks: frozenset = regime.ALL_REGIME_CHECKS,
) -> list[SimulatedTrade]:
    """`candles` must be oldest-first, completed bars only, covering the
    full range to backtest - including whatever warm-up bars the
    indicator needs before the range actually of interest (callers
    should fetch a slightly wider range than they report on, same as the
    live engine does via engine.history_window). `sl_candles` (a
    separately-fetched series at the strategy's own stop_loss_interval)
    is only used for stop_loss_method='previous_candle'; ignored
    otherwise (callers should pass the same series as `candles` when the
    two intervals match, to skip a second market-data fetch - see
    app/api/routes/strategies.py).

    Only one simulated trade is open at a time: while one is open, no bar
    is scanned for a fresh entry (mirrors a Strategy's
    duplicate_signal_policy='skip' - this simulation always behaves this
    way regardless of the strategy's actual configured policy, a known
    simplification; it never simulates 'add_position' pyramiding) - a
    trade only closes via SL/target/square-off/opposite-signal, never a
    same-direction re-signal. A signal whose own bar is already at or
    past square_off_time never opens at all, mirroring
    is_within_intraday_window's real rejection in execution. When
    `regime_filter_enabled`, a fresh signal is also skipped (not opened)
    unless app/domain/regime.py's direction_confirmed, on the same
    growing window and requiring only `regime_checks` (a subset of
    regime.REGIME_CHECK_NAMES, defaulting to all 5), confirms its
    direction - the exact same check app/domain/engine.py's live tick
    applies, single-timeframe (the same `candles`/interval, no separate
    higher-timeframe fetch)."""
    exit_config = exit_config or ExitConfig()
    min_bars = bars_needed(rule, indicator_type, indicator_params) + 1
    trades: list[SimulatedTrade] = []
    n = len(candles)
    i = min_bars
    while i <= n:
        window = candles[:i]
        direction = evaluate(rule, indicator_type, indicator_params, window)
        if direction is None:
            i += 1
            continue

        if regime_filter_enabled:
            regime_result = regime.classify_regime(window)
            if not regime.direction_confirmed(direction, regime_result, enabled_checks=regime_checks):
                i += 1
                continue

        entry_index = i - 1
        if exit_config.square_off_time is not None:
            entry_dt = datetime.fromisoformat(candles[entry_index].timestamp)
            if entry_dt.time() >= exit_config.square_off_time:
                i += 1
                continue  # would be rejected outside the intraday window, same as execution

        trade, exit_index = _simulate_one_trade(
            candles, entry_index, direction, rule, indicator_type, indicator_params, exit_config, sl_candles
        )
        trades.append(trade)
        if exit_index >= n - 1:
            break  # consumed through the last available candle - nothing left to scan
        i = exit_index + 1

    return trades


def replay(
    rule: RuleConfig,
    indicator_type: str,
    indicator_params: dict,
    candles: list[CandleClose],
    exit_config: Optional[ExitConfig] = None,
    sl_candles: Optional[list[CandleClose]] = None,
    regime_filter_enabled: bool = False,
    regime_checks: frozenset = regime.ALL_REGIME_CHECKS,
) -> dict:
    """The route-facing report: runs simulate_trades and totals the
    result. See simulate_trades' own docstring for what "hypothetical_pnl"
    does and doesn't account for."""
    trades = simulate_trades(
        rule, indicator_type, indicator_params, candles, exit_config, sl_candles, regime_filter_enabled, regime_checks
    )
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
    regime_filter_enabled: bool = False,
    regime_checks: frozenset = regime.ALL_REGIME_CHECKS,
) -> dict:
    """Runs `replay` once per combination in `combos` (see expand_grid),
    against the same candle series (and the same exit_config/sl_candles/
    regime_filter_enabled/regime_checks - none of those depend on
    indicator params) for all of them. `candles` must already cover the
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
            rule, indicator_type, validated, candles, exit_config, sl_candles, regime_filter_enabled, regime_checks
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
