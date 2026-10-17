"""A trade that went to plan needs no review: a stop and a target at order time, reward-to-risk at the minimum, no mistake found."""

from datetime import datetime, timedelta, timezone

from app.domain import discipline_v2 as dv2
from app.domain import on_plan as op
from app.domain import session_grid as sg
from app.domain import trade_review as tr

CFG = dv2.DisciplineConfig(min_rr=2.0, timezone="Asia/Kolkata")
T0 = datetime(2026, 10, 14, 4, 0, tzinfo=timezone.utc)


def facts(tid="t1", stop=95.0, target=110.0, reason="target", pnl=500.0, root_cause=None, hours=0, **over):
    return dv2.TradeFacts(
        id=tid, kind="position", segment="NSE", symbol="RELIANCE", action="BUY", entry_time=T0 + timedelta(hours=hours), exit_time=T0 + timedelta(hours=hours, minutes=30),
        exit_reason=reason, order_type="limit", entry_price=100.0, exit_price=110.0, quantity=10, system_quantity=10, stop0=stop, target0=target, stop_final=stop,
        target_final=target, pnl=pnl, entry_setup_tag="breakout", reviewed=False, root_cause=root_cause, **over,
    )


def test_a_planned_trade_that_hit_its_target_is_on_plan():
    assert tr.on_plan([], 95.0, 110.0, 2.0, 2.0)


def test_the_paperwork_checks_do_not_count_against_it():
    assert tr.on_plan(["no_review", "untagged"], 95.0, 110.0, 2.0, 2.0)


def test_a_missing_stop_or_target_or_a_low_reward_to_risk_is_not_on_plan():
    assert not tr.on_plan([], None, 110.0, None, 2.0)
    assert not tr.on_plan([], 95.0, None, None, 2.0)
    assert not tr.on_plan([], 95.0, 105.0, 1.0, 2.0)


def test_any_other_mistake_means_it_still_needs_a_review():
    assert not tr.on_plan(["early_exit"], 95.0, 110.0, 2.0, 2.0)
    assert not tr.on_plan(["widen_attempt"], 95.0, 110.0, 2.0, 2.0)


def test_a_clean_stop_out_of_a_sound_plan_is_still_on_plan():
    f = facts(reason="stop_loss", pnl=-500.0)
    scores = dv2.evaluate_all([f], CFG)
    assert op.on_plan_ids(scores, CFG) == {"t1"}


def test_closing_by_hand_before_the_target_is_not():
    f = facts(reason="manual", pnl=100.0)
    f.exit_price = 102.0
    assert op.on_plan_ids(dv2.evaluate_all([f], CFG), CFG) == set()


def test_a_trade_the_person_already_reviewed_keeps_their_verdict():
    f = facts(root_cause="execution")
    assert op.on_plan_ids(dv2.evaluate_all([f], CFG), CFG) == set()


def test_a_planned_trade_stops_costing_the_discipline_score_a_missing_review():
    f = facts()
    (score,) = dv2.evaluate_all([f], CFG)
    assert "no_review" not in score.mistakes
    weak = facts(tid="t2", target=None)
    (weak_score,) = dv2.evaluate_all([weak], CFG)
    assert "no_review" in weak_score.mistakes


def test_a_cleared_trade_is_counted_as_reviewed_and_clean_on_the_grid():
    f = facts()
    owed = facts(tid="t2", target=None, hours=2)
    ids = op.on_plan_ids(dv2.evaluate_all([f, owed], CFG), CFG)
    assert ids == {"t1"}
    (day,) = sg.manual_sessions(op.cleared([f, owed], ids))
    assert day["trades"] == 2 and day["unreviewed"] == 1
    assert day["study"]["of"] == 1 and day["plan"]["ok"] == 1 and day["trade"]["ok"] == 1


# ---- no target set at entry ------------------------------------------------------------------------------------------------

def manual_exit(exit_price, tid="n1", pnl=None, hours=0):
    f = facts(tid=tid, target=None, reason="manual", pnl=pnl if pnl is not None else (exit_price - 100.0) * 10, hours=hours)
    f.exit_price = exit_price
    return f


def test_no_target_but_a_profit_at_the_minimum_reward_to_risk_is_on_plan():
    f = manual_exit(110.0)  # risk 5, gained 10: 2R
    scores = dv2.evaluate_all([f], CFG)
    assert "early_exit" not in scores[0].mistakes
    assert op.on_plan_ids(scores, CFG) == {"n1"}


def test_no_target_and_a_profit_under_the_minimum_is_reviewed_and_scored():
    f = manual_exit(105.0)  # 1R
    (score,) = dv2.evaluate_all([f], CFG)
    assert op.on_plan_ids([score], CFG) == set()
    assert "early_exit" in score.mistakes and "unplanned_reward" in score.mistakes and "no_review" in score.mistakes


def test_no_target_and_a_loss_is_reviewed():
    f = manual_exit(97.0)
    assert op.on_plan_ids(dv2.evaluate_all([f], CFG), CFG) == set()


def test_no_stop_is_never_on_plan():
    f = manual_exit(130.0)
    f.stop0 = None
    assert op.on_plan_ids(dv2.evaluate_all([f], CFG), CFG) == set()


# ---- against the trend ------------------------------------------------------------------------------------------------------

def test_winning_at_the_minimum_reward_to_risk_clears_against_the_trend_override_or_not():
    ctx = {"regime": "trending_down"}
    assert [t["tag"] for t in tr.suggest("BUY", [], ctx)["tags"]] == ["against_trend"]
    assert tr.suggest("BUY", [], ctx, None, True)["tags"] == []
    assert tr.won_at_min_rr(500, 2.0, 2.0) and not tr.won_at_min_rr(500, 1.5, 2.0) and not tr.won_at_min_rr(-5, 2.0, 2.0)


def test_the_grid_does_not_count_against_the_trend_against_a_trade_that_won_at_the_minimum():
    f = facts(root_cause="study", mistake_tags=["against_trend"])
    (day,) = sg.manual_sessions([f], verdicts={"t1": sg.WON_AT_MIN})
    assert day["study"]["ok"] == 1 and day["overrides"] == 0
    (plain,) = sg.manual_sessions([f])
    assert plain["study"]["ok"] == 0
