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
4. An unmitigated, in-range order block may TIGHTEN a strike closer to
   spot than the plain ATR target (more premium) - the old zone-only logic
   could only ever push a strike FARTHER out, never closer, since it took
   the more conservative of the two candidates unconditionally.
5. A mitigated or too-distant order block is ignored, same as a stale zone.
6. Low ATR% or low average daily traded value screens a symbol out
   entirely (avoid_new_entry) - no anchor can manufacture premium a
   genuinely quiet/thin stock doesn't have.
7. OI concentration can anchor a strike when no order block is available.
"""
from datetime import date, timedelta

from app.domain.weekly_advisor.contracts import OISnapshot, RegimeAssessment, StrategyLeg, StrikeOI, TechnicalSnapshot, Zone
from app.domain.weekly_advisor.regime_engine import OrderBlockZone
from app.domain.weekly_advisor.strategy_selector import (
    MIN_STRIKE_OI_NEAR_EXPIRY,
    _nearest_zone,
    _sell_legs_liquid_enough,
    _zone_within_range,
    select_strategy,
)

FAR_EXPIRY = date(2026, 1, 1) + timedelta(days=30)
AS_OF = date(2026, 1, 1)


def _snapshot(close: float, support_zones=None, resistance_zones=None) -> TechnicalSnapshot:
    return TechnicalSnapshot(
        timeframe="weekly", close=close, ema20=close, ema50=close,
        adx14=15.0, adx14_slope="flat", atr14=close * 0.03,
        support_zones=support_zones or [], resistance_zones=resistance_zones or [],
        # Comfortably clears MIN_AVG_DAILY_TRADED_VALUE regardless of `close`
        # - these fixtures are testing zone/strike anchoring, not the
        # volatility/liquidity screen, so volume here is a plain "not the
        # thing under test" placeholder, just no longer a degenerate one.
        volume=2_000_000.0, volume_sma20=2_000_000.0, volume_confirmed=True,
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
        volume=2_000_000.0, volume_sma20=2_000_000.0, volume_confirmed=True,
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


def test_unmitigated_order_block_tightens_a_bullish_put_strike():
    # _snapshot's atr14 = close*0.03 = 30, atr_multiple=1.0 (default) ->
    # atr_target=970, min_safety_target = 1000 - 0.5*30 = 985. A demand
    # block whose near edge sits at 985 is right at (inside) that band, so
    # it should be used as-is - tighter (closer to spot, more premium)
    # than the plain 970 ATR target the old zone-only logic would have
    # produced (a real, closer zone could never win before this change -
    # only a farther one could ever move the strike, and only for the worse).
    close = 1000.0
    regime = RegimeAssessment(bias="bullish", trend_strength="trending", confidence=0.8, reasons=[])
    snapshot = _snapshot(close)
    demand_block = OrderBlockZone(kind="demand", proximal=985.0, distal=970.0, mitigated=False)

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=FAR_EXPIRY, as_of=AS_OF, strike_interval=5.0,
        order_blocks=[demand_block],
    )

    sell_leg = next(leg for leg in rec.legs if leg.side == "sell")
    assert sell_leg.strike == 985.0
    assert sell_leg.strike > 970.0  # tighter than the plain ATR target
    assert sell_leg.strike <= 985.0  # never tighter than the safety floor
    assert "order block" in sell_leg.basis


def test_mitigated_order_block_is_ignored_in_favor_of_plain_atr_target():
    close = 1000.0
    regime = RegimeAssessment(bias="bullish", trend_strength="trending", confidence=0.8, reasons=[])
    snapshot = _snapshot(close)
    demand_block = OrderBlockZone(kind="demand", proximal=985.0, distal=970.0, mitigated=True)

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=FAR_EXPIRY, as_of=AS_OF, strike_interval=5.0,
        order_blocks=[demand_block],
    )

    sell_leg = next(leg for leg in rec.legs if leg.side == "sell")
    assert sell_leg.strike == 970.0  # plain ATR target (close - atr_multiple*atr14, atr14=close*0.03) - the mitigated block must not anchor anything


def test_order_block_beyond_max_zone_distance_is_ignored():
    close = 1000.0
    atr14 = close * 0.03  # 30.0, matching _snapshot's own atr14
    # 2.5xATR cap = 75 - a block 200 below spot is well beyond it.
    demand_block = OrderBlockZone(kind="demand", proximal=800.0, distal=790.0, mitigated=False)
    regime = RegimeAssessment(bias="bullish", trend_strength="trending", confidence=0.8, reasons=[])
    snapshot = _snapshot(close)

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=FAR_EXPIRY, as_of=AS_OF, strike_interval=5.0,
        order_blocks=[demand_block],
    )

    sell_leg = next(leg for leg in rec.legs if leg.side == "sell")
    assert sell_leg.strike == close - atr14  # plain ATR target, block discarded as too far


def test_low_atr_pct_screens_the_symbol_out_entirely():
    # atr14/close = 0.3% - well under MIN_ATR_PCT_OF_CLOSE (1.5%).
    close = 1000.0
    snapshot = TechnicalSnapshot(
        timeframe="weekly", close=close, ema20=close, ema50=close,
        adx14=15.0, adx14_slope="flat", atr14=3.0,
        support_zones=[], resistance_zones=[],
        volume=2_000_000.0, volume_sma20=2_000_000.0, volume_confirmed=True,
    )
    regime = RegimeAssessment(bias="bullish", trend_strength="trending", confidence=0.8, reasons=[])

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=FAR_EXPIRY, as_of=AS_OF, strike_interval=5.0,
    )

    assert rec.action == "avoid_new_entry"
    assert rec.legs == []


def test_low_average_daily_traded_value_screens_the_symbol_out_entirely():
    # volume_sma20 * close = 1000 * 1000 = Rs 10 lakh/day - well under
    # MIN_AVG_DAILY_TRADED_VALUE (Rs 5 crore/day).
    close = 1000.0
    snapshot = TechnicalSnapshot(
        timeframe="weekly", close=close, ema20=close, ema50=close,
        adx14=15.0, adx14_slope="flat", atr14=close * 0.03,
        support_zones=[], resistance_zones=[],
        volume=1000.0, volume_sma20=1000.0, volume_confirmed=True,
    )
    regime = RegimeAssessment(bias="bullish", trend_strength="trending", confidence=0.8, reasons=[])

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=FAR_EXPIRY, as_of=AS_OF, strike_interval=5.0,
    )

    assert rec.action == "avoid_new_entry"
    assert rec.legs == []


def test_oi_concentration_anchors_a_strike_when_no_order_block_available():
    # close=1000, atr14=20 (_snapshot's own atr14=close*0.03=30 - use a
    # custom snapshot here so the band math matches the earlier order-block
    # tests exactly: atr_target=980, min_safety_target=990). The PE strike
    # with the most OI inside that band (985) should win over the plain
    # ATR target, same as a validated order block would - "the system can
    # also use OI data to determine best return legs."
    close = 1000.0
    atr14 = 20.0
    snapshot = TechnicalSnapshot(
        timeframe="weekly", close=close, ema20=close, ema50=close,
        adx14=15.0, adx14_slope="flat", atr14=atr14,
        support_zones=[], resistance_zones=[],
        volume=2_000_000.0, volume_sma20=2_000_000.0, volume_confirmed=True,
    )
    oi = OISnapshot(
        available=True,
        by_strike=[
            StrikeOI(strike=980.0, option_type="PE", oi=100.0, oi_change=10.0, buildup="long_buildup"),
            StrikeOI(strike=985.0, option_type="PE", oi=99999.0, oi_change=10.0, buildup="long_buildup"),
            StrikeOI(strike=990.0, option_type="PE", oi=500.0, oi_change=10.0, buildup="long_buildup"),
        ],
    )
    regime = RegimeAssessment(bias="bullish", trend_strength="trending", confidence=0.8, reasons=[])

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=FAR_EXPIRY, as_of=AS_OF, strike_interval=5.0,
        oi=oi,
    )

    sell_leg = next(leg for leg in rec.legs if leg.side == "sell")
    assert sell_leg.strike == 985.0
    # basis must actually say OI, not a stale "nearest support" label from
    # a separately-guessed text (confirmed live 2026-09-22: a real
    # RELIANCE run hit exactly this drift - the OI branch picked the
    # strike but the old text unconditionally said "nearest support").
    assert "OI" in sell_leg.basis


# --- neutral-bias (not ranging) fallback must respect defined_risk, same as every other branch ---


def test_neutral_bias_fallback_builds_iron_condor_when_defined_risk():
    close = 1000.0
    regime = RegimeAssessment(bias="neutral", trend_strength="trending", confidence=0.5, reasons=[])
    snapshot = _snapshot(close)

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=FAR_EXPIRY, as_of=AS_OF, strike_interval=5.0,
        defined_risk=True,
    )

    assert rec.action == "iron_condor"
    assert len(rec.legs) == 4
    assert sum(1 for leg in rec.legs if leg.side == "buy") == 2


def test_neutral_bias_fallback_builds_short_strangle_when_not_defined_risk():
    close = 1000.0
    regime = RegimeAssessment(bias="neutral", trend_strength="trending", confidence=0.5, reasons=[])
    snapshot = _snapshot(close)

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=FAR_EXPIRY, as_of=AS_OF, strike_interval=5.0,
        defined_risk=False,
    )

    assert rec.action == "short_strangle"
    assert len(rec.legs) == 2
    assert all(leg.side == "sell" for leg in rec.legs)


# --- near-expiry gating: hard cutoff below 2 days, liquidity-gated between 2-7 ---


def test_inside_hard_cutoff_always_blocks_new_entry_even_with_ample_liquidity():
    # 1 day to expiry - below MIN_DAYS_TO_EXPIRY_HARD_CUTOFF (2). Must be
    # close_existing unconditionally, even though the OI snapshot below
    # would easily clear the liquidity gate if it were consulted at all.
    close = 1000.0
    regime = RegimeAssessment(bias="bullish", trend_strength="trending", confidence=0.8, reasons=[])
    snapshot = _snapshot(close)
    demand_block = OrderBlockZone(kind="demand", proximal=985.0, distal=970.0, mitigated=False)
    oi = OISnapshot(available=True, by_strike=[StrikeOI(strike=985.0, option_type="PE", oi=99999.0, oi_change=10.0, buildup="long_buildup")])

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=AS_OF + timedelta(days=1), as_of=AS_OF, strike_interval=5.0,
        order_blocks=[demand_block], oi=oi,
    )

    assert rec.action == "close_existing"
    assert rec.legs == []


def test_caution_window_allows_entry_when_sell_strike_clears_liquidity_gate():
    # 5 days to expiry - inside the 2-7 day caution window. Same
    # order-block-anchored bullish setup as
    # test_unmitigated_order_block_tightens_a_bullish_put_strike (sell PE
    # strike lands at 985.0), now with real OI at that exact strike -
    # should go through as a normal sell_otm_put, not get downgraded.
    close = 1000.0
    regime = RegimeAssessment(bias="bullish", trend_strength="trending", confidence=0.8, reasons=[])
    snapshot = _snapshot(close)
    demand_block = OrderBlockZone(kind="demand", proximal=985.0, distal=970.0, mitigated=False)
    oi = OISnapshot(available=True, by_strike=[StrikeOI(strike=985.0, option_type="PE", oi=float(MIN_STRIKE_OI_NEAR_EXPIRY), oi_change=10.0, buildup="long_buildup")])

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=AS_OF + timedelta(days=5), as_of=AS_OF, strike_interval=5.0,
        order_blocks=[demand_block], oi=oi,
    )

    assert rec.action == "sell_otm_put"
    sell_leg = next(leg for leg in rec.legs if leg.side == "sell")
    assert sell_leg.strike == 985.0


def test_caution_window_downgrades_to_close_existing_when_sell_strike_is_illiquid():
    # Same setup as above, but the OI snapshot at the actual sell strike
    # (985.0) is below MIN_STRIKE_OI_NEAR_EXPIRY - the position couldn't be
    # exited early with confidence, so the whole recommendation downgrades
    # to close_existing (empty legs) instead of handing back an
    # unexitable near-expiry short.
    close = 1000.0
    regime = RegimeAssessment(bias="bullish", trend_strength="trending", confidence=0.8, reasons=[])
    snapshot = _snapshot(close)
    demand_block = OrderBlockZone(kind="demand", proximal=985.0, distal=970.0, mitigated=False)
    oi = OISnapshot(available=True, by_strike=[StrikeOI(strike=985.0, option_type="PE", oi=MIN_STRIKE_OI_NEAR_EXPIRY - 1.0, oi_change=10.0, buildup="long_buildup")])

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=AS_OF + timedelta(days=5), as_of=AS_OF, strike_interval=5.0,
        order_blocks=[demand_block], oi=oi,
    )

    assert rec.action == "close_existing"
    assert rec.legs == []


def test_caution_window_downgrades_to_close_existing_when_no_oi_data_available():
    # No OI snapshot at all inside the caution window - fails safe as
    # "not liquid enough" rather than assuming a strike is exitable with no
    # actual data behind that assumption.
    close = 1000.0
    regime = RegimeAssessment(bias="bullish", trend_strength="trending", confidence=0.8, reasons=[])
    snapshot = _snapshot(close)
    demand_block = OrderBlockZone(kind="demand", proximal=985.0, distal=970.0, mitigated=False)

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=AS_OF + timedelta(days=5), as_of=AS_OF, strike_interval=5.0,
        order_blocks=[demand_block],
    )

    assert rec.action == "close_existing"
    assert rec.legs == []


def test_at_or_past_seven_days_ignores_liquidity_entirely():
    # Exactly at MIN_DAYS_TO_EXPIRY_FOR_NEW_ENTRY (7) - the liquidity gate
    # no longer applies at all, so a real strategy comes back even with no
    # OI data (same "far expiry" behavior every other test in this file
    # already relies on via FAR_EXPIRY, made explicit here at the boundary).
    close = 1000.0
    regime = RegimeAssessment(bias="bullish", trend_strength="trending", confidence=0.8, reasons=[])
    snapshot = _snapshot(close)
    demand_block = OrderBlockZone(kind="demand", proximal=985.0, distal=970.0, mitigated=False)

    rec = select_strategy(
        regime=regime, technical=snapshot, corporate_event=None,
        expiry_date=AS_OF + timedelta(days=7), as_of=AS_OF, strike_interval=5.0,
        order_blocks=[demand_block],
    )

    assert rec.action == "sell_otm_put"
    sell_leg = next(leg for leg in rec.legs if leg.side == "sell")
    assert sell_leg.strike == 985.0


def test_sell_legs_liquid_enough_ignores_buy_only_wing_legs():
    # A pure protective wing (buy side) carries no assignment/gamma risk of
    # its own - a leg list with no sell legs at all should never be gated.
    legs = [StrategyLeg(option_type="PE", strike=980.0, side="buy", basis="wing")]
    assert _sell_legs_liquid_enough(legs, oi=None) is True


def test_sell_legs_liquid_enough_fails_safe_when_oi_unavailable():
    legs = [StrategyLeg(option_type="PE", strike=985.0, side="sell", basis="short")]
    assert _sell_legs_liquid_enough(legs, oi=None) is False
    assert _sell_legs_liquid_enough(legs, oi=OISnapshot(available=False)) is False
