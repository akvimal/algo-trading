"""Pure timeframe/indicator building blocks for the (upcoming) custom equity
screener - resampling daily bars to weekly, EMA, and rolling N-period
high/low. Deliberately generic (arbitrary period/window, not a fixed
preset) since the screener is meant to evaluate an arbitrary user-typed
expression ("weekly close < min(low, 20w)", "ema(5,1d) crosses_below
ema(20,1d)") against it - a fixed set of precomputed columns would only
ever support whatever periods someone thought to precompute. Kept
completely separate from any DB/provider concern (same "pure core" split
app/domain/equity_screener.py and app/domain/oi_summary.py already use)
so it is unit-testable without a session or a live quote.

compute_ema mirrors execution's own app/domain/position_manager.py /
exit_condition.py compute_ema exactly (SMA-seeded, standard k=2/(period+1)
smoothing) - duplicated rather than imported, same "no cross-system
import" boundary every pure indicator in this codebase already respects,
and the same reason exit_condition.py's own copy gives for not importing
position_manager.py's."""

from datetime import date
from typing import Optional

from app.domain.models import Candle


def compute_ema(closes: list[float], period: int) -> list[Optional[float]]:
    """None until the period is filled (seeded with a plain SMA of the
    first `period` closes), then the standard exponential smoothing."""
    n = len(closes)
    ema: list[Optional[float]] = [None] * n
    if period <= 0 or n < period:
        return ema
    seed = sum(closes[:period]) / period
    ema[period - 1] = seed
    k = 2 / (period + 1)
    for i in range(period, n):
        ema[i] = closes[i] * k + ema[i - 1] * (1 - k)
    return ema


def rolling_min(values: list[float], window: int) -> list[Optional[float]]:
    """The trailing `window`-length minimum ending at each index (inclusive)
    - None until the window is filled. O(n) via a simple deque rather than
    O(n*window): this runs across ~2000 symbols in the EOD job, so the
    naive quadratic version is worth avoiding even though window/n are
    both small per symbol."""
    return _rolling(values, window, keep_larger=True)  # a smaller candidate always wins for min


def rolling_max(values: list[float], window: int) -> list[Optional[float]]:
    """The trailing `window`-length maximum ending at each index (inclusive) - None until filled."""
    return _rolling(values, window, keep_larger=False)  # a larger candidate always wins for max


def _rolling(values: list[float], window: int, keep_larger: bool) -> list[Optional[float]]:
    n = len(values)
    out: list[Optional[float]] = [None] * n
    if window <= 0:
        return out
    dq: list[int] = []  # indices into `values`, front is the current extreme
    for i in range(n):
        while dq and (values[dq[-1]] >= values[i] if keep_larger else values[dq[-1]] <= values[i]):
            dq.pop()
        dq.append(i)
        if dq[0] <= i - window:
            dq.pop(0)
        if i >= window - 1:
            out[i] = values[dq[0]]
    return out


def resample_weekly(candles: list[Candle]) -> list[Candle]:
    """Daily bars (oldest-first, any exchange/symbol/provider - carried through
    unchanged) grouped into ISO calendar weeks (Mon-Sun): open of the week's
    first day, close of its last, high/low/volume aggregated across the whole
    week. `interval` becomes "1week"; `timestamp` is the week's first trading
    day (matching every other candle's own "start of the bar" convention) -
    the LAST group in the input may be a partial, still-forming week (today's
    week-to-date), same as how a live daily candle is itself "still forming"
    until the session closes; callers comparing against "the last N complete
    weeks" should drop it themselves if that distinction matters to them."""
    weeks: dict[tuple[int, int], list[Candle]] = {}
    order: list[tuple[int, int]] = []
    for c in candles:
        d = date.fromisoformat(c.timestamp[:10])
        key = d.isocalendar()[:2]  # (iso_year, iso_week)
        if key not in weeks:
            weeks[key] = []
            order.append(key)
        weeks[key].append(c)

    out: list[Candle] = []
    for key in order:
        group = weeks[key]
        out.append(
            Candle(
                exchange=group[0].exchange, symbol=group[0].symbol, interval="1week",
                open=group[0].open, high=max(g.high for g in group), low=min(g.low for g in group), close=group[-1].close,
                volume=sum(g.volume for g in group), timestamp=group[0].timestamp, provider=group[0].provider,
            )
        )
    return out
