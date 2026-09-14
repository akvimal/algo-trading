"""Regression tests for strategy_selector.py fixes found while validating
this module against real NSE data:

1. _nearest_zone must filter to the correct side of price (a stale
   wrong-side zone must never anchor a strike).
2. A protective wing leg must always be farther OTM than the main strike
   it protects, however far a zone pushed that main strike out - the wing
   is anchored off the chosen main strike, not recomputed independently
   from spot.
3. A real but very stale/distant zone (many ATRs from spot) must not
   anchor a strike at all - confirmed live 2026-09-12 against MAHABANK
   (nearest support 5.4xATR below spot -> a ~35% OTM put) and TITAN
   (5.7xATR -> ~22% OTM) - both fall back to the plain ATR target instead.
"""
from datetime import date, timedelta

from app.domain.weekly_advisor.contracts import RegimeAssessment, TechnicalSnapshot, Zone
from app.domain.weekly_advisor.strategy_selector import _nearest_zone, _zone_within_range, select_strategy

FAR_EXPIRY = date(2026, 1, 1) + timedelta(days=30)
AS_OF = date(2026, 1, 1)


def _snapshot(close: float, support_zones=None, resistance_zones=None) -> TechnicalSnapshot:
    return TechnicalSnapshot(
        timeframe="weekly", close=close, ema20=close, ema50=close,
        adx14=15.0, adx14_slope="flat", atr14=close * 0.03,
        support_zones=support_zones or [], resistance_zones=resistance_zones or [],
        volume=1.0, volume_sma20=1.0, volume_confirmed=True,
    )


def test_nearest_zone_ignores_zone_on_the_wrong_side_of_price():
    # A stale "resistance" zone left far ABOVE a price that has since
    # fallen well below it must never be picked as the nearest resistance
    # when we're asking for support below price.
    zones = [Zone(low=3353, high=3385, basis="stale pre-selloff resistance")]
    assert _nearest_zone(zones, price=2200, side="below") is None
    assert _nearest_zone(zones, price=2200, side="above").low == 3353


def test_wing_strike_always_farther_otm_than_main_strike_for_call_side():
    # Resistance zone anchors the main call strike farther OTM than a bare
    # ATR multiple from spot would reach on its own - but still within
    # _MAX_ZONE_DISTANCE_ATR_MULTIPLE, so it's actually used as the anchor
    # (a zone beyond that cap is discarded entirely - see
    # test_far_zone_beyond_cap_is_ignored_in_favor_of_pure_atr_target
    # below). The wing must still land even farther out, never closer to
    # money than the main strike.
    close = 2200.0
    resistance = Zone(low=2340, high=2360, basis="real, moderately distant resistance")
    regime = RegimeAssessment(bias="bearish", trend_strength="trending", confidence=0.8, reasons=[])
    snapshot = _snapshot(close, resistance_zones=[resistance])

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=FAR_EXPIRY, as_of=AS_OF, strike_interval=50.0,
    )

    sell_leg = next(leg for leg in rec.legs if leg.side == "sell")
    buy_leg = next(leg for leg in rec.legs if leg.side == "buy")
    assert sell_leg.strike >= resistance.high
    assert buy_leg.strike > sell_leg.strike, "protective wing must be farther OTM than the leg it protects"


def test_zone_within_range_accepts_a_close_zone_and_rejects_a_distant_one():
    # close=100, atr14=5, atr_multiple=1.0 -> cap is 2.5 * 1.0 * 5 = 12.5
    assert _zone_within_range(zone_price=95.0, close=100.0, atr14=5.0, atr_multiple=1.0) is True  # 1xATR away
    assert _zone_within_range(zone_price=88.0, close=100.0, atr14=5.0, atr_multiple=1.0) is True  # 2.4xATR away - just within cap
    assert _zone_within_range(zone_price=80.0, close=100.0, atr14=5.0, atr_multiple=1.0) is False  # 4xATR away - beyond cap


def test_far_zone_beyond_cap_is_ignored_in_favor_of_pure_atr_target():
    # Mirrors MAHABANK live: a real support zone sitting ~5.4xATR below
    # spot must be discarded, falling back to the plain ATR-based target
    # instead of anchoring a ~35%-OTM strike.
    close = 84.20
    atr14 = 5.3
    support = Zone(low=55.54, high=56.21, basis="real but very stale support")
    regime = RegimeAssessment(bias="bullish", trend_strength="trending", confidence=0.8, reasons=[])
    snapshot = TechnicalSnapshot(
        timeframe="weekly", close=close, ema20=close, ema50=close,
        adx14=25.0, adx14_slope="rising", atr14=atr14,
        support_zones=[support], resistance_zones=[],
        volume=1.0, volume_sma20=1.0, volume_confirmed=True,
    )

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=FAR_EXPIRY, as_of=AS_OF, strike_interval=1.0,
    )

    sell_leg = next(leg for leg in rec.legs if leg.side == "sell")
    atr_target = close - 1.0 * atr14  # DEFAULT_ATR_MULTIPLE
    assert sell_leg.strike == 78.0  # floor(atr_target) at strike_interval=1.0 - the plain ATR target, not the stale zone
    assert sell_leg.strike > support.low  # the stale zone must NOT have anchored this strike
    assert "no zone" in sell_leg.basis
