"""Backtests an externally-supplied signal list (e.g. a Chartink alert
history CSV export - symbol + timestamp, no price/direction columns)
against a GRID of exit configurations, to find which stop-loss/target/
trailing setup would have worked best for signals that already happened -
the opposite direction from every other backtest in this module (which
all derive ENTRIES from a Rule's own condition and hold exit config
fixed). Reuses app/domain/generation/backtest.py's simulate_trades/
ExitConfig/win_rate/max_drawdown completely unchanged - simulate_trades'
own docstring is explicit that its BiasFn abstraction doesn't care how a
direction decision is made, so "fire at exactly this externally-given
timestamp" is just as valid a BiasFn as an indicator crossover. See
docs/architecture.md for why this lives in signal-engine (the same
service every other backtest already does) rather than execution -
still purely a hypothetical replay, no position sizing/account
involved, same scope limit every other backtest here already has."""

import itertools
from typing import Optional

from app.domain.generation.backtest import (
    MAX_GRID_COMBINATIONS,
    BiasFn,
    ExitConfig,
    max_drawdown,
    simulate_trades,
    win_rate,
)
from app.domain.generation.rules import Bias, CandleClose, SimulatedTrade


def _bias_fn_from_signal_timestamps(sorted_timestamps: list[str], direction: Bias) -> BiasFn:
    """Fires `direction` on the first candle whose own timestamp is >= the
    next not-yet-consumed signal timestamp (a real fill can only happen at
    or after the alert fired, never before - Chartink's own timestamp
    rarely lands exactly on a candle boundary), then advances past every
    timestamp <= that bar (so two signals landing in the same candle don't
    leave one stuck trying to match a bar that's already gone by). Mutable
    pointer in a closure, not a class - matches every other BiasFn in this
    codebase being a plain closure/function, not an object.

    A signal that arrives while a previous trade (on the same symbol) is
    still open is never reached at all - simulate_trades itself only calls
    bias_fn on bars it's actually scanning for a fresh entry, which skips
    forward past a trade's whole open duration (see its own docstring).
    This is exactly the live duplicate_signal_policy='skip' behavior a
    real Chartink-sourced Strategy defaults to, not a limitation specific
    to this replay."""
    pointer = [0]

    def bias_fn(window: list[CandleClose]) -> Optional[Bias]:
        bar_ts = window[-1].timestamp
        matched = False
        while pointer[0] < len(sorted_timestamps) and sorted_timestamps[pointer[0]] <= bar_ts:
            pointer[0] += 1
            matched = True
        return direction if matched else None

    return bias_fn


def simulate_external_signals_by_symbol(
    signals_by_symbol: dict[str, list[str]],
    direction: Bias,
    candles_by_symbol: dict[str, list[CandleClose]],
    exit_config: Optional[ExitConfig] = None,
    sl_candles_by_symbol: Optional[dict[str, list[CandleClose]]] = None,
) -> dict[str, list[SimulatedTrade]]:
    """Runs simulate_trades once per symbol (each with its own bias_fn
    built from that symbol's own signal timestamps) against the SAME
    exit_config - the by-symbol shape simulate_external_signals below
    flattens for the grid search (which never needs to know which symbol
    a trade came from), and that the /backtest-signals/trades route uses
    directly to attach a symbol to each individual trade in its response.
    min_bars is always 1 here - unlike an indicator-based bias_fn, this
    one needs no warm-up window at all (the first candle in the series
    can already be a signal's own entry point)."""
    by_symbol: dict[str, list[SimulatedTrade]] = {}
    for symbol, timestamps in signals_by_symbol.items():
        candles = candles_by_symbol.get(symbol)
        if not candles:
            continue
        bias_fn = _bias_fn_from_signal_timestamps(sorted(timestamps), direction)
        sl_candles = (sl_candles_by_symbol or {}).get(symbol)
        by_symbol[symbol] = simulate_trades(bias_fn, 1, candles, exit_config, sl_candles)
    return by_symbol


def simulate_external_signals(
    signals_by_symbol: dict[str, list[str]],
    direction: Bias,
    candles_by_symbol: dict[str, list[CandleClose]],
    exit_config: Optional[ExitConfig] = None,
    sl_candles_by_symbol: Optional[dict[str, list[CandleClose]]] = None,
) -> list[SimulatedTrade]:
    """Pools simulate_external_signals_by_symbol's per-symbol trades into
    one flat list - exactly the shape win_rate/max_drawdown/sum(t.pnl...)
    already consume, so "one exit config's aggregate performance across
    every signal in the CSV" needs no new aggregation logic, just feeding
    this return value into those same functions."""
    by_symbol = simulate_external_signals_by_symbol(
        signals_by_symbol, direction, candles_by_symbol, exit_config, sl_candles_by_symbol
    )
    return [trade for trades in by_symbol.values() for trade in trades]


def expand_exit_grid(
    stop_loss_values: list[float | dict],
    target_percent_grid: list[Optional[float]],
    trailing_grid: list[bool],
) -> list[dict]:
    """Cartesian product of the three exit dimensions this backtest sweeps
    - stop_loss_values is either a list of candidate stop_loss_percent
    floats (stop_loss_method='percent') or a list of candidate
    stop_loss_indicator_params dicts (stop_loss_method='indicator'); the
    caller (route layer) already knows which, this just treats each
    element opaquely and puts it under the right ExitConfig field name
    when building each combo (see build_exit_configs below) - kept as a
    plain list here rather than typed per-method, mirroring backtest.py's
    own expand_stop_loss_grid/expand_grid split between "what varies" and
    "what it means." target_percent_grid may contain None (no target, SL/
    opposite-signal/end-of-data exit only) alongside real values, same
    "sweep whether a dimension is even used" allowance trailing_grid
    already has via its own True/False list. Raises ValueError if the
    total exceeds MAX_GRID_COMBINATIONS, same cap every other grid search
    in this codebase uses."""
    combos = list(itertools.product(stop_loss_values, target_percent_grid, trailing_grid))
    if not combos:
        raise ValueError("stop_loss_values, target_percent_grid, and trailing_grid must each have at least one value")
    if len(combos) > MAX_GRID_COMBINATIONS:
        raise ValueError(
            f"exit grid would run {len(combos)} combinations - max is {MAX_GRID_COMBINATIONS}, narrow one of the grids"
        )
    return [{"stop_loss_value": sl, "target_percent": tp, "trailing_stop_enabled": tr} for sl, tp, tr in combos]


def build_exit_config(
    combo: dict,
    stop_loss_method: Optional[str],
    stop_loss_indicator_type: Optional[str],
    square_off_time=None,
) -> ExitConfig:
    """Turns one expand_exit_grid combo into a real ExitConfig -
    stop_loss_method/stop_loss_indicator_type are fixed across the whole
    grid (only the VALUE varies per combo, same "one method per request"
    rule backtest.py's own grid_search already enforces), so they're
    passed straight through rather than swept. stop_loss_method=
    'previous_candle' has no combo-level VALUE at all (its "value" is
    which candle series simulate_trades checks against, i.e. the
    stop_loss_interval choice) - that's threaded through as a separately-
    fetched `sl_candles` series at the simulate_trades call site instead
    of anything on ExitConfig, which has no stop_loss_interval field of
    its own (see that dataclass's own field list)."""
    stop_loss_percent = combo["stop_loss_value"] if stop_loss_method == "percent" else None
    stop_loss_indicator_params = combo["stop_loss_value"] if stop_loss_method == "indicator" else None
    return ExitConfig(
        stop_loss_method=stop_loss_method,
        stop_loss_percent=stop_loss_percent,
        stop_loss_indicator_type=stop_loss_indicator_type,
        stop_loss_indicator_params=stop_loss_indicator_params,
        target_percent=combo["target_percent"],
        trailing_stop_enabled=combo["trailing_stop_enabled"],
        square_off_time=square_off_time,
    )


def grid_search_external_signals(
    signals_by_symbol: dict[str, list[str]],
    direction: Bias,
    candles_by_symbol: dict[str, list[CandleClose]],
    combos: list[dict],
    stop_loss_method: Optional[str],
    stop_loss_indicator_type: Optional[str],
    sl_candles_by_symbol: Optional[dict[str, list[CandleClose]]] = None,
    square_off_time=None,
) -> list[dict]:
    """Runs simulate_external_signals once per combo in `combos` (see
    expand_exit_grid), ranked by hypothetical_pnl descending - the actual
    "which exit setup would have worked best for these signals" report.
    stop_loss_method='previous_candle' needs sl_candles_by_symbol already
    fetched at the right interval by the caller (see build_exit_config's
    own docstring) - this function doesn't otherwise need to know which
    interval that was."""
    results = []
    for combo in combos:
        exit_config = build_exit_config(combo, stop_loss_method, stop_loss_indicator_type, square_off_time)
        trades = simulate_external_signals(signals_by_symbol, direction, candles_by_symbol, exit_config, sl_candles_by_symbol)
        results.append(
            {
                "stop_loss_value": combo["stop_loss_value"],
                "target_percent": combo["target_percent"],
                "trailing_stop_enabled": combo["trailing_stop_enabled"],
                "trade_count": len(trades),
                "hypothetical_pnl": sum(t.pnl for t in trades),
                "win_rate": win_rate(trades),
                "max_drawdown": max_drawdown(trades),
            }
        )
    results.sort(key=lambda r: r["hypothetical_pnl"], reverse=True)
    return results
