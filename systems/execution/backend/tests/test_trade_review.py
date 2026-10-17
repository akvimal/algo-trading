"""Post-trade review by cause: the taxonomy, the root cause (earliest level wins), suggestions from the discipline checks and the entry context,
and the tag update through the existing tags route."""

import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.routes import positions as pos_route
from app.domain import position_manager as pm
from app.domain import trade_review as tr
from app.domain.models import TradeTagsUpdate


def test_every_tag_belongs_to_exactly_one_level_and_the_levels_are_in_chain_order():
    assert tr.LEVELS == ("study", "plan", "execution")
    seen = [t for lv in tr.LEVELS for t in tr.TAXONOMY[lv]]
    assert len(seen) == len(set(seen)) and all(tr.level_of(t) in tr.LEVELS for t in seen)


def test_the_root_cause_is_the_earliest_level_that_failed():
    assert tr.root_cause_for(["stop_moved", "no_stop", "against_trend"]) == "study"
    assert tr.root_cause_for(["stop_moved", "no_stop"]) == "plan"
    assert tr.root_cause_for(["stop_moved"]) == "execution"
    assert tr.root_cause_for([], clean=True) == "clean"
    assert tr.root_cause_for([]) is None
    with pytest.raises(tr.ReviewError):
        tr.root_cause_for(["no_stop"], clean=True)


def test_tags_are_validated_deduplicated_and_ordered():
    assert tr.clean_tags(["stop_moved", "against_trend", "stop_moved"]) == ["against_trend", "stop_moved"]
    assert tr.clean_tags(None) == [] and tr.clean_tags([]) == []
    with pytest.raises(tr.ReviewError):
        tr.clean_tags(["fomo"])
    with pytest.raises(tr.ReviewError):
        tr.clean_tags("no_stop")


def test_against_the_trend_is_only_said_when_the_ticket_recorded_a_read():
    assert tr.against_trend("BUY", {"regime": "trending_down"}) is True
    assert tr.against_trend("SELL", {"regime": "trending_down"}) is False
    assert tr.against_trend("BUY", {"regime": "ranging"}) is False
    assert tr.against_trend("BUY", None) is None and tr.against_trend("BUY", {}) is None
    assert tr.against_trend("BUY", {"regime": "weird"}) is None


def test_suggestions_put_the_study_failure_first_and_map_the_discipline_mistakes():
    out = tr.suggest("BUY", ["no_stop", "widen_attempt", "early_exit"], {"regime": "trending_down", "adx": 31.4})
    assert [t["tag"] for t in out["tags"]] == ["against_trend", "no_stop", "stop_moved", "exited_early"]
    assert out["root_cause"] == "study" and out["had_context"] is True
    assert "ADX 31" in out["tags"][0]["why"]


def test_without_context_nothing_about_the_trend_is_guessed():
    out = tr.suggest("BUY", ["low_rr"], None)
    assert [t["tag"] for t in out["tags"]] == ["low_rr"] and out["root_cause"] == "plan" and out["had_context"] is False
    assert tr.suggest("BUY", [], {"regime": "trending_up"}) == {"tags": [], "root_cause": None, "had_context": True, "override": None}


def test_the_entry_context_keeps_only_the_fields_the_review_uses():
    assert tr.clean_context({"regime": "trending_up", "trend": "up", "adx": 27.46, "secret": "x"}) == {"regime": "trending_up", "trend": "up", "adx": 27.5}
    assert tr.clean_context({"regime": "bogus", "adx": 250}) is None and tr.clean_context("x") is None


class Db:
    def __init__(self, r):
        self.r = r

    def get(self, model, key):
        return self.r

    def commit(self):
        pass


def test_saving_the_review_sets_tags_and_root_cause_and_clearing_removes_them():
    r = SimpleNamespace(user_id=uuid.UUID(int=1), setup_tag=None, confidence=None, emotion_tag=None, mistake_tags=None, root_cause=None)
    pm.update_position_tags(Db(r), r.user_id, uuid.UUID(int=2), mistakes=(["no_stop", "stop_moved"], "plan"))
    assert r.mistake_tags == ["no_stop", "stop_moved"] and r.root_cause == "plan"
    pm.update_position_tags(Db(r), r.user_id, uuid.UUID(int=2), mistakes=([], "clean"))
    assert r.mistake_tags is None and r.root_cause == "clean"
    pm.update_position_tags(Db(r), r.user_id, uuid.UUID(int=2), set_setup_tag=True, setup_tag="Breakout")
    assert r.root_cause == "clean"  # an unrelated tag edit leaves the review alone
    pm.update_position_tags(Db(r), r.user_id, uuid.UUID(int=2), mistakes=([], None))
    assert r.mistake_tags is None and r.root_cause is None


def test_the_route_helper_derives_the_root_cause_and_refuses_bad_input():
    def go(**body):
        p = TradeTagsUpdate(**body)
        return pos_route._mistakes_from(p.model_dump(exclude_unset=True), p)

    assert go(mistake_tags=["stop_moved", "against_trend"]) == (["against_trend", "stop_moved"], "study")
    assert go(clean=True) == ([], "clean")
    assert go(mistake_tags=[]) == ([], None)
    assert go(setup_tag="Breakout") is None
    for bad in ({"mistake_tags": ["nope"]}, {"mistake_tags": ["no_stop"], "clean": True}):
        with pytest.raises(HTTPException) as e:
            go(**bad)
        assert e.value.status_code == 422


def test_the_summary_costs_each_level_and_tag_and_counts_what_is_still_unreviewed():
    from datetime import datetime, timedelta

    t0 = datetime(2026, 10, 1, 10, 0)
    rows = [
        {"exit_time": t0, "pnl": -1000.0, "root_cause": "study", "tags": ["against_trend", "no_stop"]},
        {"exit_time": t0 + timedelta(days=1), "pnl": -500.0, "root_cause": "plan", "tags": ["no_stop"]},
        {"exit_time": t0 + timedelta(days=2), "pnl": -200.0, "root_cause": "clean", "tags": []},
        {"exit_time": t0 + timedelta(days=3), "pnl": 800.0, "root_cause": "clean", "tags": None},
        {"exit_time": t0 + timedelta(days=4), "pnl": 50.0, "root_cause": None, "tags": None},
    ]
    s = tr.summarize(rows)
    assert (s["reviewed"], s["pending"]) == (4, 1)
    assert s["by_level"]["study"] == {"n": 1, "pnl": -1000.0, "avg_loss": -1000.0} and s["by_level"]["execution"]["n"] == 0
    assert s["by_tag"]["no_stop"]["n"] == 2 and s["by_tag"]["no_stop"]["pnl"] == -1500.0 and s["by_tag"]["no_stop"]["level"] == "plan"
    assert s["clean"]["n"] == 2 and s["clean"]["lost"] == 1 and s["flawed"]["pnl"] == -1500.0
    assert s["trades_since_last"] == {"against_trend": 3, "no_stop": 2}


# ---- the person's own read of the market, and overriding the system's

OVER = {"regime": "trending_up", "trend": "up", "adx": 30.0, "person_read": "ranging", "overridden": True}


def test_the_entry_context_keeps_the_persons_read_and_the_override_flag():
    assert tr.clean_context(OVER) == {"regime": "trending_up", "trend": "up", "adx": 30.0, "person_read": "ranging", "overridden": True}
    assert tr.clean_context({"regime": "ranging", "person_read": "bogus", "overridden": "yes"}) == {"regime": "ranging"}


def test_an_override_pays_off_only_when_the_plan_held_and_the_trade_won_at_least_1r():
    v = lambda **k: tr.override_verdict(OVER, **{"stop0": 98.0, "target0": 104.0, "planned_rr": 2.0, "exit_r": 2.0, "pnl": 500.0, "min_rr": 2.0, **k})
    assert v() == "paid_off"
    assert v(exit_r=1.0) == "paid_off"  # exactly 1R is enough
    assert v(exit_r=0.6) == "small_win"
    assert v(pnl=-300.0, exit_r=-1.0) == "lost"
    # a win never rescues an incomplete plan: no stop, no target, or reward-to-risk under the minimum
    assert v(stop0=None) == "weak_plan" and v(target0=None) == "weak_plan" and v(planned_rr=1.2) == "weak_plan" and v(planned_rr=None) == "weak_plan"
    assert v(planned_rr=1.995) == "paid_off"  # a rounding sliver under the minimum is not a miss


def test_no_override_means_no_verdict():
    args = dict(stop0=98.0, target0=104.0, planned_rr=2.0, exit_r=2.0, pnl=500.0, min_rr=2.0)
    assert tr.override_verdict(None, **args) is None
    assert tr.override_verdict({"regime": "trending_up"}, **args) is None
    assert tr.override_verdict({"regime": "trending_up", "person_read": "trending_up"}, **args) is None


def test_a_paid_off_override_clears_against_the_trend_and_a_small_win_is_left_alone():
    ctx = {"regime": "trending_down", "adx": 28.0, "overridden": True}
    assert tr.suggest("BUY", [], ctx, None)["tags"][0]["tag"] == "against_trend"  # without an override it is suggested as before
    assert tr.suggest("BUY", [], ctx, "paid_off")["tags"] == []
    assert tr.suggest("BUY", [], ctx, "small_win")["tags"] == []
    lost = tr.suggest("BUY", [], ctx, "lost")
    assert lost["tags"][0]["tag"] == "against_trend" and "overrode" in lost["tags"][0]["why"] and lost["override"]["verdict"] == "lost"
    assert tr.suggest("BUY", [], ctx, "weak_plan")["tags"][0]["tag"] == "against_trend"


def test_an_override_is_reported_even_when_the_side_agreed_with_the_system():
    out = tr.suggest("BUY", [], {"regime": "trending_up", "overridden": True}, "paid_off")
    assert out["tags"] == [] and out["override"]["verdict"] == "paid_off"
