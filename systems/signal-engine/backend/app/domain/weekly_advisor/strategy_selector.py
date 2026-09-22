"""Deterministic strategy + strike selection from a RegimeAssessment.

Encodes the rest of the ABB-session reasoning:
  - never open new premium-selling positions inside 7 days of expiry
    (the gamma/assignment-risk conclusion)
  - a corporate results date inside the decision window is a hard block on
    new entries, not just a caveat
  - strike distance is anchored to the nearest technical zone AND a minimum
    ATR multiple, whichever is further from spot (the more conservative one)
  - every recommendation carries the "close at X% of max profit OR N days
    before expiry, whichever first" exit rule from the theta-decay discussion
"""
from __future__ import annotations

import math
from datetime import date

from .contracts import (
    CorporateEvent,
    EntryWindow,
    ExitRule,
    OISnapshot,
    RegimeAssessment,
    StrategyLeg,
    StrategyRecommendation,
    TechnicalSnapshot,
    Zone,
)
from .regime_engine import OrderBlockZone

MIN_DAYS_TO_EXPIRY_FOR_NEW_ENTRY = 7
DEFAULT_ATR_MULTIPLE = 1.0
DEFAULT_EXIT_RULE = ExitRule(target_pct_of_max_profit=0.65, hard_exit_days_before_expiry=5)

# Below either, a symbol reads as too quiet to be worth a weekly premium-
# selling trade - tightening strike anchoring (below) doesn't manufacture
# premium a genuinely low-range, thin stock doesn't have. Not derived from
# backtested data - reasonable starting points, tune freely (see
# docs/architecture.md's Weekly Advisor writeup, "screen out low-
# volatility/low-liquidity names" - same "not derived from anything, tune
# freely" convention app/domain/sentiment.py's own _MILD/_STRONG buckets use).
MIN_ATR_PCT_OF_CLOSE = 0.015  # 1.5% weekly ATR
MIN_AVG_DAILY_TRADED_VALUE = 5_00_00_000  # Rs 5 crore/day (volume_sma20 * close)


def round_to_strike(price: float, interval: float, direction: str) -> float:
    """Snap to a valid strike on the exchange's strike ladder, rounding AWAY
    from spot so the result stays at least as conservative as the raw
    target: 'down' for put strikes, 'up' for call strikes."""
    if direction == "down":
        return math.floor(price / interval) * interval
    return math.ceil(price / interval) * interval


def _nearest_zone(zones: list[Zone], price: float, side: str) -> Zone | None:
    """side='below' -> nearest support strictly under price; side='above'
    -> nearest resistance strictly over price. Mirrors regime_engine.py's
    own _nearest_zone - this module used to pick zones with a bare
    min(..., key=...) that never filtered by side, so a stale zone left
    behind on the WRONG side of price (e.g. a pre-selloff "resistance"
    that price has since fallen far below) could get picked as if it were
    a real nearby level, anchoring a strike tens of percent OTM. Confirmed
    live against real TCS data (a lone resistance zone at 3353-3385 vs a
    spot of 2200) before this fix."""
    candidates = [z for z in zones if (z.high <= price if side == "below" else z.low >= price)]
    if not candidates:
        return None
    key = (lambda z: price - z.high) if side == "below" else (lambda z: z.low - price)
    return min(candidates, key=key)


# The OLD _put_strike/_call_strike always took the MORE conservative
# (farther-from-spot) of the ATR target and the zone target - a real,
# CLOSER zone could never tighten a strike, only a farther one could push
# it out worse (see _MAX_ZONE_DISTANCE_ATR_MULTIPLE's own cap for that half
# of the problem). There was no floor a tighter anchor could ever use,
# because the ATR target itself was already acting as the tightest
# allowed value. This fraction of atr_multiple defines a genuine, separate
# safety floor - the nearest a strike is EVER allowed to sit to spot,
# regardless of how close a supporting order block or OI wall is - so an
# order-block/OI anchor can tighten a strike (closer to spot, more
# premium) down to this floor without regressing to "no anchor could ever
# help" or up to "anchor can put the strike anywhere, including unsafely
# close." Not derived from backtested data - a reasonable starting point,
# tune freely.
MIN_SAFETY_ATR_MULTIPLE_FRACTION = 0.5


def _unmitigated_block_anchor(
    weekly_blocks: list[OrderBlockZone] | None,
    daily_blocks: list[OrderBlockZone] | None,
    kind: str,
    close: float,
    atr14: float,
    atr_multiple: float,
) -> float | None:
    """Nearest still-standing (unmitigated) order block of `kind`
    ("demand" for a put anchor, "supply" for a call anchor) strictly on the
    correct side of `close`, within the same _MAX_ZONE_DISTANCE_ATR_MULTIPLE
    range technical zones are already capped to - returns the block's edge
    NEAREST to spot (the "first meaningful reaction point" a strike sits
    just behind), or None if no qualifying block exists on either
    timeframe. Weekly checked first, daily only consulted as a fallback -
    same "weekly outranks daily when they disagree" precedence
    regime_engine.py's own module docstring already establishes for votes
    generally.

    Mitigated blocks are excluded outright here (stricter than
    regime_engine.py's own _order_block_vote, which merely discounts a
    mitigated block's vote weight rather than dropping it) - a strike's
    whole job is to sit behind a level expected to hold, and "mitigated"
    means the market already broke through it once."""
    for blocks in (weekly_blocks, daily_blocks):
        if not blocks:
            continue
        candidates: list[float] = []
        for ob in blocks:
            if ob.mitigated or ob.kind != kind:
                continue
            low, high = min(ob.proximal, ob.distal), max(ob.proximal, ob.distal)
            if kind == "demand":
                if high > close:  # not actually below spot - not a support candidate
                    continue
                nearest_edge = high
            else:
                if low < close:
                    continue
                nearest_edge = low
            if not _zone_within_range(nearest_edge, close, atr14, atr_multiple):
                continue
            candidates.append(nearest_edge)
        if candidates:
            return min(candidates, key=lambda p: abs(close - p))
    return None


def _best_oi_strike(oi: OISnapshot | None, option_type: str, low: float, high: float) -> float | None:
    """The strike with the most open interest on `option_type` ("PE" for a
    put anchor's candidate band, "CE" for a call anchor's) within [low,
    high] inclusive - a real, liquid, market-corroborated level. Only ever
    consulted within a band the ATR/order-block anchoring already
    established (never used to relax the safety floor itself) - "the
    system can also use OI data to determine best return legs," scoped to
    strikes that were already going to be safe to use. None when OI isn't
    available or nothing in that band has any recorded OI this cycle."""
    if oi is None or not oi.available or not oi.by_strike:
        return None
    lo, hi = min(low, high), max(low, high)
    candidates = [row for row in oi.by_strike if row.option_type == option_type and lo <= row.strike <= hi]
    if not candidates:
        return None
    return max(candidates, key=lambda r: r.oi).strike


def _put_strike(
    support: Zone | None, close: float, atr14: float, strike_interval: float, atr_multiple: float,
    order_block_anchor: float | None = None, oi: OISnapshot | None = None,
) -> float:
    atr_target = close - atr_multiple * atr14
    min_safety_target = close - atr_multiple * MIN_SAFETY_ATR_MULTIPLE_FRACTION * atr14
    if order_block_anchor is not None:
        # Clamp the order block's own level between the two bounds - used
        # as-is when it's already inside them (a genuinely close, still-
        # standing structure produces a tighter, higher-premium strike
        # than the old always-conservative pick), pulled back to whichever
        # bound it overshoots otherwise.
        raw = min(max(order_block_anchor, atr_target), min_safety_target)
    else:
        best_oi = _best_oi_strike(oi, "PE", low=atr_target, high=min_safety_target)
        if best_oi is not None:
            raw = best_oi
        else:
            zone_target = support.low if support else atr_target
            raw = min(atr_target, zone_target)  # unchanged fallback - the lower (safer) of the two constraints
    return round_to_strike(raw, strike_interval, "down")


def _call_strike(
    resistance: Zone | None, close: float, atr14: float, strike_interval: float, atr_multiple: float,
    order_block_anchor: float | None = None, oi: OISnapshot | None = None,
) -> float:
    atr_target = close + atr_multiple * atr14
    min_safety_target = close + atr_multiple * MIN_SAFETY_ATR_MULTIPLE_FRACTION * atr14
    if order_block_anchor is not None:
        raw = max(min(order_block_anchor, atr_target), min_safety_target)
    else:
        best_oi = _best_oi_strike(oi, "CE", low=atr_target, high=min_safety_target)
        if best_oi is not None:
            raw = best_oi
        else:
            zone_target = resistance.high if resistance else atr_target
            raw = max(atr_target, zone_target)
    return round_to_strike(raw, strike_interval, "up")


def _wing_put_strike(main_strike: float, atr14: float, strike_interval: float, extra_atr_multiple: float) -> float:
    """Protective buy-leg for a short put, anchored to the SHORT strike
    actually chosen (not recomputed from spot) - guarantees the wing is
    always farther OTM than what it's protecting, however far a zone
    pushed the main strike. Recomputing independently from spot (the
    original approach) could put the wing CLOSER to money than the short
    leg whenever the short strike was anchored to a zone farther out than
    the wing's own ATR multiple would reach - confirmed live: real TCS
    data produced a sell-3400/buy-2450 call spread, the buy leg cheaper
    AND closer to money than the leg it was meant to cap - not a valid
    defined-risk structure."""
    return round_to_strike(main_strike - extra_atr_multiple * atr14, strike_interval, "down")


def _wing_call_strike(main_strike: float, atr14: float, strike_interval: float, extra_atr_multiple: float) -> float:
    return round_to_strike(main_strike + extra_atr_multiple * atr14, strike_interval, "up")


# How far a technical zone is allowed to push a strike beyond the plain
# ATR target before it's discarded as an anchor - a multiple of the
# ATR distance itself (atr_multiple * atr14), not a fixed price/percent,
# so it scales with each stock's own volatility the same way every other
# distance in this module already does. _put_strike/_call_strike take
# min/max(atr_target, zone_target) - i.e. whichever is FURTHER from spot,
# on the theory that the more conservative (lower-premium, safer) strike
# wins. That's fine when the nearest zone is a genuine, reasonably close
# level (MFSL's real 1433-1467 support, ~0.5xATR away, is exactly this)
# but a *stale* zone can sit many ATRs away from a name that's since
# trended hard (confirmed live 2026-09-12: MAHABANK's nearest support was
# 5.4xATR below spot, TITAN's 5.7xATR - both produced 20-35% OTM strikes,
# effectively worthless premium, not a sane weekly short-premium strike).
# Zones beyond this cap are treated as "no zone available", falling back
# to the pure ATR target instead.
_MAX_ZONE_DISTANCE_ATR_MULTIPLE = 2.5


def _zone_within_range(zone_price: float, close: float, atr14: float, atr_multiple: float) -> bool:
    return abs(close - zone_price) <= _MAX_ZONE_DISTANCE_ATR_MULTIPLE * atr_multiple * atr14


def select_strategy(
    regime: RegimeAssessment,
    technical: TechnicalSnapshot,
    corporate_event: CorporateEvent | None,
    expiry_date: date,
    as_of: date,
    strike_interval: float,
    atr_multiple: float = DEFAULT_ATR_MULTIPLE,
    defined_risk: bool = True,
    exit_rule: ExitRule = DEFAULT_EXIT_RULE,
    order_blocks: list[OrderBlockZone] | None = None,
    daily_order_blocks: list[OrderBlockZone] | None = None,
    oi: OISnapshot | None = None,
) -> StrategyRecommendation:
    days_to_expiry = (expiry_date - as_of).days
    entry_window = EntryWindow(earliest=as_of, latest=expiry_date, days_to_expiry_at_entry=days_to_expiry)

    if corporate_event and corporate_event.inside_decision_window:
        return StrategyRecommendation(
            action="avoid_new_entry", legs=[], entry_window=entry_window, exit_rule=exit_rule,
        )

    if days_to_expiry < MIN_DAYS_TO_EXPIRY_FOR_NEW_ENTRY:
        return StrategyRecommendation(
            action="close_existing", legs=[], entry_window=entry_window, exit_rule=exit_rule,
        )

    close = technical.close
    atr14 = technical.atr14

    # Screen out names too quiet to be worth a weekly premium-selling trade
    # at all - no amount of anchoring below manufactures premium a
    # genuinely low-range, thin stock doesn't have. Checked before any of
    # the strike-anchoring work, same "give up early" style as the two
    # hard blocks above.
    if close > 0 and (atr14 / close) < MIN_ATR_PCT_OF_CLOSE:
        return StrategyRecommendation(
            action="avoid_new_entry", legs=[], entry_window=entry_window, exit_rule=exit_rule,
        )
    if technical.volume_sma20 * close < MIN_AVG_DAILY_TRADED_VALUE:
        return StrategyRecommendation(
            action="avoid_new_entry", legs=[], entry_window=entry_window, exit_rule=exit_rule,
        )

    support = _nearest_zone(technical.support_zones, close, "below")
    resistance = _nearest_zone(technical.resistance_zones, close, "above")
    if support is not None and not _zone_within_range(support.low, close, atr14, atr_multiple):
        support = None
    if resistance is not None and not _zone_within_range(resistance.high, close, atr14, atr_multiple):
        resistance = None
    # Order-block anchors take priority over the technical Zone anchor
    # above when a valid one exists on that side (see _unmitigated_block_
    # anchor and _put_strike/_call_strike's own docstrings) - computed
    # once here, threaded into every _put_strike/_call_strike call site
    # below rather than recomputed per branch.
    put_order_block_anchor = _unmitigated_block_anchor(order_blocks, daily_order_blocks, "demand", close, atr14, atr_multiple)
    call_order_block_anchor = _unmitigated_block_anchor(order_blocks, daily_order_blocks, "supply", close, atr14, atr_multiple)
    # The wing's OWN extra distance beyond the main strike, not an
    # independent ATR target from spot - see _wing_put_strike/_wing_call_strike.
    wing_atr_multiple = atr_multiple * 0.5

    def _put_basis() -> str:
        if put_order_block_anchor is not None:
            return f"unmitigated demand order block ~{put_order_block_anchor:.2f}"
        if support:
            return f"nearest support {support.low}-{support.high} / {atr_multiple}xATR"
        return f"{atr_multiple}xATR below spot, no zone available"

    def _call_basis() -> str:
        if call_order_block_anchor is not None:
            return f"unmitigated supply order block ~{call_order_block_anchor:.2f}"
        if resistance:
            return f"nearest resistance {resistance.low}-{resistance.high} / {atr_multiple}xATR"
        return f"{atr_multiple}xATR above spot, no zone available"

    if regime.trend_strength == "ranging":
        put_k = _put_strike(support, close, atr14, strike_interval, atr_multiple, put_order_block_anchor, oi)
        call_k = _call_strike(resistance, close, atr14, strike_interval, atr_multiple, call_order_block_anchor, oi)
        legs = [
            StrategyLeg(option_type="PE", strike=put_k, side="sell", basis=_put_basis()),
            StrategyLeg(option_type="CE", strike=call_k, side="sell", basis=_call_basis()),
        ]
        if defined_risk:
            legs.append(StrategyLeg(option_type="PE", strike=_wing_put_strike(put_k, atr14, strike_interval, wing_atr_multiple), side="buy",
                                     basis="protective wing, caps downside on the short put"))
            legs.append(StrategyLeg(option_type="CE", strike=_wing_call_strike(call_k, atr14, strike_interval, wing_atr_multiple), side="buy",
                                     basis="protective wing, caps downside on the short call"))
            action = "iron_condor"
        else:
            action = "short_strangle"
        return StrategyRecommendation(action=action, legs=legs, entry_window=entry_window, exit_rule=exit_rule)

    if regime.bias == "bullish":
        put_k = _put_strike(support, close, atr14, strike_interval, atr_multiple, put_order_block_anchor, oi)
        legs = [StrategyLeg(option_type="PE", strike=put_k, side="sell",
                             basis=_put_basis()
                                   + f", >= {atr_multiple}xATR ({atr14:.1f}) below spot {close:.2f}"
                                   + ("" if regime.trend_strength == "trending" else " -- decelerating trend, size down vs. a full-conviction entry"))]
        if defined_risk:
            legs.append(StrategyLeg(option_type="PE", strike=_wing_put_strike(put_k, atr14, strike_interval, wing_atr_multiple), side="buy",
                                     basis="protective wing"))
        return StrategyRecommendation(action="sell_otm_put", legs=legs, entry_window=entry_window, exit_rule=exit_rule)

    if regime.bias == "bearish":
        call_k = _call_strike(resistance, close, atr14, strike_interval, atr_multiple, call_order_block_anchor, oi)
        legs = [StrategyLeg(option_type="CE", strike=call_k, side="sell",
                             basis=_call_basis()
                                   + f", >= {atr_multiple}xATR ({atr14:.1f}) above spot {close:.2f}"
                                   + ("" if regime.trend_strength == "trending" else " -- decelerating trend, size down vs. a full-conviction entry"))]
        if defined_risk:
            legs.append(StrategyLeg(option_type="CE", strike=_wing_call_strike(call_k, atr14, strike_interval, wing_atr_multiple), side="buy",
                                     basis="protective wing"))
        return StrategyRecommendation(action="sell_otm_call", legs=legs, entry_window=entry_window, exit_rule=exit_rule)

    # neutral bias, not ranging by ADX (e.g. votes cancelled out) -- default to the
    # defined-risk non-directional play rather than guessing a side
    put_k = _put_strike(support, close, atr14, strike_interval, atr_multiple, put_order_block_anchor, oi)
    call_k = _call_strike(resistance, close, atr14, strike_interval, atr_multiple, call_order_block_anchor, oi)
    legs = [
        StrategyLeg(option_type="PE", strike=put_k, side="sell", basis="neutral bias fallback -- treat as range"),
        StrategyLeg(option_type="CE", strike=call_k, side="sell", basis="neutral bias fallback -- treat as range"),
    ]
    return StrategyRecommendation(action="short_strangle", legs=legs, entry_window=entry_window, exit_rule=exit_rule)
