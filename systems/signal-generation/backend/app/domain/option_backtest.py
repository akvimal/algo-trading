"""Backtesting single/multi-leg option strategies (Phase 4c of the
options trading module - see docs/architecture.md). Reuses backtest.py's
signal-timing machinery UNCHANGED: simulate_trades, run with no SL/target
configured (only square_off_time/opposite-signal/end-of-data closing),
finds candidate entry windows on the underlying exactly like a spot
backtest would. Each window is then re-simulated against a synthetic
COMBINED premium series (long leg close - short leg close) instead of
the underlying's own price.

Key insight that keeps this small: a bull-call-spread's combined premium
(long_CE - short_CE) behaves exactly like a single "bullish" instrument
price - it rises as the underlying rises, for the same reason the real
spread profits. A bear-put-spread's combined premium (long_PE - short_PE)
behaves the same way (rises as the underlying falls, i.e. as the
position's own thesis plays out) - algebraically,
combined_pnl(t) = (long(t)-long_entry) + (short_entry-short(t))
                = combined_price(t) - combined_entry,
identical in shape to a single long position's P&L. So both templates
reuse backtest.py's own _stop_loss_percent_price/_target_percent_price/
_pnl UNCHANGED, always called with direction="bullish", against the
synthetic combined series - no new percent-math needed. The REPORTED
`direction` on each trade is still the original signal's bullish/bearish
(which template got used), not this internal trick.

Crossover-rule strategies only in this phase (matches the existing
/backtest/grid scope) - see app/api/routes/strategies.py's
_backtest_one_symbol for where this is wired in and why breakout/
range_breakout aren't yet. Does not simulate the live OI-liquidity nudge
(Phase 4b's MIN_SHORT_LEG_OI rule in signal-processing's
option_templates.py, a different system - not importable here, see
docs/architecture.md) - the short leg is always exactly
SPREAD_WIDTH_STRIKES out, a documented simplification (an OI-based nudge
would need per-bar OI comparison across several strikes, multiplying the
number of rollingoption series fetched)."""

from typing import Callable, Optional

from app.domain.backtest import BiasFn, ExitConfig, _pnl, _stop_loss_percent_price, _target_percent_price, simulate_trades
from app.domain.rules import Bias, CandleClose

# Mirrors signal-processing's option_templates.py SPREAD_WIDTH_STRIKES
# (duplicated, not imported - no cross-system imports between systems/*).
SPREAD_WIDTH_STRIKES = 2
# Dhan-native 5min granularity for leg price tracking - independent of
# whatever interval the underlying strategy itself uses for its own
# indicator (that can be a locally-aggregated "Nmin" shape rollingoption
# doesn't support at all).
OPTION_HISTORY_INTERVAL = "5"
# Bounds total rollingoption calls a single backtest request can trigger -
# ~180/30 chunks * 2 legs = 12 calls in the worst case, same "keep a
# single request lightweight" philosophy as backtest.py's own
# MAX_GRID_COMBINATIONS.
MAX_OPTION_BACKTEST_DAYS = 180

# (option_type, strike) -> the full pre-fetched series for that leg across
# the WHOLE backtest range - callers (app/api/routes/strategies.py) fetch
# each distinct leg at most once per request and memoize, so this is
# never re-fetched per trade window; simulate_option_trades below only
# slices the already-fetched series per window.
LegFetcher = Callable[[str, str], Optional[list[CandleClose]]]


def legs_for_direction(direction: Bias) -> tuple[str, str, str]:
    """(option_type, long_strike, short_strike) for the fixed bias-
    >template this mirrors from signal-processing's option_templates.py:
    BUY/bullish -> bull call spread (long ATM call, short a further-OTM
    call = a HIGHER strike, "ATM+N"); SELL/bearish -> bear put spread
    (long ATM put, short a further-OTM put = a LOWER strike, "ATM-N")."""
    if direction == "bullish":
        return "CE", "ATM", f"ATM+{SPREAD_WIDTH_STRIKES}"
    return "PE", "ATM", f"ATM-{SPREAD_WIDTH_STRIKES}"


def _slice_window(candles: list[CandleClose], start: str, end: str) -> list[CandleClose]:
    return [c for c in candles if start <= c.timestamp <= end]


def combined_series(long_candles: list[CandleClose], short_candles: list[CandleClose]) -> list[CandleClose]:
    """Synthetic single-instrument series: close = long.close - short.close
    (the net debit at that bar); high (best case for the position) =
    long.high - short.low; low (worst case) = long.low - short.high - the
    standard conservative intrabar-extremes assumption for a 2-leg combo
    (true intraday correlation between the two legs isn't knowable from
    OHLC alone, so the least favorable joint excursion is assumed for SL
    detection, extending _simulate_one_trade's own bar.high/bar.low check
    to two legs). Bars are joined by matching timestamp - a bar present on
    one leg but not the other (e.g. an illiquid strike with a data gap) is
    dropped, not interpolated."""
    short_by_ts = {c.timestamp: c for c in short_candles}
    combined = []
    for long_c in long_candles:
        short_c = short_by_ts.get(long_c.timestamp)
        if short_c is None:
            continue
        combined.append(
            CandleClose(
                timestamp=long_c.timestamp,
                close=long_c.close - short_c.close,
                high=long_c.high - short_c.low,
                low=long_c.low - short_c.high,
            )
        )
    return combined


def _simulate_one_combined_trade(combined: list[CandleClose], direction: Bias, outer_exit_reason: str, exit_config: ExitConfig) -> dict:
    """Mirrors backtest.py's _simulate_one_trade, scanning `combined`
    (already sliced to one candidate window) for a combined SL/target hit,
    direction='bullish' always (see module docstring) - `direction` here
    is only for the REPORTED trade, not the P&L math. Falls through to
    `outer_exit_reason` (inherited from the underlying-driven Phase-1
    window that bounded this simulation - square_off/opposite_signal/
    end_of_data) if nothing closes it first."""
    entry_candle = combined[0]
    entry_price = entry_candle.close

    stop_loss_price = (
        _stop_loss_percent_price("bullish", entry_price, exit_config.stop_loss_percent)
        if exit_config.stop_loss_percent is not None
        else None
    )
    target_price = (
        _target_percent_price("bullish", entry_price, exit_config.target_percent)
        if exit_config.target_percent is not None
        else None
    )

    for bar in combined[1:]:
        sl_hit = stop_loss_price is not None and bar.low <= stop_loss_price
        target_hit = target_price is not None and bar.high >= target_price
        if sl_hit or target_hit:
            exit_price = stop_loss_price if sl_hit else target_price
            reason = "combined_stop_loss" if sl_hit else "combined_target"
            return {
                "entry_time": entry_candle.timestamp,
                "direction": direction,
                "entry_price": entry_price,
                "exit_time": bar.timestamp,
                "exit_price": exit_price,
                "exit_reason": reason,
                "pnl": _pnl("bullish", entry_price, exit_price),
            }

    last = combined[-1]
    return {
        "entry_time": entry_candle.timestamp,
        "direction": direction,
        "entry_price": entry_price,
        "exit_time": last.timestamp,
        "exit_price": last.close,
        "exit_reason": outer_exit_reason,
        "pnl": _pnl("bullish", entry_price, last.close),
    }


def simulate_option_trades(
    bias_fn: BiasFn,
    min_bars: int,
    candles: list[CandleClose],
    expiry_flag: str,
    exit_config: ExitConfig,
    leg_fetcher: LegFetcher,
) -> list[dict]:
    """Phase 1: reuse simulate_trades UNCHANGED with no SL/target
    configured (only square_off_time/opposite-signal/end-of-data closing)
    - each returned SimulatedTrade's (entry_time, direction, exit_time,
    exit_reason) is a candidate window a fresh option position would need
    to close by, computed purely from the underlying's own signal timing.
    Phase 2: per window, legs_for_direction(direction) picks which leg
    pair to track; leg_fetcher(option_type, strike) returns each leg's
    FULL pre-fetched range (memoized by the caller, not re-fetched here),
    sliced down to [window.entry_time, window.exit_time] and combined via
    combined_series, then _simulate_one_combined_trade finds where the
    COMBINED premium actually closes (possibly earlier than the window's
    own boundary, via combined SL/target).
    A window with no resolvable/overlapping leg data (both legs 404, or
    no bars fall inside the window - e.g. an illiquid contract) is
    skipped, not failed - same "one bad case doesn't abort the whole
    backtest" philosophy as _backtest_universe's per-constituent handling.
    Returns the same trade dict shape replay() already produces
    (entry_time/direction/entry_price/exit_time/exit_price/exit_reason/
    pnl) plus a `legs` field - entry_price/exit_price here are the
    COMBINED premium, not the underlying's price."""
    windows = simulate_trades(bias_fn, min_bars, candles, ExitConfig(square_off_time=exit_config.square_off_time))

    trades: list[dict] = []
    for window in windows:
        option_type, long_strike, short_strike = legs_for_direction(window.direction)
        long_full = leg_fetcher(option_type, long_strike)
        short_full = leg_fetcher(option_type, short_strike)
        if not long_full or not short_full:
            continue

        combined = combined_series(
            _slice_window(long_full, window.entry_time, window.exit_time),
            _slice_window(short_full, window.entry_time, window.exit_time),
        )
        if not combined:
            continue

        trade = _simulate_one_combined_trade(combined, window.direction, window.exit_reason, exit_config)
        trades.append(
            {
                **trade,
                "legs": {
                    "option_type": option_type,
                    "long_strike": long_strike,
                    "short_strike": short_strike,
                    "expiry_flag": expiry_flag,
                },
            }
        )
    return trades


def replay_options(
    bias_fn: BiasFn,
    min_bars: int,
    candles: list[CandleClose],
    expiry_flag: str,
    exit_config: ExitConfig,
    leg_fetcher: LegFetcher,
) -> dict:
    """The route-facing report - mirrors backtest.py's own replay()
    exactly, over simulate_option_trades' trades instead of
    simulate_trades'."""
    trades = simulate_option_trades(bias_fn, min_bars, candles, expiry_flag, exit_config, leg_fetcher)
    return {
        "trade_count": len(trades),
        "hypothetical_pnl": sum(t["pnl"] for t in trades),
        "trades": trades,
    }
