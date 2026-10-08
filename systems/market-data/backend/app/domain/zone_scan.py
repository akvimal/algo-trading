"""Market structure at the daily and weekly level, for the nightly "which F&O stocks are at a demand or supply zone" shortlist
(app/scheduler.py's _record_zone_scan; read back by GET /zone-scan and shown on the OI buildup scan page).

Pure computation over a stock's stored daily bars - no database, no provider - so it can be tested without either. It reuses
the Live Chart's own detectors (app/domain/order_blocks.py: structure_state for the confirmed trend, detect_order_blocks for
the zones) rather than a second implementation.

What counts, and why (tuned by looking at the 210 F&O stocks' stored bars on 2026-10-08, not fitted to outcomes - the stored
daily rows are what a later review of "did tier A do better than C?" reads):
- the daily zone must be UNTESTED (price has not traded back to it since it formed) and not against the daily trend;
- "at the zone" is two tiers of position: price inside it, or approaching it (within one daily ATR on the near side);
- weekly bars are the daily bars resampled; the still-forming week is left out unless the last bar is a Friday, so a half-week
  never reads as a structure break;
- tier A = a weekly zone of the same kind is also at price AND the open-interest read agrees; tier B = the weekly trend is on the
  same side AND OI agrees; tier C = a daily zone only (shown behind a toggle).
Open-interest agreement means the call/put buildup labels point the same way as the zone (long buildup or short covering at
demand; short buildup or long unwinding at supply) and none of them points the other way.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional

from app.domain.indicators import resample_weekly
from app.domain.models import Candle, OrderBlock
from app.domain.order_blocks import _atr, detect_order_blocks, structure_state

DAILY_LOOKBACK, DAILY_SWING = 20, 5
WEEKLY_LOOKBACK, WEEKLY_SWING = 8, 3
ATR_PERIOD = 14
# Fewer stored daily bars than this and a read would mostly be noise (a young listing).
MIN_DAILY_BARS = 120
# The weekly detectors need the lookback plus a few bars of history to say anything.
MIN_WEEKLY_BARS = WEEKLY_LOOKBACK + 8
APPROACH_ATR = 1.0

BULLISH_LABELS = frozenset({"long_buildup", "short_covering"})
BEARISH_LABELS = frozenset({"short_buildup", "long_unwinding"})


@dataclass
class ZoneRead:
    close: float
    daily_trend: str
    weekly_trend: Optional[str]  # None when there were too few weekly bars to say
    weekly_bars: int
    # The nearest untested, trend-aligned daily zone at (or approaching) price; all None when there is none.
    zone_kind: Optional[str] = None
    zone_proximal: Optional[float] = None
    zone_distal: Optional[float] = None
    zone_position: Optional[str] = None  # "inside" | "approaching"
    zone_distance_pct: Optional[float] = None  # 0 when inside
    zone_distance_atr: Optional[float] = None
    weekly_zone: bool = False  # a weekly zone of the same kind is also at price
    weekly_agrees: bool = False  # the weekly trend is on the zone's side


def completed_weeks(daily: list[Candle]) -> list[Candle]:
    """Daily bars as weekly bars, leaving out the week still forming: the last week counts only when its last bar is a Friday."""
    weekly = resample_weekly(daily)
    if weekly and date.fromisoformat(daily[-1].timestamp[:10]).weekday() != 4:
        weekly = weekly[:-1]
    return weekly


def _position(block: OrderBlock, close: float, atr: float) -> Optional[tuple[str, float]]:
    """("inside", 0) / ("approaching", distance) for a zone price is at or within one ATR of on its near side, else None."""
    lo, hi = min(block.proximal, block.distal), max(block.proximal, block.distal)
    if lo <= close <= hi:
        return "inside", 0.0
    if block.kind == "demand" and 0 < close - hi <= atr * APPROACH_ATR:
        return "approaching", close - hi
    if block.kind == "supply" and 0 < lo - close <= atr * APPROACH_ATR:
        return "approaching", lo - close
    return None


def read_zones(daily: list[Candle]) -> Optional[ZoneRead]:
    """`daily` oldest-first completed daily bars. None when there is too little history to say anything."""
    if len(daily) < MIN_DAILY_BARS:
        return None
    close = daily[-1].close
    highs, lows, closes = [c.high for c in daily], [c.low for c in daily], [c.close for c in daily]
    atr = _atr(highs, lows, closes, ATR_PERIOD)
    d_trend, _, _ = structure_state(daily, swing_lookback=DAILY_SWING)
    blocks = detect_order_blocks(daily, lookback=DAILY_LOOKBACK, trend=d_trend, max_zones=8)

    weekly = completed_weeks(daily)
    w_trend: Optional[str] = None
    w_near: list[OrderBlock] = []
    if len(weekly) >= MIN_WEEKLY_BARS:
        w_trend, _, _ = structure_state(weekly, swing_lookback=WEEKLY_SWING)
        w_atr = _atr([c.high for c in weekly], [c.low for c in weekly], [c.close for c in weekly], ATR_PERIOD)
        w_blocks = detect_order_blocks(weekly, lookback=WEEKLY_LOOKBACK, trend=w_trend, max_zones=8)
        w_near = [b for b in w_blocks if not b.mitigated and _position(b, close, w_atr)]

    read = ZoneRead(close=close, daily_trend=d_trend, weekly_trend=w_trend, weekly_bars=len(weekly))
    candidates = []
    for b in blocks:
        if b.mitigated or b.counter_trend or not atr:
            continue
        pos = _position(b, close, atr)
        if pos:
            candidates.append((pos[1], b, pos[0]))
    if not candidates:
        return read
    distance, block, where = min(candidates, key=lambda c: c[0])
    read.zone_kind, read.zone_proximal, read.zone_distal, read.zone_position = block.kind, block.proximal, block.distal, where
    read.zone_distance_pct = round(100 * distance / close, 3)
    read.zone_distance_atr = round(distance / atr, 3)
    read.weekly_zone = any(b.kind == block.kind for b in w_near)
    read.weekly_agrees = (block.kind == "supply" and w_trend == "down") or (block.kind == "demand" and w_trend == "up")
    return read


def oi_agrees(zone_kind: str, call_buildup: Optional[str], put_buildup: Optional[str]) -> Optional[bool]:
    """Whether the open-interest read points the same way as the zone: None when there is no read at all."""
    labels = {x for x in (call_buildup, put_buildup) if x}
    if not labels:
        return None
    same, other = (BULLISH_LABELS, BEARISH_LABELS) if zone_kind == "demand" else (BEARISH_LABELS, BULLISH_LABELS)
    return bool(labels & same) and not (labels & other)


def tier_for(read: ZoneRead, call_buildup: Optional[str], put_buildup: Optional[str]) -> tuple[Optional[str], Optional[bool]]:
    """(tier, oi_agrees): A, B or C for a stock with a daily zone at price, None for one without."""
    if read.zone_kind is None:
        return None, None
    agrees = oi_agrees(read.zone_kind, call_buildup, put_buildup)
    if agrees and read.weekly_zone:
        return "A", agrees
    if agrees and read.weekly_agrees:
        return "B", agrees
    return "C", agrees
