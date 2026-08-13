"""Multi-timeframe Donchian breakout rule - a structurally separate rule
family from app/domain/rules.py's crossover machinery ("an indicator
produces a series, a rule decides from that series"): there's no Indicator
involved here at all, it needs TWO candle series (a higher timeframe for
setup, a lower timeframe for the actual trigger) instead of one, and its
exits (a static initial stop plus a reversal condition) are intrinsic to
the rule itself rather than expressible via backtest.py's generic
ExitConfig. Parallel in spirit to how app/domain/regime.py stayed separate
from indicators.py/rules.py for the same "doesn't fit the existing
contract" reason.

The strategy (see app/domain/models.py's BreakoutRuleConfig for the exact
params):
- HTF setup: a completed HTF candle closes above the highest HIGH (or
  below the lowest LOW) of the previous `htf_breakout_period` HTF candles
  (a Donchian breakout), and, if `ema_filter_enabled`, its close is also
  above (below) EMA(ema_period) computed on HTF closes. This "arms" an
  entry window valid only until the NEXT HTF candle closes - if nothing
  triggers within that window, the arm simply expires (never carried
  forward). A newer HTF candle confirming again before the pending arm
  triggers replaces it outright (same reference-and-expiry move) - this
  falls out naturally from just overwriting the pending arm each time,
  no special-case "reset" logic needed.
- LTF trigger: while armed, the first LTF candle to close beyond its OWN
  Donchian channel (`ltf_breakout_period`) in the armed direction opens
  the position. Initial stop = the confirming HTF candle's low (long) or
  high (short), set once at entry, never recalculated.
- Reversal exit: while a position is open, watches every subsequent HTF
  candle for a single-bar flip (close below the previous HTF candle's
  close, for a long - the mirror for a short) - NOT an N-bar breakout,
  deliberately asymmetric with entry. Arms the same expire-at-next-HTF-
  close window; the first LTF candle to close beyond that HTF candle's
  low (long) / high (short) closes the position. Never opens an opposite
  position - closes only.

Live enforcement gap (deliberate, see docs/architecture.md): execution's
real position-closing has no mechanism for the reversal exit - only
`previous_candle`/`percent` stop-loss, a flat target%, and square-off. The
initial stop IS enforced live, by reusing execution's existing
`previous_candle` method with `stop_loss_interval` set to this rule's own
`htf_interval` (see app/api/routes/strategies.py, which auto-sets this at
create time) - the reversal exit only ever runs inside the backtest
simulation here."""

from dataclasses import dataclass
from datetime import datetime, time
from typing import Optional

from app.domain.rule import BreakoutRuleConfig
from app.domain.regime import compute_ema
from app.domain.rules import Bias, CandleClose, SimulatedTrade


def compute_donchian_high(values: list[float], period: int) -> list[Optional[float]]:
    """The rolling max of the PRIOR `period` values (excluding the current
    bar) - `donchian[i] = max(values[i-period:i])` for `i >= period`, else
    None. Non-repainting by construction: index i's value never depends on
    index i itself."""
    n = len(values)
    result: list[Optional[float]] = [None] * n
    for i in range(period, n):
        result[i] = max(values[i - period : i])
    return result


def compute_donchian_low(values: list[float], period: int) -> list[Optional[float]]:
    n = len(values)
    result: list[Optional[float]] = [None] * n
    for i in range(period, n):
        result[i] = min(values[i - period : i])
    return result


def breakout_warmup(rule: BreakoutRuleConfig) -> tuple[int, int]:
    """(htf_bars, ltf_bars) needed before this rule can produce anything -
    same "coarse over-estimate, extra empty bars cost nothing" philosophy
    engine.history_window/regime.regime_warmup already use."""
    htf_bars = max(rule.htf_breakout_period, rule.ema_period if rule.ema_filter_enabled else 0) + 2
    ltf_bars = rule.ltf_breakout_period + 1
    return htf_bars, ltf_bars


@dataclass
class _PendingArm:
    direction: Bias
    ref_htf_index: int
    level: float  # the price level the LTF trigger must break (for exit arms only; entry arms use the LTF's own Donchian channel instead)


def _htf_entry_arm(
    rule: BreakoutRuleConfig,
    htf_candles: list[CandleClose],
    htf_donchian_high: list[Optional[float]],
    htf_donchian_low: list[Optional[float]],
    htf_ema: Optional[list[Optional[float]]],
    k: int,
) -> Optional[Bias]:
    """Does htf_candles[k] arm a fresh entry? None if not (or not enough
    data yet)."""
    close = htf_candles[k].close
    dc_high, dc_low = htf_donchian_high[k], htf_donchian_low[k]
    ema_k = htf_ema[k] if htf_ema is not None else None
    if htf_ema is not None and ema_k is None:
        return None

    if dc_high is not None and close > dc_high and (htf_ema is None or close > ema_k):
        return "bullish"
    if dc_low is not None and close < dc_low and (htf_ema is None or close < ema_k):
        return "bearish"
    return None


def _htf_reversal_arm(htf_candles: list[CandleClose], position_direction: Bias, k: int) -> Optional[float]:
    """Does htf_candles[k] arm a reversal exit for an open position in
    `position_direction`? Single-bar close-vs-previous-close flip, NOT an
    N-bar breakout (deliberately asymmetric with entry). Returns the level
    (that HTF candle's low/high) the LTF trigger must break, or None."""
    close, prev_close = htf_candles[k].close, htf_candles[k - 1].close
    if position_direction == "bullish" and close < prev_close:
        return htf_candles[k].low
    if position_direction == "bearish" and close > prev_close:
        return htf_candles[k].high
    return None


def _ltf_in_window(ltf_candles: list[CandleClose], window_start: str, window_end: str) -> list[tuple[int, CandleClose]]:
    start_dt, end_dt = datetime.fromisoformat(window_start), datetime.fromisoformat(window_end)
    return [
        (i, c)
        for i, c in enumerate(ltf_candles)
        if start_dt <= datetime.fromisoformat(c.timestamp) < end_dt
    ]


def _close(entry_time: str, direction: Bias, entry_price: float, exit_time: str, exit_price: float, reason: str) -> SimulatedTrade:
    pnl = exit_price - entry_price if direction == "bullish" else entry_price - exit_price
    return SimulatedTrade(entry_time, direction, entry_price, exit_time, exit_price, reason, pnl)


def simulate_breakout_trades(
    rule: BreakoutRuleConfig,
    htf_candles: list[CandleClose],
    ltf_candles: list[CandleClose],
    square_off_time: Optional[time] = None,
) -> list[SimulatedTrade]:
    """`htf_candles`/`ltf_candles` must each be oldest-first, completed
    bars only, both covering the full range to backtest plus enough
    warm-up (see breakout_warmup). Walks HTF candles bar by bar; for each,
    checks for a fresh entry arm (while flat) or reversal arm (while in a
    position) - overwriting any still-pending arm from an earlier bar
    (this is the "a newer confirmation replaces the old one" rule) - then
    scans the LTF candles falling within [htf[k], htf[k+1]) for a trigger.
    An arm that doesn't trigger within that window is simply not carried
    into the next iteration (expiry)."""
    htf_highs = [c.high for c in htf_candles]
    htf_lows = [c.low for c in htf_candles]
    htf_closes = [c.close for c in htf_candles]
    htf_donchian_high = compute_donchian_high(htf_highs, rule.htf_breakout_period)
    htf_donchian_low = compute_donchian_low(htf_lows, rule.htf_breakout_period)
    htf_ema = compute_ema(htf_closes, rule.ema_period) if rule.ema_filter_enabled else None

    ltf_highs = [c.high for c in ltf_candles]
    ltf_lows = [c.low for c in ltf_candles]
    ltf_closes = [c.close for c in ltf_candles]
    ltf_donchian_high = compute_donchian_high(ltf_highs, rule.ltf_breakout_period)
    ltf_donchian_low = compute_donchian_low(ltf_lows, rule.ltf_breakout_period)

    trades: list[SimulatedTrade] = []
    position: Optional[dict] = None  # {"direction", "entry_price", "entry_time", "initial_stop"}
    pending_entry: Optional[_PendingArm] = None
    pending_exit: Optional[_PendingArm] = None

    n_htf = len(htf_candles)
    for k in range(0, n_htf - 1):
        if htf_donchian_high[k] is None and htf_donchian_low[k] is None:
            continue  # not warmed up yet

        if position is None:
            direction = _htf_entry_arm(rule, htf_candles, htf_donchian_high, htf_donchian_low, htf_ema, k)
            if direction is not None:
                pending_entry = _PendingArm(direction, k, 0.0)  # level unused for entry arms
        else:
            level = _htf_reversal_arm(htf_candles, position["direction"], k)
            if level is not None:
                pending_exit = _PendingArm(position["direction"], k, level)

        window = _ltf_in_window(ltf_candles, htf_candles[k].timestamp, htf_candles[k + 1].timestamp)
        for ltf_idx, bar in window:
            if position is not None:
                sl_hit = (position["direction"] == "bullish" and bar.low <= position["initial_stop"]) or (
                    position["direction"] == "bearish" and bar.high >= position["initial_stop"]
                )
                if sl_hit:
                    trades.append(
                        _close(position["entry_time"], position["direction"], position["entry_price"], bar.timestamp, position["initial_stop"], "initial_stop_loss")
                    )
                    position = None
                    pending_exit = None
                    continue

                if square_off_time is not None and datetime.fromisoformat(bar.timestamp).time() >= square_off_time:
                    trades.append(
                        _close(position["entry_time"], position["direction"], position["entry_price"], bar.timestamp, bar.close, "square_off")
                    )
                    position = None
                    pending_exit = None
                    continue

                if pending_exit is not None and pending_exit.ref_htf_index == k:
                    triggered = (position["direction"] == "bullish" and bar.close < pending_exit.level) or (
                        position["direction"] == "bearish" and bar.close > pending_exit.level
                    )
                    if triggered:
                        trades.append(
                            _close(position["entry_time"], position["direction"], position["entry_price"], bar.timestamp, bar.close, "reversal_exit")
                        )
                        position = None
                        pending_exit = None
            else:
                if pending_entry is not None and pending_entry.ref_htf_index == k:
                    dc_high, dc_low = ltf_donchian_high[ltf_idx], ltf_donchian_low[ltf_idx]
                    triggered = (
                        pending_entry.direction == "bullish" and dc_high is not None and bar.close > dc_high
                    ) or (pending_entry.direction == "bearish" and dc_low is not None and bar.close < dc_low)
                    if triggered:
                        initial_stop = htf_candles[k].low if pending_entry.direction == "bullish" else htf_candles[k].high
                        position = {
                            "direction": pending_entry.direction,
                            "entry_price": bar.close,
                            "entry_time": bar.timestamp,
                            "initial_stop": initial_stop,
                        }
                        pending_entry = None

        # Arms are only ever valid within bar k's own window - anything
        # still referencing k here didn't trigger and is dropped (expiry).
        if pending_entry is not None and pending_entry.ref_htf_index == k:
            pending_entry = None
        if pending_exit is not None and pending_exit.ref_htf_index == k:
            pending_exit = None

    if position is not None and ltf_candles:
        last = ltf_candles[-1]
        trades.append(_close(position["entry_time"], position["direction"], position["entry_price"], last.timestamp, last.close, "end_of_data"))

    return trades


def replay_breakout(
    rule: BreakoutRuleConfig,
    htf_candles: list[CandleClose],
    ltf_candles: list[CandleClose],
    square_off_time: Optional[time] = None,
) -> dict:
    """Route-facing report, same shape as backtest.replay's."""
    trades = simulate_breakout_trades(rule, htf_candles, ltf_candles, square_off_time)
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


def evaluate_breakout_live(
    rule: BreakoutRuleConfig, htf_candles: list[CandleClose], ltf_candles: list[CandleClose]
) -> Optional[tuple[Bias, str]]:
    """The live engine's simpler special case: only the LATEST completed
    HTF candle can still have an unexpired entry arm (anything older has
    already expired per the "valid only until next HTF close" rule), so
    this checks only htf_candles[-1] for a fresh arm, then only the
    LATEST LTF candle for a trigger. Returns (bias, ltf_candle.timestamp)
    on a fresh trigger - the timestamp is what engine_runs.
    last_signal_candle_ts dedupes against, same column crossover
    strategies already use. Entry-only (no reversal exit - see module
    docstring's "live enforcement gap")."""
    if len(htf_candles) < 2 or not ltf_candles:
        return None

    htf_highs = [c.high for c in htf_candles]
    htf_lows = [c.low for c in htf_candles]
    htf_closes = [c.close for c in htf_candles]
    htf_donchian_high = compute_donchian_high(htf_highs, rule.htf_breakout_period)
    htf_donchian_low = compute_donchian_low(htf_lows, rule.htf_breakout_period)
    htf_ema = compute_ema(htf_closes, rule.ema_period) if rule.ema_filter_enabled else None

    k = len(htf_candles) - 1
    direction = _htf_entry_arm(rule, htf_candles, htf_donchian_high, htf_donchian_low, htf_ema, k)
    if direction is None:
        return None

    ltf_highs = [c.high for c in ltf_candles]
    ltf_lows = [c.low for c in ltf_candles]
    ltf_donchian_high = compute_donchian_high(ltf_highs, rule.ltf_breakout_period)
    ltf_donchian_low = compute_donchian_low(ltf_lows, rule.ltf_breakout_period)

    latest = ltf_candles[-1]
    dc_high, dc_low = ltf_donchian_high[-1], ltf_donchian_low[-1]
    if direction == "bullish" and dc_high is not None and latest.close > dc_high:
        return "bullish", latest.timestamp
    if direction == "bearish" and dc_low is not None and latest.close < dc_low:
        return "bearish", latest.timestamp
    return None
