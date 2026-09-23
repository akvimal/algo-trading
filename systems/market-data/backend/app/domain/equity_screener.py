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

from app.domain.models import Candle
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
    )
