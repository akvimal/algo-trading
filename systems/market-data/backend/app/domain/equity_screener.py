"""Pure computation for the EOD equity screener (GET /equity-screener) -
turns one NSE stock's own trailing daily-bar history into that day's
momentum/trend + 52-week-proximity read. Kept separate from
app/scheduler.py's _record_equity_screener_snapshot (which does the
actual Dhan fetch + DB read/write) so this is unit-testable without a
live provider/DB session - same "pure core, thin job" split
app/domain/oi_summary.py and app/domain/oi_buildup.py already use.

Unlike the OI-buildup screener (day-over-day diff against ONE previous
DB row), this reuses Dhan's own charts/historical endpoint AS the
history store - real daily bars going back years, one request per
symbol, no chunking needed (see app/providers/dhan.py's
_fetch_historical_candles). So every metric here is recomputed fresh
each day from a trailing window of real candles, not diffed against our
own yesterday's row - this module never needs to know what "yesterday"
computed.

Trend/momentum reuses app/domain/regime.py's existing assess_regime
(the same ADX+structure read backing the Live Chart's regime badge)
rather than a second, drifting implementation - "regime"/"adx"/"trend"
below are exactly its own fields.
"""

from dataclasses import dataclass
from typing import Literal, Optional

from app.domain.indicators import compute_ema
from app.domain.models import Candle
from app.domain.order_blocks import _atr
from app.domain.regime import _MIN_BARS, assess_regime

# How close (as a % of the 52-week extreme itself) counts as "near" - not
# derived from anything, a reasonable starting bucket like sentiment.py's
# own _MILD/_STRONG thresholds.
NEAR_52W_THRESHOLD_PCT = 3.0

# 52-week high/low needs a real year of trading days to mean what its
# name says - a stock with only e.g. 60 days of history would otherwise
# report its own short trading life's max/min mislabeled as "52-week".
MIN_BARS_FOR_52W_PROXIMITY = 200

Proximity = Literal["near_52w_high", "near_52w_low"]

# Turnover is shown in Rs crore; the screener's "liquid" cut-off (a stock a swing trader can get out of) is Rs 5 Cr a day.
CRORE = 1e7
LIQUID_MIN_CR = 5.0
TURNOVER_DAYS = 20


@dataclass
class EquityScreenerCompute:
    close: float
    pct_change_5d: Optional[float]
    pct_change_20d: Optional[float]
    adx: float
    regime: Literal["trending_up", "trending_down", "ranging", "transitional"]
    trend: Literal["up", "down", "range"]
    high_52w: Optional[float]
    low_52w: Optional[float]
    # <=0 (0 = sitting exactly at the 52w high); None if
    # MIN_BARS_FOR_52W_PROXIMITY isn't met.
    pct_from_52w_high: Optional[float]
    # >=0 (0 = sitting exactly at the 52w low); None under the same condition.
    pct_from_52w_low: Optional[float]
    # None whenever neither extreme is close enough (the common case,
    # "mid-range") - not a third enum value, same "None means nothing to
    # flag" convention as oi_summary.py's own buildup classification.
    proximity: Optional[Proximity]
    # Descriptive fields for filtering and sorting (added 2026-10-08). None when there are too few bars, so a young listing simply has no value.
    avg_turnover_cr: Optional[float] = None  # 20-day average of close x volume, in Rs crore
    ret_3m_pct: Optional[float] = None  # close against 63 bars earlier
    mom_12_1_pct: Optional[float] = None  # the close a month ago against the close a year ago: the "12-1" momentum score (the latest month is skipped)
    rsi3: Optional[float] = None  # 3-period RSI, a very short-term oversold/overbought read (0-100)
    dist_ema20_pct: Optional[float] = None  # how far the close is above (+) or below (-) its 20-day EMA
    atr_pct: Optional[float] = None  # 14-day average true range as a % of the close: how far it typically moves in a day
    vol_ratio: Optional[float] = None  # today's volume against the average of the 20 days before


def _rsi3(closes: list[float]) -> Optional[float]:
    """Wilder-style 3-period RSI over the whole series (smoothing factor 1/3), None when flat or too short."""
    if len(closes) < 5:
        return None
    up = down = None
    for prev, cur in zip(closes, closes[1:]):
        gain, loss = max(cur - prev, 0.0), max(prev - cur, 0.0)
        up, down = (gain, loss) if up is None else (up * 2 / 3 + gain / 3, down * 2 / 3 + loss / 3)
    if not down:
        return 100.0 if up else None
    return round(100 - 100 / (1 + up / down), 2)


def swing_fields(candles: list[Candle]) -> dict:
    """The descriptive filter/sort fields above, from the same trailing daily bars (oldest-first)."""
    n = len(candles)
    closes = [c.close for c in candles]
    close = closes[-1]
    out: dict = {}
    if n >= TURNOVER_DAYS:
        out["avg_turnover_cr"] = round(sum(c.close * c.volume for c in candles[-TURNOVER_DAYS:]) / TURNOVER_DAYS / CRORE, 3)
    if n >= 64:
        out["ret_3m_pct"] = (close / closes[-64] - 1) * 100
    if n >= 253:
        out["mom_12_1_pct"] = (closes[-22] / closes[-253] - 1) * 100
    out["rsi3"] = _rsi3(closes)
    ema20 = compute_ema(closes, 20)[-1]
    if ema20:
        out["dist_ema20_pct"] = (close / ema20 - 1) * 100
    if n >= 15 and close:
        out["atr_pct"] = _atr([c.high for c in candles], [c.low for c in candles], closes, 14) / close * 100
    if n >= 21:
        before = [c.volume for c in candles[-21:-1]]
        if sum(before):
            out["vol_ratio"] = candles[-1].volume / (sum(before) / len(before))
    return out


def compute_equity_screener_row(candles: list[Candle]) -> Optional[EquityScreenerCompute]:
    """`candles` is oldest-first, completed daily bars (whatever trailing
    window the job fetched - see its own comment for why ~1 calendar
    year). None if there isn't even enough history for a real ADX read
    (same _MIN_BARS floor assess_regime itself enforces) - a symbol this
    thin has nothing useful to report yet, skipped for the day rather
    than emitting a placeholder row."""
    if len(candles) < _MIN_BARS:
        return None

    closes = [c.close for c in candles]
    close = closes[-1]
    pct_change_5d = ((close - closes[-6]) / closes[-6] * 100) if len(closes) >= 6 else None
    pct_change_20d = ((close - closes[-21]) / closes[-21] * 100) if len(closes) >= 21 else None

    regime = assess_regime(candles)

    high_52w: Optional[float] = None
    low_52w: Optional[float] = None
    pct_from_52w_high: Optional[float] = None
    pct_from_52w_low: Optional[float] = None
    proximity: Optional[Proximity] = None
    if len(candles) >= MIN_BARS_FOR_52W_PROXIMITY:
        window = candles[-252:]  # ~52 weeks of trading days, capped to whatever's available
        high_52w = max(c.high for c in window)
        low_52w = min(c.low for c in window)
        pct_from_52w_high = (close - high_52w) / high_52w * 100
        pct_from_52w_low = (close - low_52w) / low_52w * 100
        if pct_from_52w_high >= -NEAR_52W_THRESHOLD_PCT:
            proximity = "near_52w_high"
        elif pct_from_52w_low <= NEAR_52W_THRESHOLD_PCT:
            proximity = "near_52w_low"

    return EquityScreenerCompute(
        close=close,
        pct_change_5d=pct_change_5d,
        pct_change_20d=pct_change_20d,
        adx=regime.adx,
        regime=regime.regime,
        trend=regime.trend,
        high_52w=high_52w,
        low_52w=low_52w,
        pct_from_52w_high=pct_from_52w_high,
        pct_from_52w_low=pct_from_52w_low,
        proximity=proximity,
        **swing_fields(candles),
    )


def percentile_ranks(values: dict[str, Optional[float]]) -> dict[str, float]:
    """0-100 rank for each symbol with a value (100 = the highest), ties sharing their average rank; symbols without one are left out."""
    have = sorted((v, k) for k, v in values.items() if v is not None)
    n = len(have)
    if n == 0:
        return {}
    out: dict[str, float] = {}
    i = 0
    while i < n:
        j = i
        while j + 1 < n and have[j + 1][0] == have[i][0]:
            j += 1
        rank = 100.0 * ((i + j) / 2) / (n - 1) if n > 1 else 100.0
        for k in range(i, j + 1):
            out[have[k][1]] = round(rank, 1)
        i = j + 1
    return out
