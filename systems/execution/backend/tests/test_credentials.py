"""Discipline v2 credentials (app/domain/credentials.py): runs of good process, never profit, volume or days traded."""

from datetime import timedelta

from app.domain import credentials as cr
from app.domain import discipline_v2 as dv2
from tests.test_discipline_v2 import CFG, minutes, trade

LIMIT_CFG = dv2.DisciplineConfig(min_rr=2.0, cooldown_minutes=15, max_trades_per_day=9, daily_loss_limit=100.0, timezone="Asia/Kolkata")


def scored(trades, cfg=CFG):
    return dv2.evaluate_all(trades, cfg)


def status(trades, key, cfg=CFG, limit=None):
    return next(c for c in cr.evaluate(scored(trades, cfg), limit) if c.key == key)


def run(n, **over):
    return [trade(i, **over) for i in range(n)]


# ---- levels and runs --------------------------------------------------------------------------------------------------------

def test_levels_come_at_the_thresholds():
    assert cr.level_for(19, (20, 50, 100)) is None
    assert [cr.level_for(n, (20, 50, 100)) for n in (20, 49, 50, 99, 100, 400)] == ["bronze", "bronze", "silver", "silver", "gold", "gold"]


def test_a_run_counts_back_from_the_newest_trade_and_one_slip_resets_it():
    trades = run(12) + [trade(12, quantity=20)] + [trade(i) for i in range(13, 18)]
    s = status(trades, "risk_keeper")
    assert s.count == 5 and s.best_count == 12 and s.next_at == 20 and s.next_level == "bronze"


def test_a_trade_that_does_not_apply_is_skipped_without_breaking_the_run():
    trades = [trade(i) for i in range(4)] + [trade(4, system_quantity=None)] + [trade(i) for i in range(5, 8)]
    assert status(trades, "risk_keeper").count == 7


def test_a_lapse_is_shown_as_a_lapse_not_as_nothing():
    trades = [trade(i) for i in range(20)] + [trade(20, quantity=20)]
    s = status(trades, "risk_keeper")
    assert s.level is None and s.best_level == "bronze" and s.lapsed is True
    assert status([trade(i) for i in range(20)], "risk_keeper").lapsed is False


def test_profit_never_counts():
    wins = status(run(20), "risk_keeper")
    losses = status(run(20, exit_reason="stop_loss", pnl=-500, exit_price=95.0), "risk_keeper")
    assert wins.level == losses.level == "bronze"


def test_auto_traded_fills_are_never_counted():
    assert status(run(25, auto_traded=True), "risk_keeper").count == 0


def test_days_off_never_break_a_run():
    spread = [trade(i, entry_time=minutes(i * 3 * 1440), exit_time=minutes(i * 3 * 1440 + 30)) for i in range(20)]
    assert status(spread, "risk_keeper").level == "bronze"


# ---- the five trade-run credentials -----------------------------------------------------------------------------------------

def test_risk_keeper_needs_the_system_size_and_not_a_token_order():
    assert status(run(3, quantity=3), "risk_keeper").count == 0  # sized below half: does not count as keeping to the plan
    assert status(run(3, quantity=13), "risk_keeper").count == 0
    assert status(run(3), "risk_keeper").count == 3


def test_patient_entry_needs_a_stop_a_tag_a_limit_order_and_no_cooldown_breach():
    assert status(run(3), "patient_entry").count == 3
    assert status(run(3, order_type="market"), "patient_entry").count == 0
    assert status(run(3, entry_setup_tag=None), "patient_entry").count == 0
    assert status(run(3, stop0=None), "patient_entry").count == 0
    first = trade(0, pnl=-50, exit_reason="stop_loss")
    quick = trade(1, entry_time=first.exit_time + timedelta(minutes=3), exit_time=first.exit_time + timedelta(minutes=40))
    after = status([first, quick], "patient_entry")
    assert (after.count, after.best_count) == (0, 1)  # the re-entry right after a loss breaks the run


def test_steady_hands_breaks_on_a_widen_attempt_or_a_tight_trail():
    refused = [dv2.EventFact("stop_loss", "widen", "user", False, minutes(35), None, 95.0, 85.0)]
    assert status([trade(0), trade(1, events=refused)], "steady_hands").count == 0
    tight = [dv2.EventFact("stop_loss", "tighten", "user", True, minutes(60 + 40), True, 95.0, 107.0)]
    t = trade(1, exit_reason="stop_loss", stop_final=107.0, events=tight)
    assert status([trade(0), t], "steady_hands").count == 0
    assert status(run(4), "steady_hands").count == 4


def test_plan_holder_counts_stops_targets_and_rule_trails_but_not_early_exits():
    assert status(run(2, exit_reason="stop_loss", pnl=-100), "plan_holder").count == 2
    assert status(run(2, exit_reason="square_off"), "plan_holder").count == 2
    assert status(run(2, exit_reason="manual", exit_price=104.0), "plan_holder").count == 0


def loss(i, **over):
    return trade(i, exit_reason="stop_loss", pnl=-100, exit_price=95.0, **over)


def test_loss_acceptor_looks_only_at_losses_so_wins_do_not_count_or_break():
    trades = [loss(0), trade(1), loss(2), trade(3), trade(4), loss(5)]
    assert status(trades, "loss_acceptor").count == 3
    broken = [loss(0), trade(1, exit_reason="manual", exit_price=97.0, pnl=-30), loss(2)]
    assert status(broken, "loss_acceptor").count == 1  # a loss closed by hand before the stop breaks it


# ---- Day Closer ----------------------------------------------------------------------------------------------------------------

def day_trades(day, hit=True, respect=True):
    base = day * 1440
    first = trade(0, entry_time=minutes(base), exit_time=minutes(base + 20), pnl=-150 if hit else -10, exit_reason="stop_loss")
    first.id = f"d{day}a"
    out = [first]
    if hit and not respect:
        second = trade(1, entry_time=minutes(base + 60), exit_time=minutes(base + 90), pnl=40)
        second.id = f"d{day}b"
        out.append(second)
    return out


def test_day_closer_needs_a_configured_daily_loss_limit():
    s = status(day_trades(0), "day_closer", limit=None)
    assert s.available is False and "daily loss limit" in s.detail


def test_day_closer_counts_limit_days_that_were_respected_and_skips_ordinary_days():
    trades = day_trades(0) + day_trades(1, hit=False) + day_trades(2) + day_trades(3)
    s = status(trades, "day_closer", cfg=LIMIT_CFG, limit=100.0)
    assert s.count == 3 and s.level == "bronze"


def test_trading_past_the_limit_breaks_it():
    trades = day_trades(0) + day_trades(1) + day_trades(2, respect=False) + day_trades(3)
    s = status(trades, "day_closer", cfg=LIMIT_CFG, limit=100.0)
    assert s.count == 1 and s.best_count == 2


# ---- Calm Under Pressure -------------------------------------------------------------------------------------------------------

def early(i):
    return trade(i, exit_reason="manual", exit_price=104.0)


def test_calm_needs_thirty_trades_with_few_fear_mistakes():
    assert status(run(29), "calm_under_pressure").level is None
    s = status(run(30), "calm_under_pressure")
    assert s.level == "bronze" and s.count == 30 and s.next_level == "silver" and s.next_at == 50


def test_calm_is_lost_when_the_fear_mistakes_pile_up():
    s = status([early(i) for i in range(30)], "calm_under_pressure")
    assert s.level is None and "100%" in s.detail


def test_calm_bronze_also_needs_it_to_be_getting_better():
    older_bad = [early(i) if i < 5 else trade(i) for i in range(30)]
    assert status(older_bad, "calm_under_pressure").level == "bronze"  # 17% fear, all of it in the older half
    newer_bad = [trade(i) if i < 25 else early(i) for i in range(30)]
    assert status(newer_bad, "calm_under_pressure").level is None  # 17% too, but it is getting worse


def test_the_shelf_has_all_seven_in_a_fixed_order():
    keys = [c.key for c in cr.evaluate(scored(run(3)))]
    assert keys == ["loss_acceptor", "risk_keeper", "patient_entry", "steady_hands", "plan_holder", "day_closer", "calm_under_pressure"]
