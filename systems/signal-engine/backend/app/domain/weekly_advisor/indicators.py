"""Pure, dependency-light technical indicators over plain OHLCV lists.

No numpy/pandas dependency on purpose — inputs are simple list[float] so this
module is trivially unit-testable with static fixtures and has zero I/O.
Callers pass daily OR weekly bars; nothing here assumes a timeframe.

All functions assume bars are ordered oldest -> newest.

Ported from an external weekly-options-advisor scaffold, with one
confirmed bug fixed before this ever ran against real data: atr()'s
Wilder recursion added the full new true range each step instead of
new_tr/period, so ATR inflated without bound on any series longer than
the warmup window (invisible in the scaffold's own tests, which only
assert series length, never a value range) - reproduced live 2026-09-12
against real NSE weekly bars (ABB: ATR computed as 6218 on a spot of
7274) and against a synthetic constant-true-range fixture that should
hold flat forever but instead diverged every bar. See git history for
the fix (one line, in the `else` branch of atr()'s loop).
"""
from __future__ import annotations

from dataclasses import dataclass
from statistics import fmean
from typing import Literal


# --------------------------------------------------------------------------
# Moving averages
# --------------------------------------------------------------------------

def ema(values: list[float], period: int) -> list[float]:
    """Standard exponential moving average. First `period` values seed with a
    simple average; returns a series the same length as `values` (leading
    entries before the seed are left as the seed value, not NaN, so callers
    can always safely index the last element).
    """
    if len(values) < period:
        raise ValueError(f"need at least {period} values, got {len(values)}")
    k = 2 / (period + 1)
    seed = fmean(values[:period])
    out = [seed] * period
    prev = seed
    for v in values[period:]:
        prev = v * k + prev * (1 - k)
        out.append(prev)
    return out


def sma(values: list[float], period: int) -> list[float]:
    if len(values) < period:
        raise ValueError(f"need at least {period} values, got {len(values)}")
    out = [fmean(values[:period])] * (period - 1)
    window = list(values[:period])
    out.append(fmean(window))
    for v in values[period:]:
        window.pop(0)
        window.append(v)
        out.append(fmean(window))
    return out


# --------------------------------------------------------------------------
# Volatility: ATR / ADX (Wilder smoothing)
# --------------------------------------------------------------------------

def _true_ranges(highs: list[float], lows: list[float], closes: list[float]) -> list[float]:
    trs = [highs[0] - lows[0]]
    for i in range(1, len(closes)):
        trs.append(max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        ))
    return trs


def _wilder_smooth(values: list[float], period: int) -> list[float]:
    out = [None] * (period - 1)
    seed = sum(values[:period])
    out.append(seed)
    prev = seed
    for v in values[period:]:
        prev = prev - (prev / period) + v
        out.append(prev)
    return out  # type: ignore[return-value]


def atr(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> list[float]:
    """Wilder's ATR. Returns a series aligned to input length; first
    `period` entries are the seed average (not None) so `atr(...)[-1]` is
    always safe to read.
    """
    trs = _true_ranges(highs, lows, closes)
    smoothed = _wilder_smooth(trs, period)
    out = []
    running = None
    for i, s in enumerate(smoothed):
        if s is None:
            out.append(fmean(trs[: i + 1]))
            continue
        if running is None:
            running = s / period
        else:
            running = out[-1] - (out[-1] / period) + (trs[i] / period)
        out.append(running if i >= period else s / period)
    return out


@dataclass
class AdxResult:
    adx: list[float]
    plus_di: list[float]
    minus_di: list[float]

    @property
    def slope(self) -> Literal["rising", "falling", "flat"]:
        return adx_slope(self.adx)


def adx(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> AdxResult:
    """Wilder's ADX/+DI/-DI. Same alignment convention as atr(): output
    length matches input length.
    """
    n = len(closes)
    plus_dm = [0.0]
    minus_dm = [0.0]
    for i in range(1, n):
        up_move = highs[i] - highs[i - 1]
        down_move = lows[i - 1] - lows[i]
        plus_dm.append(up_move if (up_move > down_move and up_move > 0) else 0.0)
        minus_dm.append(down_move if (down_move > up_move and down_move > 0) else 0.0)

    trs = _true_ranges(highs, lows, closes)
    atr_series = atr(highs, lows, closes, period)
    smoothed_plus_dm = _wilder_smooth(plus_dm, period)
    smoothed_minus_dm = _wilder_smooth(minus_dm, period)

    plus_di, minus_di, dx = [], [], []
    for i in range(n):
        tr_val = atr_series[i] if atr_series[i] else 1e-9
        pdm = smoothed_plus_dm[i] if smoothed_plus_dm[i] is not None else fmean(plus_dm[: i + 1])
        mdm = smoothed_minus_dm[i] if smoothed_minus_dm[i] is not None else fmean(minus_dm[: i + 1])
        pdi = 100 * (pdm / period) / tr_val if tr_val else 0.0
        mdi = 100 * (mdm / period) / tr_val if tr_val else 0.0
        plus_di.append(pdi)
        minus_di.append(mdi)
        denom = pdi + mdi
        dx.append(100 * abs(pdi - mdi) / denom if denom else 0.0)

    adx_series = [dx[0]] * min(period, n)
    for i in range(period, n):
        adx_series.append((adx_series[-1] * (period - 1) + dx[i]) / period)
    adx_series = adx_series[:n]

    return AdxResult(adx=adx_series, plus_di=plus_di, minus_di=minus_di)


def adx_slope(adx_series: list[float], lookback: int = 5, flat_band: float = 1.5) -> Literal["rising", "falling", "flat"]:
    """Direction of ADX over the last `lookback` bars, not just its level —
    per the ABB session finding that ADX oscillates a lot, so the current
    print alone is not enough signal.
    """
    if len(adx_series) < lookback + 1:
        return "flat"
    delta = adx_series[-1] - adx_series[-1 - lookback]
    if delta > flat_band:
        return "rising"
    if delta < -flat_band:
        return "falling"
    return "flat"


# --------------------------------------------------------------------------
# Support / resistance zones (pivot clustering)
# --------------------------------------------------------------------------

@dataclass
class Zone:
    low: float
    high: float
    basis: str


def swing_pivots(values: list[float], left: int = 3, right: int = 3, kind: Literal["high", "low"] = "high") -> list[tuple[int, float]]:
    """Simple fractal pivot detector: a bar is a pivot high if it's the max
    of the window [i-left, i+right], pivot low if it's the min.
    """
    pivots = []
    for i in range(left, len(values) - right):
        window = values[i - left : i + right + 1]
        if kind == "high" and values[i] == max(window):
            pivots.append((i, values[i]))
        elif kind == "low" and values[i] == min(window):
            pivots.append((i, values[i]))
    return pivots


def cluster_zones(pivots: list[tuple[int, float]], tolerance_pct: float = 0.015, min_touches: int = 2, basis_prefix: str = "pivot") -> list[Zone]:
    """Group nearby pivot prices into zones. `tolerance_pct` is the max
    price distance (as a fraction of price) for two pivots to belong to the
    same zone. Only zones with >= min_touches survive — a single pivot is
    noise, not a level.
    """
    if not pivots:
        return []
    prices = sorted(p for _, p in pivots)
    clusters: list[list[float]] = [[prices[0]]]
    for p in prices[1:]:
        if abs(p - clusters[-1][-1]) / clusters[-1][-1] <= tolerance_pct:
            clusters[-1].append(p)
        else:
            clusters.append([p])
    zones = []
    for c in clusters:
        if len(c) >= min_touches:
            # round(...,2) - yfinance's split/dividend-adjusted closes carry
            # long float64 tails (e.g. 1296.5033478080143), which read as
            # broken precision in every basis string this feeds (regime
            # reasons, strategy leg basis) - 2dp matches every other price
            # this pipeline displays (close, EMA, ATR all print at 2dp too).
            zones.append(Zone(low=round(min(c), 2), high=round(max(c), 2), basis=f"{basis_prefix} x{len(c)}"))
    return zones


# --------------------------------------------------------------------------
# Trend channel (linear regression + stdev bands)
# --------------------------------------------------------------------------

@dataclass
class Channel:
    upper: float
    mid: float
    lower: float
    slope_per_bar: float


def regression_channel(closes: list[float], lookback: int = 60, num_std: float = 2.0) -> Channel:
    window = closes[-lookback:] if len(closes) >= lookback else closes[:]
    n = len(window)
    xs = list(range(n))
    x_mean = fmean(xs)
    y_mean = fmean(window)
    cov = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, window))
    var = sum((x - x_mean) ** 2 for x in xs) or 1e-9
    slope = cov / var
    intercept = y_mean - slope * x_mean
    residuals = [window[i] - (slope * i + intercept) for i in range(n)]
    std = (sum(r * r for r in residuals) / n) ** 0.5
    mid = slope * (n - 1) + intercept
    return Channel(upper=mid + num_std * std, mid=mid, lower=mid - num_std * std, slope_per_bar=slope)


# --------------------------------------------------------------------------
# Volume confirmation
# --------------------------------------------------------------------------

def volume_confirmed(volume: float, volume_sma20: float, min_ratio: float = 1.0) -> bool:
    """Per the correction made mid-conversation: a below-average-volume move
    is NOT bearish confirmation and NOT bullish confirmation — it's simply
    unconfirmed. Callers should treat False as "no volume signal either
    way", not as a bearish flag.
    """
    return volume >= volume_sma20 * min_ratio
