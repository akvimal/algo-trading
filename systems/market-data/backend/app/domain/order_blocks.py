"""Smart-money-concepts structure primitives from a plain OHLC candle
series - pure functions, no provider/network dependency
(app/api/routes/order_blocks.py does the candle fetch). Backs the Live
Chart's multi-timeframe structure overlays: the frontend fetches one
series per selected detection timeframe and renders each returned zone /
gap as a horizontal price band. See docs/architecture.md § "Live chart -
multi-timeframe order blocks" and its "Next: SMC setup engine" subsection.

Phase 3a: order blocks (`detect_order_blocks`), breaker blocks (a broken
order block kept + polarity-flipped, `role="breaker"`), fair value gaps
(`detect_fvgs`). Phase 3b: market-structure state (`structure_state` -
confirmed swing pivots -> BOS/CHoCH events -> a running up/down/range
trend flag), which `detect_order_blocks` uses to tag counter-trend zones.
Phase 3c: rejection-confirmed trade setups (`detect_setups` - a
trend-aligned zone, a retest, a confirmation candle -> entry/SL/target,
R:R-gated, with a walk-forward status). Deliberately simple - the same
simplifications the scoped SMC order-block Rule (docs "Open questions")
locks in; if that ships in signal-engine it *copies* from here, never a
shared import (same precedent as option_templates.py / compute_ema).
"""

from collections import defaultdict
from typing import Literal

from app.domain.models import Candle, Fvg, OrderBlock, Setup, StructureEvent

ZoneMode = Literal["wick", "body"]
Mitigation = Literal["wick", "close"]
Trend = Literal["up", "down", "range"]

# Guard rails for the tunables (a caller/query param can't push a detector
# into a degenerate or pathologically expensive shape).
_MIN_LOOKBACK, _MAX_LOOKBACK = 3, 200
_MIN_ZONES, _MAX_ZONES = 1, 30
_MIN_SWING, _MAX_SWING = 2, 50
_MAX_FVGS_CAP = 40
_MAX_EVENTS = 8


def _overlaps(a_lo: float, a_hi: float, b_lo: float, b_hi: float) -> bool:
    return not (a_hi < b_lo or a_lo > b_hi)


def _confirmed_pivots(h: list[float], lo: list[float], swing: int) -> list[tuple[int, int, float, str]]:
    """Confirmed swing highs/lows: index i is a swing high when h[i] is
    strictly above the prior `swing` bars and at least as high as the next
    `swing`; mirror for lows. A pivot is only *known* `swing` bars later
    (the lookahead) - the returned tuple carries both the pivot index and
    its confirmation index (`i + swing`) so the state machine can apply it
    at the right bar. Sorted by confirmation index."""
    n = len(h)
    out: list[tuple[int, int, float, str]] = []
    for i in range(swing, n - swing):
        if h[i] > max(h[i - swing : i]) and h[i] >= max(h[i + 1 : i + swing + 1]):
            out.append((i + swing, i, h[i], "high"))
        if lo[i] < min(lo[i - swing : i]) and lo[i] <= min(lo[i + 1 : i + swing + 1]):
            out.append((i + swing, i, lo[i], "low"))
    out.sort()
    return out


def structure_state(candles: list[Candle], *, swing_lookback: int = 5) -> tuple[Trend, list[StructureEvent]]:
    """Walks the series maintaining the most recent *unbroken* confirmed
    swing high / low. A close beyond one is a structure break, labelled
    against the last break's direction: same direction = **BOS**
    (continuation), opposite = **CHoCH** (change of character).

    The returned `trend` is the *confirmed* trend: it's set only by a BOS,
    and reset to `range` by the first CHoCH against it - so a choppy
    market that keeps flip-flopping between CHoCHs reads `range`, not a
    whipsawing up/down. Returns the last `_MAX_EVENTS` breaks (oldest-
    first). A deliberate simplification of textbook SMC - the same one
    the scoped SMC Rule locks in."""
    swing_lookback = max(_MIN_SWING, min(_MAX_SWING, swing_lookback))
    n = len(candles)
    if n < 2 * swing_lookback + 2:
        return "range", []

    h = [c.high for c in candles]
    lo = [c.low for c in candles]
    cl = [c.close for c in candles]
    ts = [c.timestamp for c in candles]

    by_confirm: dict[int, list[tuple[float, str]]] = defaultdict(list)
    for confirm_idx, _pivot_idx, price, kind in _confirmed_pivots(h, lo, swing_lookback):
        by_confirm[confirm_idx].append((price, kind))

    last_break: str = "range"  # direction of the previous break - drives BOS vs CHoCH
    confirmed: Trend = "range"  # what we report - only a BOS sets it, an opposing CHoCH clears it
    ref_high: float | None = None
    ref_low: float | None = None
    events: list[StructureEvent] = []

    for i in range(n):
        for price, kind in by_confirm.get(i, []):
            if kind == "high":
                ref_high = price
            else:
                ref_low = price

        direction: str | None = None
        level = 0.0
        if ref_high is not None and cl[i] > ref_high:
            direction, level, ref_high = "up", ref_high, None
        elif ref_low is not None and cl[i] < ref_low:
            direction, level, ref_low = "down", ref_low, None
        if direction is None:
            continue

        kind = "bos" if direction == last_break else "choch"
        events.append(StructureEvent(kind=kind, direction=direction, price=level, timestamp=ts[i]))
        last_break = direction
        if kind == "bos":
            confirmed = direction
        elif confirmed not in ("range", direction):
            confirmed = "range"

    return confirmed, events[-_MAX_EVENTS:]


def _atr(h: list[float], lo: list[float], cl: list[float], period: int = 14) -> float:
    """Trailing average true range - a recent-volatility scalar for the
    FVG minimum-gap filter, not a full per-bar series."""
    if len(cl) < 2:
        return 0.0
    trs = [
        max(h[k] - lo[k], abs(h[k] - cl[k - 1]), abs(lo[k] - cl[k - 1]))
        for k in range(1, len(cl))
    ]
    recent = trs[-period:]
    return sum(recent) / len(recent) if recent else 0.0


def _touches_proximal(kind: str, mitigation: Mitigation, h_k: float, lo_k: float, cl_k: float, proximal: float) -> bool:
    """Has candle k reached the zone's proximal edge from the outside?
    demand/breaker-demand: price returning from above -> low/close <= proximal.
    supply/breaker-supply: price returning from below -> high/close >= proximal."""
    if kind == "demand":
        return lo_k <= proximal if mitigation == "wick" else cl_k <= proximal
    return h_k >= proximal if mitigation == "wick" else cl_k >= proximal


def detect_order_blocks(
    candles: list[Candle],
    *,
    lookback: int = 20,
    zone_mode: ZoneMode = "wick",
    mitigation: Mitigation = "wick",
    require_fvg: bool = False,
    keep_breakers: bool = False,
    trend: Trend = "range",
    max_zones: int = 8,
) -> list[OrderBlock]:
    """`candles` oldest-first (the Candle convention). Returns the
    surviving zones oldest-first too, at most `max_zones` (most-recent
    kept when trimming).

    - `trend`: the current market-structure trend (from `structure_state`);
      a zone opposing it is tagged `counter_trend` (a demand zone in a
      downtrend, or supply in an uptrend). `"range"` tags nothing.
    - `lookback`: Donchian window - a candle closing above the prior
      `lookback` bars' high is a bullish structure break (mirror for
      bearish). The order block is the last opposite-colour candle before
      that break.
    - `zone_mode`: "wick" uses the OB candle's full high-low, "body" just
      its open-close.
    - `mitigation`: "wick" marks a zone mitigated once any later candle's
      wick reaches its proximal edge; "close" needs a later close.
    - `require_fvg`: only keep an OB whose impulse leg contains a 3-candle
      fair-value gap.
    - `keep_breakers`: a zone whose distal edge is later closed through is
      normally dropped; with this set it's kept as a **breaker** instead -
      polarity flipped (broken demand -> supply, and vice versa),
      `role="breaker"`, re-evaluated forward from the break with the new
      polarity (dropped only if price then reclaims the other side).
    """
    lookback = max(_MIN_LOOKBACK, min(_MAX_LOOKBACK, lookback))
    max_zones = max(_MIN_ZONES, min(_MAX_ZONES, max_zones))
    if len(candles) < lookback + 2:
        return []

    o = [c.open for c in candles]
    h = [c.high for c in candles]
    lo = [c.low for c in candles]
    cl = [c.close for c in candles]
    ts = [c.timestamp for c in candles]
    n = len(candles)

    # (kind, proximal, distal, origin_index, break_index)
    raw: list[tuple[str, float, float, int, int]] = []

    for i in range(lookback, n):
        prior_high = max(h[i - lookback : i])
        prior_low = min(lo[i - lookback : i])

        bullish = cl[i] > prior_high
        bearish = cl[i] < prior_low
        if not (bullish or bearish):
            continue

        # The order block: scan back for the last candle of the opposite
        # colour to the impulse, bounded to the lookback window.
        ob = None
        for j in range(i - 1, max(-1, i - lookback - 1), -1):
            down = cl[j] < o[j]
            up = cl[j] > o[j]
            if (bullish and down) or (bearish and up):
                ob = j
                break
        if ob is None:
            continue

        if require_fvg and not _impulse_has_fvg(h, lo, ob, i, bullish):
            continue

        if zone_mode == "body":
            z_lo, z_hi = min(o[ob], cl[ob]), max(o[ob], cl[ob])
        else:
            z_lo, z_hi = lo[ob], h[ob]
        if z_hi <= z_lo:
            continue

        if bullish:
            raw.append(("demand", z_hi, z_lo, ob, i))  # proximal=top, distal=bottom
        else:
            raw.append(("supply", z_lo, z_hi, ob, i))  # proximal=bottom, distal=top

    # Evaluate each zone forward from *after the impulse* (break_index + 1)
    # - a bar inside the impulse that forms the zone isn't a re-visit.
    # (kind, role, proximal, distal, origin_index, recency_index, mitigated)
    evaluated: list[tuple[str, str, float, float, int, int, bool]] = []
    for kind, proximal, distal, ob, break_idx in raw:
        z_lo, z_hi = min(proximal, distal), max(proximal, distal)
        mitigated = False
        broken_at = None
        for k in range(break_idx + 1, n):
            through_distal = cl[k] < distal if kind == "demand" else cl[k] > distal
            if through_distal:
                broken_at = k
                break
            if _touches_proximal(kind, mitigation, h[k], lo[k], cl[k], proximal):
                mitigated = True

        if broken_at is None:
            evaluated.append((kind, "orderblock", proximal, distal, ob, break_idx, mitigated))
            continue
        if not keep_breakers:
            continue

        # Breaker: flip polarity. Price is now on the far side of the old
        # zone, so its proximal edge is the one it just broke through.
        flipped = "supply" if kind == "demand" else "demand"
        b_proximal, b_distal = (z_lo, z_hi) if flipped == "supply" else (z_hi, z_lo)
        b_mitigated = False
        b_broken = False
        for k in range(broken_at + 1, n):
            reclaimed = cl[k] > z_hi if flipped == "supply" else cl[k] < z_lo
            if reclaimed:
                b_broken = True
                break
            if _touches_proximal(flipped, mitigation, h[k], lo[k], cl[k], b_proximal):
                b_mitigated = True
        if not b_broken:
            evaluated.append((flipped, "breaker", b_proximal, b_distal, ob, broken_at, b_mitigated))

    # De-clutter: newest first (by recency_index - break for an OB, break
    # point for a breaker), keep a zone only if it doesn't overlap an
    # already-kept one of the same kind. Cap, then re-sort oldest-first.
    evaluated.sort(key=lambda z: z[5], reverse=True)
    kept: list[tuple[str, str, float, float, int, int, bool]] = []
    for zone in evaluated:
        kind, _role, proximal, distal, _ob, _rec, _mit = zone
        z_lo, z_hi = min(proximal, distal), max(proximal, distal)
        clash = any(
            k[0] == kind and _overlaps(z_lo, z_hi, min(k[2], k[3]), max(k[2], k[3]))
            for k in kept
        )
        if not clash:
            kept.append(zone)
        if len(kept) >= max_zones:
            break

    kept.sort(key=lambda z: z[4])
    return [
        OrderBlock(
            kind=kind,
            role=role,
            proximal=proximal,
            distal=distal,
            origin_timestamp=ts[ob],
            mitigated=mitigated,
            counter_trend=(trend == "up" and kind == "supply") or (trend == "down" and kind == "demand"),
        )
        for kind, role, proximal, distal, ob, _rec, mitigated in kept
    ]


def _is_confirmation(
    want: str, o: list[float], h: list[float], lo: list[float], cl: list[float], k: int, proximal: float, min_wick_ratio: float
) -> bool:
    """Is candle k a valid rejection confirmation at the zone? **Mandatory**
    it closes back beyond the zone's proximal edge (out of the zone, on
    the trade side), **plus at least one of**: a rejection wick on the
    zone's side >= `min_wick_ratio` x body, or an engulf of the prior
    candle's body in the trade direction. The SMC Rule's settled def."""
    if (want == "demand" and cl[k] <= proximal) or (want == "supply" and cl[k] >= proximal):
        return False
    body = abs(cl[k] - o[k])
    if body <= 0:
        return False
    if want == "demand":
        wick = min(o[k], cl[k]) - lo[k]
        engulf = k > 0 and cl[k] > o[k] and o[k] <= min(o[k - 1], cl[k - 1]) and cl[k] >= max(o[k - 1], cl[k - 1])
    else:
        wick = h[k] - max(o[k], cl[k])
        engulf = k > 0 and cl[k] < o[k] and o[k] >= max(o[k - 1], cl[k - 1]) and cl[k] <= min(o[k - 1], cl[k - 1])
    return wick >= min_wick_ratio * body or engulf


def detect_setups(
    candles: list[Candle],
    *,
    trend: Trend,
    lookback: int = 20,
    min_wick_ratio: float = 1.0,
    sl_atr_mult: float = 0.5,
    min_risk_reward: float = 1.5,
    retest_expiry_bars: int = 25,
    recent_bars: int = 200,
    max_setups: int = 6,
) -> list[Setup]:
    """Rejection-confirmed trade setups, **only with the current trend**
    (`range` -> none). For each `lookback`-Donchian structure break that
    forms a trend-aligned order block: wait for price to retest the zone,
    then for a confirmation candle (`_is_confirmation`) within
    `retest_expiry_bars`; compute entry (a stop at the confirmation
    candle's own extreme), stop (ATR-buffered beyond the zone's far edge),
    target (the post-impulse swing extreme); gate on `min_risk_reward`;
    then walk the rest of the series for the status. Overlapping zones are
    de-duplicated. Returns every still-live setup plus recent resolved
    ones, up to `max_setups`, oldest-first."""
    if trend not in ("up", "down"):
        return []
    lookback = max(_MIN_LOOKBACK, min(_MAX_LOOKBACK, lookback))
    recent_bars = max(50, min(2000, recent_bars))
    max_setups = max(1, min(_MAX_ZONES, max_setups))
    want = "demand" if trend == "up" else "supply"
    direction = "long" if trend == "up" else "short"
    n = len(candles)
    if n < lookback + 4:
        return []

    o = [c.open for c in candles]
    h = [c.high for c in candles]
    lo = [c.low for c in candles]
    cl = [c.close for c in candles]
    ts = [c.timestamp for c in candles]
    atr = _atr(h, lo, cl)

    setups: list[Setup] = []
    used_bands: list[tuple[float, float]] = []

    for i in range(max(lookback, n - recent_bars), n):
        broke = cl[i] > max(h[i - lookback : i]) if want == "demand" else cl[i] < min(lo[i - lookback : i])
        if not broke:
            continue

        ob = None
        for j in range(i - 1, max(-1, i - lookback - 1), -1):
            if (want == "demand" and cl[j] < o[j]) or (want == "supply" and cl[j] > o[j]):
                ob = j
                break
        if ob is None:
            continue

        z_lo, z_hi = lo[ob], h[ob]
        if z_hi <= z_lo:
            continue
        proximal, distal = (z_hi, z_lo) if want == "demand" else (z_lo, z_hi)
        if any(_overlaps(z_lo, z_hi, b_lo, b_hi) for b_lo, b_hi in used_bands):
            continue

        # Retest: first bar after the break whose wick re-enters the zone,
        # bailing if a close first goes clean through the far edge.
        retest = None
        for k in range(i + 1, n):
            if (cl[k] < distal if want == "demand" else cl[k] > distal):
                break
            if (lo[k] <= proximal if want == "demand" else h[k] >= proximal):
                retest = k
                break
        if retest is None:
            continue

        confirm = None
        for k in range(retest, min(n, retest + retest_expiry_bars)):
            if (cl[k] < distal if want == "demand" else cl[k] > distal):
                break
            if _is_confirmation(want, o, h, lo, cl, k, proximal, min_wick_ratio):
                confirm = k
                break
        if confirm is None:
            continue

        swing_extreme = max(h[i:retest]) if want == "demand" else min(lo[i:retest])
        if want == "demand":
            entry, stop, target = h[confirm], distal - sl_atr_mult * atr, swing_extreme
            risk, reward = entry - stop, target - entry
        else:
            entry, stop, target = lo[confirm], distal + sl_atr_mult * atr, swing_extreme
            risk, reward = stop - entry, entry - target
        if risk <= 0 or reward <= 0:
            continue
        rr = reward / risk
        if rr < min_risk_reward:
            continue

        status = "confirmed"
        resolved_ts: str | None = None
        triggered = False
        for k in range(confirm + 1, n):
            through_distal = cl[k] < distal if want == "demand" else cl[k] > distal
            if not triggered:
                stop_closed = cl[k] < stop if want == "demand" else cl[k] > stop
                if through_distal or stop_closed:
                    status, resolved_ts = "invalidated", ts[k]
                    break
                if (h[k] >= entry if want == "demand" else lo[k] <= entry):
                    triggered, status = True, "triggered"
            if triggered:
                hit_sl = lo[k] <= stop if want == "demand" else h[k] >= stop
                hit_tgt = h[k] >= target if want == "demand" else lo[k] <= target
                if hit_sl:  # if a bar spans both, assume the stop went first
                    status, resolved_ts = "hit_sl", ts[k]
                    break
                if hit_tgt:
                    status, resolved_ts = "hit_target", ts[k]
                    break

        used_bands.append((z_lo, z_hi))
        setups.append(
            Setup(
                direction=direction,
                status=status,
                entry=entry,
                stop_loss=stop,
                target=target,
                risk_reward=round(rr, 2),
                zone_proximal=proximal,
                zone_distal=distal,
                confirmed_timestamp=ts[confirm],
                resolved_timestamp=resolved_ts,
            )
        )

    live = [s for s in setups if s.status in ("confirmed", "triggered")][-max_setups:]
    slots = max(0, max_setups - len(live))
    resolved = [s for s in setups if s.status not in ("confirmed", "triggered")][-slots:] if slots else []
    return sorted(live + resolved, key=lambda s: s.confirmed_timestamp)


def detect_fvgs(
    candles: list[Candle],
    *,
    min_gap_atr: float = 0.15,
    mitigation: Mitigation = "wick",
    max_fvgs: int = 10,
    recent_bars: int = 250,
) -> list[Fvg]:
    """3-candle fair-value gaps (imbalances), oldest-first, at most
    `max_fvgs` (most recent). A bullish gap is candle k-1's high strictly
    below candle k+1's low; bearish is the mirror. Gaps smaller than
    `min_gap_atr` x trailing ATR are dropped as noise. A gap is dropped
    once a later candle *closes* clean through its far edge; `filled` is
    True once a later wick (or close, `mitigation="close"`) has entered it
    from the outside without yet closing through.

    Only the last `recent_bars` candles are scanned for new gaps - FVGs
    are a short-term concept, and a coarse detection timeframe's full
    history would surface gaps hundreds of bars away from current price."""
    max_fvgs = max(1, min(_MAX_FVGS_CAP, max_fvgs))
    recent_bars = max(50, min(2000, recent_bars))
    n = len(candles)
    if n < 4:
        return []

    h = [c.high for c in candles]
    lo = [c.low for c in candles]
    cl = [c.close for c in candles]
    ts = [c.timestamp for c in candles]
    min_gap = min_gap_atr * _atr(h, lo, cl)

    # (kind, top, bottom, mid_index)
    raw: list[tuple[str, float, float, int]] = []
    for i in range(max(1, n - recent_bars), n - 1):
        if h[i - 1] < lo[i + 1] and (lo[i + 1] - h[i - 1]) >= min_gap:
            raw.append(("bullish", lo[i + 1], h[i - 1], i))
        elif lo[i - 1] > h[i + 1] and (lo[i - 1] - h[i + 1]) >= min_gap:
            raw.append(("bearish", lo[i - 1], h[i + 1], i))

    out: list[Fvg] = []
    for kind, top, bottom, i in raw:
        filled = False
        gone = False
        for k in range(i + 2, n):
            if kind == "bullish":
                if cl[k] < bottom:  # closed clean through the far (lower) edge
                    gone = True
                    break
                if (mitigation == "wick" and lo[k] <= top) or (mitigation == "close" and cl[k] <= top):
                    filled = True
            else:
                if cl[k] > top:
                    gone = True
                    break
                if (mitigation == "wick" and h[k] >= bottom) or (mitigation == "close" and cl[k] >= bottom):
                    filled = True
        if not gone:
            out.append(Fvg(kind=kind, top=top, bottom=bottom, origin_timestamp=ts[i], filled=filled))

    return out[-max_fvgs:]


def _impulse_has_fvg(h: list[float], lo: list[float], ob: int, break_idx: int, bullish: bool) -> bool:
    """A 3-candle fair-value gap anywhere in the impulse leg [ob, break_idx]:
    bullish = candle k-1's high below candle k+1's low (a gap up),
    bearish = candle k-1's low above candle k+1's high (a gap down)."""
    for k in range(ob + 1, break_idx):
        if bullish and h[k - 1] < lo[k + 1]:
            return True
        if not bullish and lo[k - 1] > h[k + 1]:
            return True
    return False
