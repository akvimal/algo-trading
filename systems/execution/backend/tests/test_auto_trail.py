"""Discipline v2 auto-trail: breakeven at +1R, then a stop N x ATR behind price - and never loosening.

Plain fakes and direct calls, like the rest of this backend."""

import uuid
from types import SimpleNamespace

import pytest

from app.domain import option_position_manager as opm
from app.domain import position_manager as pm
from app.domain import stop_rules as sr
from app.domain.models import AutoTrailUpdate
from tests.test_option_position_manager import FakePosition as OptPosition
from tests.test_option_position_manager import _accounts as opt_accounts
from tests.test_option_position_manager import _group, _legs
from tests.test_position_manager import FakePosition, _accounts

ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
PID = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")

# Every bar spans 2 points with no gaps, so the ATR is 2.
FLAT = [{"close": 100.0, "high": 101.0, "low": 99.0} for _ in range(60)]


# ---- the pure step ----------------------------------------------------------------------------------------------------------------

def step(action="BUY", entry=100.0, initial=95.0, price=103.0, atr=2.0, multiple=1.5, done=False):
    return sr.atr_trail_step(action, entry, initial, price, atr, multiple, done)


def test_nothing_happens_before_one_r():
    assert step(price=104.0) == (None, False)  # +4 on a risk of 5


def test_at_plus_one_r_the_stop_goes_to_breakeven():
    assert step(price=105.0, atr=None) == (100.0, True)


def test_after_breakeven_the_stop_follows_price_by_n_atr():
    # price 110, ATR 2, 1.5x -> 107
    assert step(price=110.0, done=True) == (107.0, True)


def test_the_first_tick_past_one_r_takes_the_more_favourable_of_breakeven_and_the_trail():
    assert step(price=112.0) == (109.0, True)  # trail 109 beats breakeven 100


def test_a_trail_behind_breakeven_does_not_beat_it():
    # price just over +1R: trail would be 105.5 - 3 = 102.5, higher than breakeven 100 -> the trail
    assert step(price=105.5) == (102.5, True)
    # a big ATR keeps the trail under the entry, so breakeven is what is proposed
    assert step(price=105.0, atr=10.0) == (100.0, True)


def test_a_sell_mirrors_it():
    assert step("SELL", 100.0, 105.0, 95.0, atr=None) == (100.0, True)
    assert step("SELL", 100.0, 105.0, 90.0, done=True) == (93.0, True)
    assert step("SELL", 100.0, 105.0, 96.0) == (None, False)


def test_no_initial_risk_means_no_breakeven_step():
    assert sr.atr_trail_step("BUY", 100.0, None, 120.0, 2.0, 1.5, False) == (None, False)


def test_latest_atr_reads_the_last_value_and_needs_enough_bars():
    assert sr.latest_atr(FLAT, 14) == pytest.approx(2.0)
    assert sr.latest_atr(FLAT[:5], 14) is None


def test_the_request_model_bounds_the_multiple():
    assert AutoTrailUpdate().multiple == 1.5 and AutoTrailUpdate().interval == "15min"
    for bad in (0.1, 9):
        with pytest.raises(ValueError):
            AutoTrailUpdate(multiple=bad)


# ---- a position's evaluator -------------------------------------------------------------------------------------------------------

def trailing_position(**over):
    base = dict(
        id="p1", status="OPEN", exchange="NSE", symbol="RELIANCE", action="BUY", entry_price=100.0, quantity=10,
        stop_loss_price=95.0, trailing_stop_enabled=True, stop_loss_method="atr_trail", stop_loss_interval="15min",
        stop_loss_indicator_params={"period": 14, "multiple": 1.5},
    )
    base.update(over)
    p = FakePosition(**base)
    p.initial_stop_loss_price = 95.0
    return p


def run(p, price):
    return pm._evaluate_exits(
        [p], get_ltp_batch=lambda ex, syms: {"RELIANCE": price}, get_previous_candle=lambda *a: None,
        accounts_by_segment=_accounts(), get_candle_history=lambda *a: FLAT,
    )


def test_a_position_keeps_its_stop_until_it_is_one_r_up():
    p = trailing_position()
    result = run(p, 103.0)
    assert result["trailed"] == 0 and p.stop_loss_price == 95.0 and p.breakeven_triggered is False


def test_a_position_goes_to_breakeven_then_trails_and_never_loosens():
    p = trailing_position()
    result = run(p, 105.0)  # +1R: breakeven (the ATR trail 105-3=102 is higher, so that wins)
    assert p.breakeven_triggered is True and p.stop_loss_price == 102.0 and result["trailed"] == 1
    assert [e["new_price"] for e in result["trail_events"]] == [102.0]
    run(p, 110.0)
    assert p.stop_loss_price == 107.0
    run(p, 106.0)  # price pulls back: the stop stays where it was
    assert p.stop_loss_price == 107.0


def test_the_stop_is_hit_like_any_other_once_price_falls_to_it():
    p = trailing_position()
    run(p, 110.0)
    result = run(p, 106.0)
    assert p.status == "CLOSED" and p.exit_reason == "stop_loss" and result["closed_stop_loss"] == 1


def test_a_sell_position_trails_downward():
    p = trailing_position(action="SELL", entry_price=100.0, stop_loss_price=105.0)
    p.initial_stop_loss_price = 105.0
    pm._evaluate_exits(
        [p], get_ltp_batch=lambda ex, syms: {"RELIANCE": 90.0}, get_previous_candle=lambda *a: None,
        accounts_by_segment=_accounts(), get_candle_history=lambda *a: FLAT,
    )
    assert p.stop_loss_price == 93.0


def test_without_candle_history_the_auto_trail_simply_waits():
    p = trailing_position()
    result = pm._evaluate_exits([p], get_ltp_batch=lambda ex, syms: {"RELIANCE": 110.0}, get_previous_candle=lambda *a: None, accounts_by_segment=_accounts())
    assert result["trailed"] == 0 and p.stop_loss_price == 95.0


# ---- switching it on and off for a position ------------------------------------------------------------------------------------------

class FakeDb:
    def __init__(self, r=None):
        self.r = r
        self.commits = 0

    def get(self, model, key):
        return self.r

    def add(self, obj):
        pass

    def commit(self):
        self.commits += 1


def row(**over):
    base = dict(
        id=PID, user_id=ALICE, status="OPEN", action="BUY", entry_price=100.0, stop_loss_price=95.0, initial_stop_loss_price=95.0,
        stop_loss_method=None, stop_loss_interval=None, stop_loss_percent=None, stop_loss_indicator_type=None,
        stop_loss_indicator_params=None, trailing_stop_enabled=False, breakeven_triggered=False,
    )
    base.update(over)
    return SimpleNamespace(**base)


def test_switching_it_on_arms_the_trail_without_moving_the_stop():
    r = row()
    out, reason = pm.set_auto_trail(FakeDb(r), ALICE, PID, True, "5min", 2.0)
    assert reason is None and r.stop_loss_price == 95.0
    assert (r.stop_loss_method, r.stop_loss_interval, r.trailing_stop_enabled) == ("atr_trail", "5min", True)
    assert r.stop_loss_indicator_params == {"period": 14, "multiple": 2.0}


def test_it_needs_a_stop_to_start_from():
    r = row(stop_loss_price=None, initial_stop_loss_price=None)
    out, reason = pm.set_auto_trail(FakeDb(r), ALICE, PID, True, "15min", 1.5)
    assert "stop-loss first" in reason and r.stop_loss_method is None


def test_it_will_not_replace_another_trailing_method():
    r = row(stop_loss_method="indicator", trailing_stop_enabled=True)
    out, reason = pm.set_auto_trail(FakeDb(r), ALICE, PID, True, "15min", 1.5)
    assert "already trails" in reason and r.stop_loss_method == "indicator"


def test_switching_it_off_leaves_a_plain_stop_where_it_is():
    r = row(stop_loss_price=102.0, stop_loss_method="atr_trail", stop_loss_interval="15min", trailing_stop_enabled=True, stop_loss_indicator_params={"period": 14})
    out, reason = pm.set_auto_trail(FakeDb(r), ALICE, PID, False, "15min", 1.5)
    assert reason is None and r.stop_loss_price == 102.0
    assert (r.stop_loss_method, r.trailing_stop_enabled, r.stop_loss_indicator_params) == (None, False, None)


def test_switching_it_off_does_not_touch_a_different_trailing_method():
    r = row(stop_loss_method="percent", stop_loss_percent=2.0, trailing_stop_enabled=True)
    pm.set_auto_trail(FakeDb(r), ALICE, PID, False, "15min", 1.5)
    assert r.stop_loss_method == "percent" and r.trailing_stop_enabled is True


def test_someone_elses_position_is_not_found():
    assert pm.set_auto_trail(FakeDb(row()), uuid.uuid4(), PID, True, "15min", 1.5) == (None, None)


def test_editing_the_stop_by_hand_switches_the_auto_trail_off():
    r = row(stop_loss_price=102.0, stop_loss_method="atr_trail", trailing_stop_enabled=True)
    out, reason = pm.update_stop_loss(FakeDb(r), ALICE, PID, 104.0)
    assert reason is None and r.stop_loss_method is None and r.trailing_stop_enabled is False


# ---- an option group's spot stop ---------------------------------------------------------------------------------------------------------------

def trailing_group(**over):
    base = dict(
        action="BUY", entry_spot_price=100.0, spot_stop_loss_price=95.0, spot_stop_loss_trailing_enabled=True,
        spot_stop_loss_indicator_type="atr_trail", spot_stop_loss_interval="15min",
        spot_stop_loss_indicator_params={"period": 14, "multiple": 1.5, "initial_stop": 95.0, "breakeven_done": False},
    )
    base.update(over)
    return _group(**base)


def run_group(g, spot):
    long_leg, short_leg = _legs()
    return opm._evaluate_option_group_exits(
        [g], {"group-1": {"BUY": long_leg, "SELL": short_leg}},
        lambda ex, syms: {"NIFTY-CE": 25.0, "NIFTY-CE-OTM": 10.0, "NIFTY": spot},
        opt_accounts(), get_candle_history=lambda *a: FLAT,
    )


def test_a_group_spot_stop_waits_then_goes_to_breakeven_and_trails():
    g = trailing_group()
    assert run_group(g, 103.0)["trailed"] == 0 and g.spot_stop_loss_price == 95.0
    result = run_group(g, 110.0)
    assert g.spot_stop_loss_price == 107.0 and result["trailed"] == 1
    assert g.spot_stop_loss_indicator_params["breakeven_done"] is True
    run_group(g, 106.0)
    assert g.spot_stop_loss_price == 107.0 or g.status == "CLOSED"  # never loosens (106 is under 107, so it may close)


def test_a_group_without_an_entry_price_is_left_alone():
    g = trailing_group(entry_spot_price=None)
    assert run_group(g, 120.0)["trailed"] == 0 and g.spot_stop_loss_price == 95.0


def group_row(**over):
    base = dict(
        id=PID, user_id=ALICE, status="OPEN", action="BUY", entry_spot_price=100.0, spot_stop_loss_price=95.0,
        spot_stop_loss_indicator_type=None, spot_stop_loss_indicator_params=None, spot_stop_loss_interval=None,
        spot_stop_loss_trailing_enabled=False,
    )
    base.update(over)
    return SimpleNamespace(**base)


def test_switching_a_group_on_records_where_its_stop_started():
    r = group_row()
    out, reason = opm.set_group_auto_trail(FakeDb(r), ALICE, PID, True, "5min", 2.0)
    assert reason is None and r.spot_stop_loss_price == 95.0
    assert r.spot_stop_loss_indicator_type == "atr_trail" and r.spot_stop_loss_trailing_enabled is True
    assert r.spot_stop_loss_indicator_params == {"period": 14, "multiple": 2.0, "initial_stop": 95.0, "breakeven_done": False}


def test_a_group_needs_a_stop_and_an_entry_price_to_start():
    assert "stop-loss first" in opm.set_group_auto_trail(FakeDb(group_row(spot_stop_loss_price=None)), ALICE, PID, True, "15min", 1.5)[1]
    assert "not recorded" in opm.set_group_auto_trail(FakeDb(group_row(entry_spot_price=None)), ALICE, PID, True, "15min", 1.5)[1]
    assert "already trails" in opm.set_group_auto_trail(FakeDb(group_row(spot_stop_loss_indicator_type="supertrend")), ALICE, PID, True, "15min", 1.5)[1]


def test_switching_a_group_off_keeps_its_stop():
    r = group_row(spot_stop_loss_price=107.0, spot_stop_loss_indicator_type="atr_trail", spot_stop_loss_trailing_enabled=True, spot_stop_loss_indicator_params={"period": 14}, spot_stop_loss_interval="15min")
    out, reason = opm.set_group_auto_trail(FakeDb(r), ALICE, PID, False, "15min", 1.5)
    assert reason is None and r.spot_stop_loss_price == 107.0
    assert (r.spot_stop_loss_indicator_type, r.spot_stop_loss_trailing_enabled) == (None, False)
