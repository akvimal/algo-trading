"""Tests for the order-block vote added to assess_regime (regime_engine.py)
- confirmed live 2026-09-13 against JUBLFOOD: weekly EMA50 alone can call a
  stock bearish while it sits inside a bullish weekly demand order block,
  a real, different signal this vote now surfaces (and can outweigh)."""
from app.domain.weekly_advisor.contracts import FundamentalSnapshot, OISnapshot, TechnicalSnapshot
from app.domain.weekly_advisor.regime_engine import OrderBlockZone, _fundamental_vote, _order_block_vote, assess_regime


def _snapshot(close: float, ema50: float, adx14: float = 15.0) -> TechnicalSnapshot:
    return TechnicalSnapshot(
        timeframe="weekly", close=close, ema20=close, ema50=ema50,
        adx14=adx14, adx14_slope="flat", atr14=close * 0.03,
        volume=1.0, volume_sma20=1.0, volume_confirmed=True,
    )


def test_order_block_vote_is_bullish_for_a_fresh_demand_zone_containing_price():
    zones = [OrderBlockZone(kind="demand", proximal=95.0, distal=90.0, mitigated=False)]
    vote = _order_block_vote(zones, close=92.0, timeframe="weekly")
    assert vote.direction == "bullish"
    assert vote.weight == 1.0
    assert "fresh" in vote.reason
    assert "weekly" in vote.reason


def test_order_block_vote_is_bearish_and_lower_weight_for_a_mitigated_supply_zone():
    zones = [OrderBlockZone(kind="supply", proximal=100.0, distal=105.0, mitigated=True)]
    vote = _order_block_vote(zones, close=102.0, timeframe="weekly")
    assert vote.direction == "bearish"
    assert vote.weight == 0.6
    assert "once-tested" in vote.reason


def test_order_block_vote_is_silent_when_price_is_outside_every_zone():
    zones = [OrderBlockZone(kind="demand", proximal=95.0, distal=90.0, mitigated=False)]
    vote = _order_block_vote(zones, close=150.0, timeframe="weekly")
    assert vote.direction is None
    assert vote.weight == 0.0


def test_order_block_vote_reason_reflects_the_given_timeframe():
    zones = [OrderBlockZone(kind="demand", proximal=95.0, distal=90.0, mitigated=False)]
    assert "daily" in _order_block_vote(zones, close=92.0, timeframe="daily").reason
    assert "daily" in _order_block_vote([], close=92.0, timeframe="daily").reason


def test_assess_regime_with_no_order_blocks_argument_omits_the_vote_entirely():
    # None (the default) means "couldn't fetch them" - silent, distinct
    # from an empty list ("fetched, found none") which still reports.
    assessment = assess_regime(primary=_snapshot(100.0, 100.0), oi=OISnapshot(available=False))
    assert not any("order block" in r for r in assessment.reasons)


def test_assess_regime_reports_no_order_block_when_list_is_empty():
    assessment = assess_regime(primary=_snapshot(100.0, 100.0), oi=OISnapshot(available=False), order_blocks=[])
    assert any("not sitting inside any weekly order block" in r for r in assessment.reasons)


def test_bullish_order_block_can_flip_bias_against_a_bearish_ema_read():
    # Mirrors JUBLFOOD live: weekly close below EMA50 alone reads bearish
    # (weight 1.0), but a fresh demand order block containing price votes
    # bullish at the same weight 1.0, cancelling it out to neutral rather
    # than silently letting EMA50 have the only say.
    snapshot = _snapshot(close=470.0, ema50=500.0)  # bearish EMA read
    zones = [OrderBlockZone(kind="demand", proximal=475.0, distal=460.0, mitigated=False)]

    assessment = assess_regime(primary=snapshot, oi=OISnapshot(available=False), order_blocks=zones)

    assert assessment.bias == "neutral"
    assert any("demand order block" in r for r in assessment.reasons)


def test_daily_order_block_votes_at_half_weight_and_never_alone_flips_bias():
    # The actual JUBLFOOD case: no weekly order block contains price at
    # all (order_blocks=[]), but a daily one does. The daily vote is
    # half-weight (same split as the daily EMA vote) - real enough to pull
    # confidence toward neutral, but on its own (1.0 weekly bearish EMA vs
    # 0.5 daily bullish OB) it can't flip bias outright.
    snapshot = _snapshot(close=470.25, ema50=500.09)  # weekly EMA reads bearish
    daily_zones = [OrderBlockZone(kind="demand", proximal=472.95, distal=461.60, mitigated=True)]

    assessment = assess_regime(
        primary=snapshot, oi=OISnapshot(available=False), order_blocks=[], daily_order_blocks=daily_zones,
    )

    assert assessment.bias == "bearish"  # weekly EMA (1.0) still outweighs daily OB (0.6 * 0.5 = 0.3)
    assert assessment.confidence < 1.0  # but confidence is pulled down from what EMA alone would give
    assert any("not sitting inside any weekly order block" in r for r in assessment.reasons)
    assert any("(daily, half-weight)" in r and "daily demand order block" in r for r in assessment.reasons)


def test_fundamental_vote_is_silent_when_unavailable():
    vote = _fundamental_vote(FundamentalSnapshot(available=False))
    assert vote.direction is None
    assert vote.weight == 0.0


def test_fundamental_vote_is_silent_when_read_neutral():
    vote = _fundamental_vote(FundamentalSnapshot(available=True, bias="neutral", confidence=0.9))
    assert vote.direction is None
    assert vote.weight == 0.0


def test_fundamental_vote_is_half_weighted_by_confidence():
    vote = _fundamental_vote(FundamentalSnapshot(available=True, bias="bullish", confidence=0.8, summary="Deleveraging."))
    assert vote.direction == "bullish"
    assert vote.weight == 0.4  # 0.8 * 0.5, same half-weight convention as the daily secondary votes
    assert "screener.in fundamentals read bullish" in vote.reason
    assert "Deleveraging." in vote.reason


def test_fundamental_vote_defaults_confidence_weight_when_none_given():
    vote = _fundamental_vote(FundamentalSnapshot(available=True, bias="bearish"))
    assert vote.weight == 0.25  # 0.5 default * 0.5 half-weight


def test_assess_regime_with_no_fundamental_argument_omits_the_vote_entirely():
    assessment = assess_regime(primary=_snapshot(100.0, 100.0), oi=OISnapshot(available=False))
    assert not any("fundamentals" in r for r in assessment.reasons)


def test_fundamental_vote_can_pull_confidence_down_against_a_bearish_ema_read():
    snapshot = _snapshot(close=470.0, ema50=500.0)  # bearish EMA read, weight 1.0
    fundamentals = FundamentalSnapshot(available=True, bias="bullish", confidence=1.0)  # half-weight -> 0.5

    assessment = assess_regime(primary=snapshot, oi=OISnapshot(available=False), fundamental=fundamentals)

    assert assessment.bias == "bearish"  # 1.0 still outweighs 0.5
    assert assessment.confidence < 1.0
    assert any("screener.in fundamentals read bullish" in r for r in assessment.reasons)
