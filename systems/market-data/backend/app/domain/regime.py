"""Market-regime read for one candle series - a live discretionary aid
(the Live Chart's regime badge), NOT a Rule filter. signal-engine has its
own richer regime module (ADX / structure / efficiency-ratio / EMA-slope
`IndicatorType`s) that this deliberately does not import (no cross-system
imports); this is a small self-contained ADX + ATR-percentile read that
answers one question - "is this thing trending or chopping right now" -
so a trader can size down or stand aside in chop, where discretionary
accounts bleed most.

Combines Wilder's ADX (trend *strength*), the confirmed BOS/CHoCH trend
from `order_blocks.structure_state` (trend *direction*), and the current
ATR as a percentile of its own recent range (is volatility unusually
high). Deliberately coarse - four buckets, one line of advice."""

from typing import Literal

from app.domain.models import Candle, MarketRegime
from app.domain.order_blocks import structure_state

Regime = Literal["trending_up", "trending_down", "ranging", "transitional"]

_MIN_BARS = 40  # ~2*period + settle for a usable ADX


def _wilder_smooth(values: list[float], period: int) -> list[float]:
    """Wilder's running smoothing: seed with the first `period` sum, then
    prev - prev/period + current. Returns one value per input from index
    `period-1` onward."""
    if len(values) < period:
        return []
    out = [sum(values[:period])]
    for v in values[period:]:
        out.append(out[-1] - out[-1] / period + v)
    return out


def compute_dmi(candles: list[Candle], period: int = 14) -> tuple[float, float, float]:
    """(ADX, +DI, -DI) - the latest values. All 0.0 when there aren't
    enough bars. +DI > -DI = the (Wilder) directional bias is up."""
    n = len(candles)
    if n < 2 * period + 2:
        return 0.0, 0.0, 0.0
    h = [c.high for c in candles]
    lo = [c.low for c in candles]
    cl = [c.close for c in candles]

    plus_dm: list[float] = []
    minus_dm: list[float] = []
    tr: list[float] = []
    for i in range(1, n):
        up = h[i] - h[i - 1]
        down = lo[i - 1] - lo[i]
        plus_dm.append(up if (up > down and up > 0) else 0.0)
        minus_dm.append(down if (down > up and down > 0) else 0.0)
        tr.append(max(h[i] - lo[i], abs(h[i] - cl[i - 1]), abs(lo[i] - cl[i - 1])))

    str_ = _wilder_smooth(tr, period)
    sp = _wilder_smooth(plus_dm, period)
    sm = _wilder_smooth(minus_dm, period)
    if not str_ or not sp or not sm:
        return 0.0, 0.0, 0.0

    dx: list[float] = []
    last_pdi = last_mdi = 0.0
    for t, p, m in zip(str_, sp, sm):
        if t == 0:
            dx.append(0.0)
            continue
        last_pdi = 100 * p / t
        last_mdi = 100 * m / t
        denom = last_pdi + last_mdi
        dx.append(100 * abs(last_pdi - last_mdi) / denom if denom else 0.0)

    adx_series = _wilder_smooth(dx, period)
    if adx_series:
        adx = round(adx_series[-1] / period, 1)
    else:
        adx = round(sum(dx[-period:]) / len(dx[-period:]), 1) if dx else 0.0
    return adx, round(last_pdi, 1), round(last_mdi, 1)


def compute_adx(candles: list[Candle], period: int = 14) -> float:
    return compute_dmi(candles, period)[0]


def atr_percentile(candles: list[Candle], period: int = 14, window: int = 100) -> int:
    """Where the current ATR sits in the distribution of the last `window`
    ATR readings - 0 (calmest in the window) to 100 (most volatile).
    50 when there isn't enough history to rank."""
    n = len(candles)
    if n < period + 5:
        return 50
    h = [c.high for c in candles]
    lo = [c.low for c in candles]
    cl = [c.close for c in candles]
    tr = [max(h[i] - lo[i], abs(h[i] - cl[i - 1]), abs(lo[i] - cl[i - 1])) for i in range(1, n)]
    atrs = [sum(tr[max(0, k - period) : k]) / min(period, k) for k in range(1, len(tr) + 1)]
    recent = atrs[-window:]
    if len(recent) < 5:
        return 50
    current = recent[-1]
    below = sum(1 for a in recent if a <= current)
    return round(100 * below / len(recent))


def assess_regime(candles: list[Candle], *, adx_period: int = 14, swing_lookback: int = 5) -> MarketRegime:
    if len(candles) < _MIN_BARS:
        return MarketRegime(
            regime="transitional",
            adx=0.0,
            atr_percentile=50,
            trend="range",
            advice="Not enough history at this timeframe to read the regime yet.",
        )

    adx, plus_di, minus_di = compute_dmi(candles, adx_period)
    atr_pct = atr_percentile(candles)
    # structure trend is the display value; DMI direction (more robust in
    # a one-sided move with no pullbacks) drives the trending_up/down label.
    trend, _events, _changes = structure_state(candles, swing_lookback=swing_lookback)
    dmi_up = plus_di >= minus_di

    if adx >= 25:
        regime: Regime = "trending_up" if dmi_up else "trending_down"
        advice = f"Trending {'up' if dmi_up else 'down'} (ADX {adx}). Trade with the direction; fading it is low-odds."
    elif adx < 18:
        regime = "ranging"
        advice = f"Ranging (ADX {adx}). Breakouts fail here - fade the edges or stand aside."
    else:
        regime = "transitional"
        advice = f"Transitional (ADX {adx}, trend {trend}). No clean edge - wait for a confirmed break or size down."

    if atr_pct >= 85:
        advice += " Volatility is unusually high - widen stops or cut size."
    elif atr_pct <= 12 and regime == "ranging":
        advice += " Volatility is compressed - a bigger move may be building."

    return MarketRegime(regime=regime, adx=adx, atr_percentile=atr_pct, trend=trend, advice=advice)
