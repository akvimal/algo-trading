"""Discipline v2 (app/domain/discipline_v2.py): scores process, never profit. Plain facts in, scores out."""

from datetime import datetime, timedelta, timezone

import pytest

from app.domain import discipline_v2 as dv2
from app.domain.discipline_v2 import DisciplineConfig, EventFact, TradeFacts

CFG = DisciplineConfig(min_rr=2.0, cooldown_minutes=15, max_trades_per_day=9, daily_loss_limit=None, timezone="Asia/Kolkata")
CAP3 = DisciplineConfig(min_rr=2.0, cooldown_minutes=15, max_trades_per_day=3, daily_loss_limit=None, timezone="Asia/Kolkata")
# 10:30 IST on a weekday = 05:00 UTC
T0 = datetime(2026, 10, 1, 5, 0, tzinfo=timezone.utc)


def minutes(n):
    return T0 + timedelta(minutes=n)


def start(i):
    """Four trades a day from 10:30 IST, an hour apart, then the next day: inside the session and under the trade cap."""
    return (i // 4) * 1440 + (i % 4) * 60


def trade(i=0, **over) -> TradeFacts:
    base = dict(
        id=f"t{i}", kind="position", segment="NSE", symbol="RELIANCE", action="BUY", entry_time=minutes(start(i)),
        exit_time=minutes(start(i) + 30), exit_reason="target", order_type="limit", entry_price=100.0, exit_price=110.0,
        quantity=10, system_quantity=10, stop0=95.0, target0=110.0, stop_final=95.0, target_final=110.0, pnl=100.0,
        entry_setup_tag="Breakout", reviewed=True,
    )
    base.update(over)
    return TradeFacts(**base)


def ev(field, move, source="user", accepted=True, at=40, tight=None, old=None, new=None, entry_i=0):
    return EventFact(field=field, move=move, source=source, accepted=accepted, created_at=minutes(start(entry_i) + at), tight_trail=tight, old_price=old, new_price=new)


def check(score, key):
    return next((c for c in score.checks if c.key == key), None)


def one(t, cfg=CFG):
    return dv2.evaluate_trade(t, cfg)


# ---- plan at entry ---------------------------------------------------------------------------------------------------------------

def test_the_plan_at_entry_rewinds_later_moves_but_keeps_ones_made_with_the_order():
    events = [
        ev("spot_stop_loss", "set", at=0, old=None, new=95.0),  # attached right after the order opened: part of the plan
        ev("spot_stop_loss", "tighten", at=40, old=95.0, new=99.0),
        ev("spot_target", "further", at=50, old=110.0, new=120.0),
    ]
    assert dv2.plan_at_entry(minutes(0), 99.0, 120.0, events) == (95.0, 110.0)


def test_a_stop_set_long_after_entry_was_not_planned():
    events = [ev("stop_loss", "set", at=45, old=None, new=96.0)]
    assert dv2.plan_at_entry(minutes(0), 96.0, None, events) == (None, None)


def test_refused_moves_are_ignored_when_rewinding():
    events = [ev("stop_loss", "widen", accepted=False, at=45, old=95.0, new=80.0)]
    assert dv2.plan_at_entry(minutes(0), 95.0, 110.0, events) == (95.0, 110.0)


# ---- risk and size ---------------------------------------------------------------------------------------------------------------

def test_the_system_size_is_full_marks_and_over_it_costs_in_proportion():
    assert check(one(trade()), "size_adherence").score == 1.0
    over = check(one(trade(quantity=13)), "size_adherence")
    assert over.score == pytest.approx(0.7) and over.mistake == "oversized"
    assert check(one(trade(quantity=20)), "size_adherence").score == 0.0


def test_sizing_down_once_is_neutral():
    s = dv2.evaluate_all([trade(quantity=3)], CFG)[0]
    assert check(s, "size_adherence").score == 1.0 and check(s, "size_habit").score == 1.0
    assert "undersized" in s.flags


def test_sizing_down_three_times_in_ten_is_a_habit():
    scores = dv2.evaluate_all([trade(i, quantity=3) for i in range(3)], CFG)
    assert [check(s, "size_habit").score for s in scores] == [1.0, 1.0, 0.4]
    assert check(scores[2], "size_habit").mistake == "undersized_habit"


def test_a_trade_with_no_system_size_is_left_out_of_the_size_checks():
    s = one(trade(system_quantity=None))
    assert check(s, "size_adherence") is None


# ---- entry quality ---------------------------------------------------------------------------------------------------------------

def test_a_fully_planned_trade_scores_full_on_entry():
    s = one(trade())
    assert [check(s, k).score for k in ("stop_planned", "reward_planned", "rr_met", "entry_style", "setup_tagged")] == [1.0] * 5
    assert s.planned_rr == 2.0


def test_no_stop_no_target_and_no_tag_are_each_named():
    s = one(trade(stop0=None, target0=None, entry_setup_tag=None))
    assert s.mistakes[:3] == ["no_stop", "unplanned_reward", "untagged"]
    assert check(s, "rr_met") is None


def test_a_reward_to_risk_under_the_minimum_scores_partial_and_is_named():
    s = one(trade(target0=105.0))  # 1:1 against a minimum of 2
    c = check(s, "rr_met")
    assert c.mistake == "low_rr" and 0 < c.score < 1


def test_a_market_order_scores_a_little_below_a_limit_order():
    assert check(one(trade(order_type="market")), "entry_style").score == 0.7


# ---- management: the exit ladder -----------------------------------------------------------------------------------------------

def exit_check(**over):
    s = one(trade(**over))
    return check(s, "exit_outcome"), s


def test_target_hit_is_full():
    c, s = exit_check()
    assert c.score == 1.0 and s.exit_kind == "target"


def test_a_clean_stop_loss_is_full_marks_because_the_process_was_right():
    c, s = exit_check(exit_reason="stop_loss", pnl=-100, exit_price=95.0)
    assert c.score == 1.0 and s.exit_kind == "clean_stop" and s.exit_r == -1.0


def trailed(source="auto_trail", tight=False, final=104.0, **over):
    events = [ev("stop_loss", "tighten", source=source, tight=tight, at=40, old=95.0, new=final)]
    return exit_check(exit_reason="stop_loss", stop_final=final, events=events, **over)


def test_a_rule_based_trail_that_ends_beyond_the_planned_reward_is_full():
    c, s = trailed(final=112.0)  # locked +2.4R against a planned 2R
    assert c.score == 1.0 and s.exit_kind == "trail_beyond_plan"


def test_a_rule_based_trail_below_the_plan_is_partial_high():
    c, s = trailed(final=107.0)  # locked +1.4R against a planned 2R
    assert c.score == 0.8 and s.exit_kind == "rule_trail" and c.mistake is None


def test_a_tight_trail_below_the_plan_is_reduced_and_scores_below_a_clean_loss():
    c, s = trailed(source="user", tight=True, final=107.0)
    assert c.score == 0.4 and c.mistake == "tight_trail" and s.exit_kind == "tight_trail"
    clean, _ = exit_check(exit_reason="stop_loss", pnl=-100)
    assert c.score < clean.score


def test_with_no_target_any_trail_exit_is_a_winner():
    c, s = trailed(source="user", tight=True, final=104.0, target0=None, target_final=None)
    assert c.score == 1.0 and s.exit_kind == "scalp_trail"


def test_a_stop_tightened_but_still_a_loss_is_a_small_deduction_not_a_mistake():
    c, s = trailed(final=97.0)
    assert c.score == 0.9 and c.mistake is None


def test_closing_by_hand_before_the_plan_is_an_early_exit():
    c, s = exit_check(exit_reason="manual", exit_price=104.0, pnl=40)
    assert c.score == 0.5 and c.mistake == "early_exit" and s.exit_r == pytest.approx(0.8)


def test_closing_by_hand_at_the_planned_reward_is_fine():
    c, s = exit_check(exit_reason="manual", exit_price=110.0)
    assert c.score == 1.0 and s.exit_kind == "manual_at_plan"


def test_the_square_off_time_is_a_planned_exit_and_liquidation_is_not():
    assert exit_check(exit_reason="square_off")[0].score == 1.0
    c, _ = exit_check(exit_reason="liquidation")
    assert c.score == 0.0 and c.mistake == "liquidated"


# ---- management: moves and attempts ---------------------------------------------------------------------------------------------

def test_each_refused_attempt_to_widen_a_live_stop_costs_greed():
    events = [ev("stop_loss", "widen", accepted=False, at=35, old=95.0, new=90.0), ev("stop_loss", "widen", accepted=False, at=36, old=95.0, new=85.0)]
    c = check(one(trade(events=events)), "stop_kept")
    assert c.score == pytest.approx(0.2) and c.mistake == "widen_attempt" and c.emotion == "greed"


def test_pushing_a_target_out_is_greed_and_pulling_it_in_is_fear():
    s = one(trade(events=[ev("target", "further", at=40, old=110.0, new=120.0)]))
    assert check(s, "target_pushed").mistake == "target_pushed" and check(s, "target_pushed").emotion == "greed"
    s = one(trade(events=[ev("target", "closer", at=40, old=110.0, new=104.0)]))
    assert check(s, "target_pulled").mistake == "target_pulled" and check(s, "target_pulled").emotion == "fear"


def test_a_target_moved_together_with_the_stop_is_flagged_not_scored():
    events = [ev("target", "closer", at=40, old=110.0, new=106.0), ev("stop_loss", "tighten", at=41, old=95.0, new=98.0)]
    assert "target_and_stop_moved" in one(trade(events=events)).flags


def test_three_flagged_trades_in_ten_deduct_from_management():
    events = [ev("target", "closer", at=40, old=110.0, new=106.0), ev("stop_loss", "tighten", at=41, old=95.0, new=98.0)]
    clean = dv2.summarize(dv2.evaluate_all([trade(i, exit_reason="target") for i in range(6)], CFG))
    flagged_trades = [trade(i, events=[ev(e.field, e.move, at=e.created_at.minute + i * 0, entry_i=i, old=e.old_price, new=e.new_price) for e in events]) for i in range(6)]
    out = dv2.summarize(dv2.evaluate_all(flagged_trades, CFG))
    assert out["target_and_stop_moved"] == 6 and out["categories"]["management"] < clean["categories"]["management"]


# ---- across trades --------------------------------------------------------------------------------------------------------------

def test_reentering_the_same_instrument_right_after_a_loss_is_revenge():
    first = trade(0, pnl=-50, exit_reason="stop_loss")
    second = trade(1, entry_time=first.exit_time + timedelta(minutes=5), exit_time=first.exit_time + timedelta(minutes=40))
    scores = dv2.evaluate_all([first, second], CFG)
    assert check(scores[1], "cooldown").mistake == "revenge" and check(scores[0], "cooldown").score == 1.0


def test_waiting_out_the_cooldown_or_a_different_instrument_is_fine():
    first = trade(0, pnl=-50, exit_reason="stop_loss")
    later = trade(1, entry_time=first.exit_time + timedelta(minutes=20))
    other = trade(2, symbol="TCS", entry_time=first.exit_time + timedelta(minutes=2))
    scores = dv2.evaluate_all([first, later, other], CFG)
    assert check(scores[1], "cooldown").score == 1.0 and check(scores[2], "cooldown").score == 1.0


def test_trades_beyond_the_daily_cap_are_overtrading():
    scores = dv2.evaluate_all([trade(i, entry_time=minutes(i * 20), exit_time=minutes(i * 20 + 10)) for i in range(5)], CAP3)
    assert [check(s, "trade_cap").mistake for s in scores] == [None, None, None, "overtrade", "overtrade"]


def test_entering_after_the_daily_loss_limit_was_reached_is_the_worst_breach():
    cfg = DisciplineConfig(min_rr=2.0, cooldown_minutes=15, max_trades_per_day=9, daily_loss_limit=100.0, timezone="Asia/Kolkata")
    a = trade(0, pnl=-120, exit_reason="stop_loss")
    b = trade(1, symbol="TCS")
    scores = dv2.evaluate_all([a, b], cfg)
    assert check(scores[1], "loss_limit").mistake == "past_loss_limit" and check(scores[0], "loss_limit").score == 1.0
    assert check(dv2.evaluate_all([a], CFG)[0], "loss_limit") is None  # no limit configured: not measured


def test_the_first_and_last_minutes_of_the_nse_session_are_off_limits():
    early = trade(0, entry_time=datetime(2026, 10, 1, 3, 50, tzinfo=timezone.utc))  # 09:20 IST
    fine = trade(1, entry_time=datetime(2026, 10, 1, 5, 0, tzinfo=timezone.utc))  # 10:30 IST
    late = trade(2, entry_time=datetime(2026, 10, 1, 9, 50, tzinfo=timezone.utc))  # 15:20 IST
    crypto = trade(3, segment="CRYPTO", entry_time=datetime(2026, 10, 1, 3, 50, tzinfo=timezone.utc))
    scores = dv2.evaluate_all([early, fine, late, crypto], CFG)
    by_id = {s.facts.id: check(s, "trading_window") for s in scores}
    assert by_id["t0"].mistake == "off_window" and by_id["t1"].score == 1.0 and by_id["t2"].mistake == "off_window"
    assert by_id["t3"] is None  # only NSE has these windows


# ---- the rolling score ------------------------------------------------------------------------------------------------------------

def good_trades(n):
    return [trade(i) for i in range(n)]


def test_no_score_below_five_trades():
    assert dv2.summarize(dv2.evaluate_all(good_trades(4), CFG))["score"] is None
    assert dv2.summarize(dv2.evaluate_all(good_trades(5), CFG))["score"] == 100


def test_the_score_never_depends_on_profit():
    wins = dv2.summarize(dv2.evaluate_all([trade(i) for i in range(6)], CFG))["score"]
    clean_losses = dv2.summarize(dv2.evaluate_all([trade(i, exit_reason="stop_loss", pnl=-100, exit_price=95.0) for i in range(6)], CFG))["score"]
    assert wins == clean_losses == 100


def test_a_lucky_rule_break_scores_below_a_clean_loss():
    broke = dv2.summarize(dv2.evaluate_all([trade(i, quantity=20, exit_reason="manual", exit_price=106.0, pnl=500) for i in range(6)], CFG))["score"]
    clean_loss = dv2.summarize(dv2.evaluate_all([trade(i, exit_reason="stop_loss", pnl=-100, exit_price=95.0) for i in range(6)], CFG))["score"]
    assert broke < clean_loss


def test_only_the_last_twenty_trades_count():
    bad = [trade(i, stop0=None, entry_setup_tag=None, reviewed=False) for i in range(10)]
    good = [trade(i + 10) for i in range(20)]
    assert dv2.summarize(dv2.evaluate_all(bad + good, CFG))["trade_count"] == 20
    assert dv2.summarize(dv2.evaluate_all(bad + good, CFG))["score"] == 100


def test_auto_traded_fills_are_never_scored():
    out = dv2.summarize(dv2.evaluate_all([trade(i, auto_traded=True) for i in range(8)], CFG))
    assert out["trade_count"] == 0 and out["score"] is None


def test_each_emotion_gets_its_own_bar():
    trades = [trade(i, quantity=20) for i in range(5)]  # always sizing up
    out = dv2.summarize(dv2.evaluate_all(trades, CFG))
    assert out["emotions"]["greed"] < out["emotions"]["patience"] and out["emotions"]["fear"] == 100


def test_the_weekly_coaching_line_names_the_costliest_habit_and_a_clean_week_says_so():
    now = minutes(10 * 60)
    trades = [trade(i, quantity=20) for i in range(3)] + [trade(3, entry_setup_tag=None)]
    out = dv2.summarize(dv2.evaluate_all(trades, CFG), now=now)
    assert out["coaching"]["mistake"] == "oversized" and out["coaching"]["count"] == 3
    assert "more size" in out["coaching"]["line"] and out["coaching"]["emotion"] == "greed"
    clean = dv2.summarize(dv2.evaluate_all(good_trades(3), CFG), now=now)["coaching"]
    assert clean["mistake"] is None and "clean week" in clean["line"].lower()
    assert dv2.summarize([], now=now)["coaching"] is None


def test_only_the_last_seven_days_count_for_coaching():
    old = trade(0, quantity=20, entry_time=T0 - timedelta(days=30), exit_time=T0 - timedelta(days=30) + timedelta(minutes=30))
    recent = [trade(i + 1) for i in range(3)]
    out = dv2.summarize(dv2.evaluate_all([old] + recent, CFG), now=minutes(600))
    assert out["coaching"]["mistake"] is None and out["mistakes"].get("oversized") == 1


# ---- what-if ----------------------------------------------------------------------------------------------------------------------

def bars(*highs, start=40):
    return [{"timestamp": (minutes(start + 5 * i)).isoformat(), "high": h, "low": h - 1} for i, h in enumerate(highs)]


def test_what_if_reports_how_much_further_price_went_after_an_early_exit():
    t = trade(exit_reason="manual", exit_price=104.0, exit_time=minutes(30))
    out = dv2.what_if_after_exit(t, 5.0, bars(105, 112, 108))
    assert out == {"extra_r": 1.6, "target_reached": True}  # best 112 vs exit 104 = 8 / risk 5


def test_what_if_ignores_bars_before_the_exit_and_never_goes_negative():
    t = trade(exit_reason="manual", exit_price=104.0, exit_time=minutes(60))
    out = dv2.what_if_after_exit(t, 5.0, bars(130, 101, 100, start=0)[:1] + bars(101, 100, start=60))
    assert out == {"extra_r": 0.0, "target_reached": False}


def test_what_if_for_a_sell_looks_down():
    t = trade(action="SELL", entry_price=100.0, stop0=105.0, target0=90.0, exit_price=96.0, exit_time=minutes(30))
    candles = [{"timestamp": minutes(40).isoformat(), "high": 98, "low": 89}]
    assert dv2.what_if_after_exit(t, 5.0, candles) == {"extra_r": 1.4, "target_reached": True}


def test_what_if_has_nothing_to_say_without_a_risk_or_candles():
    t = trade(exit_reason="manual", exit_price=104.0)
    assert dv2.what_if_after_exit(t, None, bars(110)) is None
    assert dv2.what_if_after_exit(t, 5.0, []) is None


# ---- the one-tap feeling check (step 4) ---------------------------------------------------------------------------------------------

def test_a_loss_or_an_early_exit_asks_how_you_felt_and_a_trade_that_went_to_plan_does_not():
    loss = one(trade(exit_reason="stop_loss", pnl=-100))
    early = one(trade(exit_reason="manual", exit_price=104.0, pnl=40))
    win = one(trade())
    assert loss.needs_emotion and early.needs_emotion and not win.needs_emotion


def test_an_answered_or_auto_traded_trade_is_not_asked_again():
    assert not one(trade(exit_reason="stop_loss", pnl=-100, emotion_tag="fearful")).needs_emotion
    assert not one(trade(exit_reason="stop_loss", pnl=-100, auto_traded=True)).needs_emotion


def test_the_summary_counts_the_answers_and_the_questions_still_open():
    trades = [
        trade(0, exit_reason="stop_loss", pnl=-100, emotion_tag="fearful"),
        trade(1, exit_reason="stop_loss", pnl=-100, emotion_tag="fearful"),
        trade(2, exit_reason="stop_loss", pnl=-100, emotion_tag="calm"),
        trade(3, exit_reason="stop_loss", pnl=-100),
        trade(4),
    ]
    out = dv2.summarize(dv2.evaluate_all(trades, CFG))
    assert out["emotion_counts"] == {"fearful": 2, "calm": 1} and out["needs_emotion"] == 1


def test_the_feeling_never_changes_the_score():
    plain = dv2.summarize(dv2.evaluate_all([trade(i, exit_reason="stop_loss", pnl=-100) for i in range(6)], CFG))
    tagged = dv2.summarize(dv2.evaluate_all([trade(i, exit_reason="stop_loss", pnl=-100, emotion_tag="greedy") for i in range(6)], CFG))
    assert plain["score"] == tagged["score"]


def test_the_coaching_line_adds_what_you_said_you_felt_on_that_habit():
    now = minutes(10 * 60)
    trades = [trade(i, exit_reason="manual", exit_price=104.0, pnl=40, emotion_tag="fearful") for i in range(3)]
    line = dv2.summarize(dv2.evaluate_all(trades, CFG), now=now)["coaching"]["line"]
    assert "closed a trade by hand" in line and "You tagged fearful on 3 of the 3 you answered." in line


def test_one_answer_is_too_few_to_say_anything_about():
    now = minutes(10 * 60)
    trades = [trade(0, exit_reason="manual", exit_price=104.0, pnl=40, emotion_tag="fearful"), trade(1, exit_reason="manual", exit_price=104.0, pnl=40)]
    assert "You tagged" not in dv2.summarize(dv2.evaluate_all(trades, CFG), now=now)["coaching"]["line"]


# ---- the ticket's "Today" row ---------------------------------------------------------------------------------------------------

NOW = datetime(2026, 10, 1, 5, 20, tzinfo=timezone.utc)  # 10:50 IST


def pre(entries=(), closed=(), symbol="RELIANCE", segment="NSE", cfg=CFG, now=NOW):
    return dv2.pretrade_state(now, symbol, segment, list(entries), list(closed), cfg)


def test_a_cooldown_runs_for_the_same_instrument_after_a_loss_and_counts_down():
    out = pre(closed=[(NOW - timedelta(minutes=4), "RELIANCE", -50.0)])
    assert out["cooldown_minutes_left"] == 11 and out["cooldown_minutes"] == 15


def test_no_cooldown_after_a_win_after_the_wait_or_for_another_instrument():
    assert pre(closed=[(NOW - timedelta(minutes=4), "RELIANCE", 50.0)])["cooldown_minutes_left"] == 0
    assert pre(closed=[(NOW - timedelta(minutes=20), "RELIANCE", -50.0)])["cooldown_minutes_left"] == 0
    assert pre(closed=[(NOW - timedelta(minutes=4), "TCS", -50.0)])["cooldown_minutes_left"] == 0


def test_a_futures_contract_and_its_underlying_are_the_same_instrument_for_the_cooldown():
    assert pre(closed=[(NOW - timedelta(minutes=2), "BANKNIFTY-Oct2026-FUT", -50.0)], symbol="BANKNIFTY")["cooldown_minutes_left"] == 13


def test_trades_today_and_the_room_left_under_the_loss_limit():
    cfg = DisciplineConfig(min_rr=2.0, cooldown_minutes=15, max_trades_per_day=6, daily_loss_limit=500.0, timezone="Asia/Kolkata")
    entries = [(NOW - timedelta(hours=2), "A"), (NOW - timedelta(hours=1), "B"), (NOW - timedelta(days=1), "C")]
    closed = [(NOW - timedelta(minutes=50), "A", -120.0), (NOW - timedelta(minutes=40), "B", 300.0), (NOW - timedelta(days=1), "C", -999.0)]
    out = pre(entries, closed, cfg=cfg)
    assert out["trades_today"] == 2 and out["trade_cap"] == 6
    assert out["lost_today"] == 120.0 and out["loss_room"] == 380.0 and out["loss_limit"] == 500.0


def test_no_loss_limit_means_no_room_figure():
    out = pre()
    assert out["loss_limit"] is None and out["loss_room"] is None


def test_the_first_and_last_minutes_of_the_nse_session_are_flagged_and_other_markets_are_not():
    early = datetime(2026, 10, 1, 3, 50, tzinfo=timezone.utc)  # 09:20 IST
    assert pre(now=early)["off_window"] is True
    assert pre(now=NOW)["off_window"] is False
    assert pre(now=early, segment="CRYPTO")["off_window"] is False
