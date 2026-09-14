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
    RegimeAssessment,
    StrategyLeg,
    StrategyRecommendation,
    TechnicalSnapshot,
    Zone,
)

MIN_DAYS_TO_EXPIRY_FOR_NEW_ENTRY = 7
DEFAULT_ATR_MULTIPLE = 1.0
DEFAULT_EXIT_RULE = ExitRule(target_pct_of_max_profit=0.65, hard_exit_days_before_expiry=5)


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


def _put_strike(support: Zone | None, close: float, atr14: float, strike_interval: float, atr_multiple: float) -> float:
    atr_target = close - atr_multiple * atr14
    zone_target = support.low if support else atr_target
    raw = min(atr_target, zone_target)  # the lower (safer) of the two constraints
    return round_to_strike(raw, strike_interval, "down")


def _call_strike(resistance: Zone | None, close: float, atr14: float, strike_interval: float, atr_multiple: float) -> float:
    atr_target = close + atr_multiple * atr14
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
    support = _nearest_zone(technical.support_zones, close, "below")
    resistance = _nearest_zone(technical.resistance_zones, close, "above")
    if support is not None and not _zone_within_range(support.low, close, atr14, atr_multiple):
        support = None
    if resistance is not None and not _zone_within_range(resistance.high, close, atr14, atr_multiple):
        resistance = None
    # The wing's OWN extra distance beyond the main strike, not an
    # independent ATR target from spot - see _wing_put_strike/_wing_call_strike.
    wing_atr_multiple = atr_multiple * 0.5

    if regime.trend_strength == "ranging":
        put_k = _put_strike(support, close, atr14, strike_interval, atr_multiple)
        call_k = _call_strike(resistance, close, atr14, strike_interval, atr_multiple)
        legs = [
            StrategyLeg(option_type="PE", strike=put_k, side="sell",
                        basis=f"nearest support {support.low}-{support.high} / {atr_multiple}xATR" if support else f"{atr_multiple}xATR below spot, no zone available"),
            StrategyLeg(option_type="CE", strike=call_k, side="sell",
                        basis=f"nearest resistance {resistance.low}-{resistance.high} / {atr_multiple}xATR" if resistance else f"{atr_multiple}xATR above spot, no zone available"),
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
        put_k = _put_strike(support, close, atr14, strike_interval, atr_multiple)
        legs = [StrategyLeg(option_type="PE", strike=put_k, side="sell",
                             basis=(f"support {support.low}-{support.high}" if support else "no zone")
                                   + f", >= {atr_multiple}xATR ({atr14:.1f}) below spot {close:.2f}"
                                   + ("" if regime.trend_strength == "trending" else " -- decelerating trend, size down vs. a full-conviction entry"))]
        if defined_risk:
            legs.append(StrategyLeg(option_type="PE", strike=_wing_put_strike(put_k, atr14, strike_interval, wing_atr_multiple), side="buy",
                                     basis="protective wing"))
        return StrategyRecommendation(action="sell_otm_put", legs=legs, entry_window=entry_window, exit_rule=exit_rule)

    if regime.bias == "bearish":
        call_k = _call_strike(resistance, close, atr14, strike_interval, atr_multiple)
        legs = [StrategyLeg(option_type="CE", strike=call_k, side="sell",
                             basis=(f"resistance {resistance.low}-{resistance.high}" if resistance else "no zone")
                                   + f", >= {atr_multiple}xATR ({atr14:.1f}) above spot {close:.2f}"
                                   + ("" if regime.trend_strength == "trending" else " -- decelerating trend, size down vs. a full-conviction entry"))]
        if defined_risk:
            legs.append(StrategyLeg(option_type="CE", strike=_wing_call_strike(call_k, atr14, strike_interval, wing_atr_multiple), side="buy",
                                     basis="protective wing"))
        return StrategyRecommendation(action="sell_otm_call", legs=legs, entry_window=entry_window, exit_rule=exit_rule)

    # neutral bias, not ranging by ADX (e.g. votes cancelled out) -- default to the
    # defined-risk non-directional play rather than guessing a side
    put_k = _put_strike(support, close, atr14, strike_interval, atr_multiple)
    call_k = _call_strike(resistance, close, atr14, strike_interval, atr_multiple)
    legs = [
        StrategyLeg(option_type="PE", strike=put_k, side="sell", basis="neutral bias fallback -- treat as range"),
        StrategyLeg(option_type="CE", strike=call_k, side="sell", basis="neutral bias fallback -- treat as range"),
    ]
    return StrategyRecommendation(action="short_strangle", legs=legs, entry_window=entry_window, exit_rule=exit_rule)
