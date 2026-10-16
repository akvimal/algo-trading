"""The 1-3 day OI swing shadow (app/domain/oi_swing_shadow.py): the criteria for a would-have-traded row, and what an entry would have done."""

from datetime import date

import pytest

from app.domain import oi_swing_shadow as s

QUIET_DAY = date(2026, 10, 15)  # well clear of the 27 Oct monthly expiry window


def zone(**o):
    base = {"zone_kind": "demand", "zone_distal": 95.0, "close": 100.0, "daily_trend": "up", "weekly_trend": "up", "weekly_zone": True, "weekly_agrees": True, "tier": "A", "oi_agrees": True}
    return {**base, **o}


OI = {"call_activity": "buying", "put_activity": "writing", "call_oi_change_pct": 6.0, "put_oi_change_pct": 9.0}
HISTORY = [{"call_oi_change_pct": c, "put_oi_change_pct": p} for c, p in [(1, 2), (-1, 1), (2, -2), (0, 1), (1, 0), (-2, 2)]]
SCREENER = {"adx": 28.0, "avg_turnover_cr": 500.0}


def run(z=None, oi=OI, history=HISTORY, screener=SCREENER, median=300.0, breadth=0.55, day=QUIET_DAY):
    return s.evaluate(z or zone(), oi, history, screener, median, breadth, day)


def test_a_demand_zone_with_call_buying_and_put_writing_is_a_long_that_would_have_been_taken():
    d = run()
    assert d["direction"] == "LONG" and d["taken"] and d["skip_reason"] is None
    assert d["stop_price"] == 95.0 and d["risk_pct"] == 5.0 and d["criteria"]["flow"]["source"] == "premium_flow"


def test_a_supply_zone_mirrors_it_into_a_short():
    d = run(zone(zone_kind="supply", zone_distal=105.0, daily_trend="down", weekly_trend="down"),
            oi={**OI, "call_activity": "writing", "put_activity": "buying"}, breadth=0.45)
    assert d["direction"] == "SHORT" and d["taken"]


def test_flow_against_the_trade_turns_it_away_even_when_the_rest_agrees():
    d = run(oi={**OI, "put_activity": "buying"})  # put buying is bearish: contrary to a long
    assert not d["taken"] and "flow" in d["skip_reason"]


def test_without_premium_flow_it_falls_back_to_the_price_based_agreement_and_says_so():
    d = run(oi={"call_activity": None, "put_activity": None, "call_oi_change_pct": 6.0, "put_oi_change_pct": 9.0})
    assert d["criteria"]["flow"]["source"] == "price_proxy" and d["criteria"]["flow"]["pass"] is True
    assert not run(zone(oi_agrees=False), oi={"call_activity": None, "put_activity": None})["taken"]


def test_the_oi_move_must_stand_out_from_that_stocks_own_recent_changes():
    assert run()["criteria"]["oi_surge"]["pass"] is True
    quiet = run(oi={**OI, "put_oi_change_pct": 1.0, "call_oi_change_pct": 1.0})
    assert quiet["criteria"]["oi_surge"]["pass"] is False and not quiet["taken"]


def test_too_little_history_is_not_evaluated_rather_than_failed():
    d = run(history=HISTORY[:2])
    assert d["criteria"]["oi_surge"]["pass"] is None and d["taken"]  # shown as unevaluated, not blocking


def test_a_trend_against_the_zone_or_a_weak_one_fails():
    assert not run(zone(daily_trend="range"))["taken"]
    assert "trend" in run(screener={**SCREENER, "adx": 12.0})["skip_reason"]


def test_a_weekly_picture_with_nothing_behind_it_fails():
    d = run(zone(weekly_zone=False, weekly_agrees=False, tier="C"))
    assert not d["taken"] and "weekly" in d["skip_reason"]


def test_a_thin_stock_is_left_out():
    assert "liquidity" in run(screener={**SCREENER, "avg_turnover_cr": 50.0})["skip_reason"]


def test_the_stop_must_be_a_sensible_distance_on_the_right_side():
    assert "risk" in run(zone(zone_distal=99.9))["skip_reason"]  # 0.1%: noise
    assert "risk" in run(zone(zone_distal=80.0))["skip_reason"]  # 20%: too wide to size
    assert "risk" in run(zone(zone_distal=105.0))["skip_reason"]  # a long whose stop is above the price


def test_the_days_around_the_monthly_expiry_are_skipped():
    assert s.near_monthly_expiry(date(2026, 10, 26)) and s.near_monthly_expiry(date(2026, 10, 27)) and s.near_monthly_expiry(date(2026, 10, 28))
    assert not s.near_monthly_expiry(QUIET_DAY)
    assert "expiry" in run(day=date(2026, 10, 26))["skip_reason"]


def test_a_one_sided_market_vetoes_a_trade_into_it():
    assert "market" in run(breadth=0.2)["skip_reason"]  # a long into a day where 80% of stocks fell
    assert "market" in run(zone(zone_kind="supply", zone_distal=105.0, daily_trend="down", weekly_trend="down"),
                           oi={**OI, "call_activity": "writing", "put_activity": "buying"}, breadth=0.85)["skip_reason"]


def test_a_better_tier_and_a_bigger_oi_move_score_higher():
    assert run()["score"] > run(zone(tier="B"))["score"] > run(zone(tier=None))["score"]


# --- the outcome ------------------------------------------------------------------------------------------------------------


def bar(o, h, lo, c):
    return {"open": o, "high": h, "low": lo, "close": c}


def test_a_long_hits_its_target_at_one_and_a_half_times_the_risk():
    # entry 100, stop 95 (risk 5), target 107.5
    out = s.resolve_outcome("LONG", 95.0, [bar(100, 104, 99, 103), bar(103, 108, 102, 107)])
    assert (out["result"], out["exit_day"], out["r_multiple"]) == ("target", 2, 1.5) and out["entry_price"] == 100.0


def test_a_long_stopped_out_loses_one_r_and_a_day_touching_both_counts_as_the_stop():
    assert s.resolve_outcome("LONG", 95.0, [bar(100, 101, 94, 96)])["result"] == "stop"
    both = s.resolve_outcome("LONG", 95.0, [bar(100, 110, 94, 100)])
    assert both["result"] == "stop" and both["r_multiple"] == -1.0


def test_a_short_mirrors_it():
    # entry 100, stop 105 (risk 5), target 92.5
    assert s.resolve_outcome("SHORT", 105.0, [bar(100, 101, 92, 93)])["result"] == "target"
    assert s.resolve_outcome("SHORT", 105.0, [bar(100, 106, 99, 104)])["result"] == "stop"


def test_a_trade_that_goes_nowhere_is_closed_at_the_third_close():
    out = s.resolve_outcome("LONG", 95.0, [bar(100, 102, 99, 101), bar(101, 103, 100, 102), bar(102, 104, 101, 103)])
    assert out["result"] == "time" and out["exit_day"] == 3 and out["r_multiple"] == pytest.approx(0.6)
    assert out["mfe_r"] == pytest.approx(0.8)


def test_it_is_still_running_until_there_is_an_exit_or_three_bars():
    assert s.resolve_outcome("LONG", 95.0, []) is None
    assert s.resolve_outcome("LONG", 95.0, [bar(100, 102, 99, 101), bar(101, 103, 100, 102)]) is None


def test_a_gap_through_the_stop_is_invalid_rather_than_a_loss():
    assert s.resolve_outcome("LONG", 95.0, [bar(93, 94, 92, 93)])["result"] == "invalid"
