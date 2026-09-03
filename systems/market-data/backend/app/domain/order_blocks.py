"""Smart-money-concepts structure primitives from a plain OHLC candle
series - pure functions, no provider/network dependency
(app/api/routes/order_blocks.py does the candle fetch). Backs the Live
Chart's multi-timeframe structure overlays: the frontend fetches one
series per selected detection timeframe and renders each returned zone /
gap as a horizontal price band. See docs/architecture.md § "Live chart -
multi-timeframe order blocks" and its "Next: SMC setup engine" subsection.

Phase 3a scope: order blocks (`detect_order_blocks`), breaker blocks (a
broken order block kept + polarity-flipped, `role="breaker"`), and fair
value gaps (`detect_fvgs`). Deliberately simple, stateless - a Donchian
structure break plus "last opposite-colour candle before the impulse"
for a zone; no trend/BOS-CHoCH state yet (Phase 3b). Same zone-math
*family* as the scoped SMC order-block Rule (docs "Open questions"); if
that ships in signal-engine it *copies* from here, never a shared import
(same precedent as option_templates.py / compute_ema).
"""

from typing import Literal

from app.domain.models import Candle, Fvg, OrderBlock

ZoneMode = Literal["wick", "body"]
Mitigation = Literal["wick", "close"]

# Guard rails for the tunables (a caller/query param can't push a detector
# into a degenerate or pathologically expensive shape).
_MIN_LOOKBACK, _MAX_LOOKBACK = 3, 200
_MIN_ZONES, _MAX_ZONES = 1, 30
_MAX_FVGS_CAP = 40


def _overlaps(a_lo: float, a_hi: float, b_lo: float, b_hi: float) -> bool:
    return not (a_hi < b_lo or a_lo > b_hi)


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
    max_zones: int = 8,
) -> list[OrderBlock]:
    """`candles` oldest-first (the Candle convention). Returns the
    surviving zones oldest-first too, at most `max_zones` (most-recent
    kept when trimming).

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
        )
        for kind, role, proximal, distal, ob, _rec, mitigated in kept
    ]


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
