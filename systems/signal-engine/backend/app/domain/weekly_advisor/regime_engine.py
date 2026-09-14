"""Deterministic regime assessment: turns technical + OI signals into a
RegimeAssessment(bias, trend_strength, confidence, reasons).

Every rule here traces back to a specific point from the ABB chart-reading
session in this conversation:
  - weekly timeframe outranks daily when they disagree (weekly ADX vs daily ADX)
  - ADX *slope*, not just level, distinguishes a live trend from a fading one
  - below-average volume on a test is UNCONFIRMED, not bearish -- never treat
    a lack of volume confirmation as a vote for the opposite side
  - price vs EMA50 + horizontal zone + channel mid = the "confluence cluster"
    that made the ABB support test meaningful

Nothing here calls out to a network or an LLM -- this is the part you can
unit test against fixtures and eventually backtest independently of the AI
synthesis layer.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .contracts import OISnapshot, RegimeAssessment, TechnicalSnapshot, Zone

BULLISH_BUILDUPS = {"long_buildup", "short_covering"}
BEARISH_BUILDUPS = {"short_buildup", "long_unwinding"}


@dataclass
class OrderBlockZone:
    """A hand-written mirror of market-data's OrderBlock (app/domain/
    models.py) - only the 3 fields this module's own vote needs, not a
    cross-system import (see docs/architecture.md's systems/* boundary
    rule). Populated by pipeline.py from GET /order-blocks (weekly
    timeframe, source=yahoo) - this module itself still does no I/O."""

    kind: str  # "demand" | "supply"
    proximal: float
    distal: float
    mitigated: bool


@dataclass
class _Vote:
    direction: str  # "bullish" | "bearish" | None
    weight: float
    reason: str


def _nearest_zone(zones: list[Zone], price: float, side: str) -> Zone | None:
    """side='below' -> nearest support under price; side='above' -> nearest
    resistance over price."""
    candidates = [z for z in zones if (z.high <= price if side == "below" else z.low >= price)]
    if not candidates:
        return None
    key = (lambda z: price - z.high) if side == "below" else (lambda z: z.low - price)
    return min(candidates, key=key)


def _ema_vote(t: TechnicalSnapshot) -> _Vote:
    if t.close > t.ema50:
        return _Vote("bullish", 1.0, f"{t.timeframe} close ({t.close:.2f}) above EMA50 ({t.ema50:.2f})")
    if t.close < t.ema50:
        return _Vote("bearish", 1.0, f"{t.timeframe} close ({t.close:.2f}) below EMA50 ({t.ema50:.2f})")
    return _Vote(None, 0.0, f"{t.timeframe} close sitting exactly on EMA50 -- no edge")


def _zone_vote(t: TechnicalSnapshot) -> _Vote:
    support = _nearest_zone(t.support_zones, t.close, "below")
    resistance = _nearest_zone(t.resistance_zones, t.close, "above")
    dist_support = (t.close - support.high) / t.close if support else None
    dist_resistance = (resistance.low - t.close) / t.close if resistance else None

    if dist_support is not None and (dist_resistance is None or dist_support < dist_resistance):
        if dist_support <= 0.02:  # within 2% of a support zone and holding above it
            weight = 1.0 if t.volume_confirmed else 0.6
            note = "confirmed by volume" if t.volume_confirmed else "volume NOT confirming -- unconfirmed test, not a bearish signal by itself"
            return _Vote("bullish", weight, f"holding {dist_support:.1%} above support {support.low}-{support.high} ({note})")
    if dist_resistance is not None and (dist_support is None or dist_resistance < dist_support):
        if dist_resistance <= 0.02:
            weight = 1.0 if t.volume_confirmed else 0.6
            note = "confirmed by volume" if t.volume_confirmed else "volume NOT confirming -- unconfirmed rejection, not a bullish signal by itself"
            return _Vote("bearish", weight, f"testing resistance {resistance.low}-{resistance.high} from {dist_resistance:.1%} below ({note})")
    return _Vote(None, 0.0, "price sitting mid-range, no zone test in play")


def _order_block_vote(order_blocks: list[OrderBlockZone], close: float, timeframe: str) -> _Vote:
    """Whether current price is sitting inside a still-valid SMC order
    block on the given `timeframe` (see OrderBlockZone's own docstring) -
    a completely different detection method from _zone_vote's own
    pivot-clustered horizontal zones above, and can legitimately disagree
    with it: a stock can be below its weekly EMA50 (a bearish trend read)
    while sitting in a bullish demand order block (a specific level worth
    a bounce) - both readings are correct, they're just answering
    different questions. `timeframe` is a plain label for the reason text
    ("weekly"/"daily", mirroring _ema_vote's own t.timeframe) - the caller
    (assess_regime) decides the vote's actual weight, same "weekly is the
    real vote, daily is a half-weight nudge" split as the EMA votes. A
    fresh (unmitigated) order block votes at full weight; one already
    tested once (mitigated=True) votes at reduced weight - it's a real
    level, just with less untested conviction behind it. Only the first
    containing zone counts (market-data doesn't return overlapping
    same-kind zones at the same price, so there's at most one real match)."""
    for ob in order_blocks:
        low, high = min(ob.proximal, ob.distal), max(ob.proximal, ob.distal)
        if not (low <= close <= high):
            continue
        direction = "bullish" if ob.kind == "demand" else "bearish"
        weight = 0.6 if ob.mitigated else 1.0
        state = "once-tested" if ob.mitigated else "fresh, untested"
        return _Vote(direction, weight, f"sitting inside a {state} {timeframe} {ob.kind} order block ({low:.2f}-{high:.2f})")
    return _Vote(None, 0.0, f"not sitting inside any {timeframe} order block")


def _oi_vote(oi: OISnapshot) -> _Vote:
    if not oi.available or oi.aggregate_signal is None:
        return _Vote(None, 0.0, "OI data unavailable or mixed -- no OI vote this cycle")
    if oi.aggregate_signal in BULLISH_BUILDUPS:
        return _Vote("bullish", 1.0, f"OI aggregate signal: {oi.aggregate_signal}")
    return _Vote("bearish", 1.0, f"OI aggregate signal: {oi.aggregate_signal}")


def _trend_strength(t: TechnicalSnapshot) -> str:
    if t.adx14 < 20:
        return "ranging"
    if t.adx14 >= 25 and t.adx14_slope == "rising":
        return "trending"
    if t.adx14_slope == "falling":
        return "decelerating"
    return "trending" if t.adx14 >= 25 else "decelerating"


def assess_regime(
    primary: TechnicalSnapshot,
    oi: OISnapshot,
    secondary: TechnicalSnapshot | None = None,
    order_blocks: list[OrderBlockZone] | None = None,
    daily_order_blocks: list[OrderBlockZone] | None = None,
) -> RegimeAssessment:
    """`primary` should be the WEEKLY snapshot -- per the ABB session
    conclusion that weekly should outrank daily on a weekly decision
    cadence. Pass the daily snapshot as `secondary` for an extra, lower-
    weighted vote and to populate richer reasons; it never overrides the
    weekly read on its own. `order_blocks` (weekly-timeframe SMC order
    blocks, best-effort - see pipeline.py) is optional and defaults to no
    vote at all (not "no order block found") when the caller couldn't
    fetch them, same graceful-degradation convention OI already uses.
    `daily_order_blocks` is the same idea one timeframe down - half weight,
    same as secondary's daily EMA vote, since a stock can genuinely sit
    inside a daily order block while price is nowhere near any weekly one
    (confirmed live 2026-09-13, JUBLFOOD: daily demand zone 461.60-472.95
    containing spot 470.25, weekly's nearest demand zone at 408.55-426.75 -
    both readings are correct, they're just different timeframes).
    """
    votes: list[_Vote] = [_ema_vote(primary), _zone_vote(primary), _oi_vote(oi)]
    if order_blocks is not None:
        votes.append(_order_block_vote(order_blocks, primary.close, timeframe="weekly"))
    if secondary is not None:
        v = _ema_vote(secondary)
        v.weight *= 0.5  # daily gets half the say of weekly, never the deciding vote alone
        v.reason = "(daily, half-weight) " + v.reason
        votes.append(v)
    if daily_order_blocks is not None:
        close = secondary.close if secondary is not None else primary.close
        v = _order_block_vote(daily_order_blocks, close, timeframe="daily")
        v.weight *= 0.5
        v.reason = "(daily, half-weight) " + v.reason
        votes.append(v)

    bullish = sum(v.weight for v in votes if v.direction == "bullish")
    bearish = sum(v.weight for v in votes if v.direction == "bearish")
    reasons = [v.reason for v in votes if v.weight > 0 or v.direction is None]

    total = bullish + bearish
    if total == 0:
        bias, confidence = "neutral", 0.0
    elif bullish == bearish:
        bias, confidence = "neutral", 0.0
    else:
        bias = "bullish" if bullish > bearish else "bearish"
        confidence = round(abs(bullish - bearish) / total, 2)

    trend_strength = _trend_strength(primary)
    if trend_strength == "ranging":
        # A ranging tape means directional conviction should be discounted
        # even if the vote count looks lopsided -- this is exactly the
        # August-vs-September ADX divergence from the ABB session.
        confidence = round(confidence * 0.6, 2)
        reasons.append(f"weekly ADX {primary.adx14:.1f} < 20 -- ranging regime, directional confidence discounted")
    else:
        reasons.append(f"weekly ADX {primary.adx14:.1f}, slope {primary.adx14_slope} -> {trend_strength}")

    return RegimeAssessment(bias=bias, trend_strength=trend_strength, confidence=confidence, reasons=reasons)
