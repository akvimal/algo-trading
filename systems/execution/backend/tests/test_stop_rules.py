"""Discipline v2 step 1: a live stop can only tighten, and every stop/target move is logged.

Plain fakes and direct calls, like the rest of this backend."""

import uuid
from types import SimpleNamespace

import pytest

from app.domain import option_position_manager as opm
from app.domain import position_manager as pm
from app.domain import stop_rules as sr

ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
PID = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")


class FakeDb:
    def __init__(self, r=None):
        self.r = r
        self.commits = 0
        self.added = []

    def get(self, model, key):
        return self.r

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        self.commits += 1


def position(action="BUY", entry=100.0, stop=95.0, initial=95.0, target=None):
    return SimpleNamespace(
        id=PID, user_id=ALICE, exchange="NSE", symbol="RELIANCE", action=action, entry_price=entry, stop_loss_price=stop, initial_stop_loss_price=initial,
        target_price=target, stop_loss_method=None, stop_loss_interval=None, stop_loss_percent=None,
        stop_loss_indicator_type=None, stop_loss_indicator_params=None, trailing_stop_enabled=False,
    )


# ---- classification ----------------------------------------------------------------------------------------------

@pytest.mark.parametrize(
    "action,old,new,expected",
    [
        ("BUY", 95, 97, "tighten"),
        ("BUY", 95, 93, "widen"),
        ("SELL", 105, 103, "tighten"),
        ("SELL", 105, 107, "widen"),
        ("BUY", None, 95, "set"),
        ("BUY", 95, None, "clear"),
        ("BUY", 95, 95, "same"),
        ("BUY", None, None, "same"),
    ],
)
def test_stop_moves_are_classified_by_the_side_of_the_trade(action, old, new, expected):
    assert sr.classify_stop_move(action, old, new) == expected


def test_only_widening_and_clearing_are_refused():
    assert [sr.is_widening(m) for m in ("widen", "clear", "tighten", "set", "same")] == [True, True, False, False, False]


@pytest.mark.parametrize(
    "action,old,new,expected",
    [("BUY", 110, 105, "closer"), ("BUY", 110, 115, "further"), ("SELL", 90, 95, "closer"), ("SELL", 90, 85, "further"), ("BUY", None, 110, "set")],
)
def test_target_moves_are_closer_or_further(action, old, new, expected):
    assert sr.classify_target_move(action, old, new) == expected


# ---- tight trail --------------------------------------------------------------------------------------------------

def test_a_stop_tightened_inside_one_atr_of_price_is_a_tight_trail():
    # price 110, ATR 2, new stop 109 -> 1 away, under 1 x ATR
    assert sr.judge_tight_trail("BUY", "tighten", 100, 95, 109, 110, 2, 1.0) is True


def test_a_stop_a_full_atr_or_more_away_is_not_tight():
    assert sr.judge_tight_trail("BUY", "tighten", 100, 95, 107, 110, 2, 1.0) is False
    assert sr.judge_tight_trail("BUY", "tighten", 100, 95, 108, 110, 2, 1.0) is False  # exactly 1 x ATR is not inside it


def test_the_multiple_scales_the_threshold():
    assert sr.judge_tight_trail("BUY", "tighten", 100, 95, 107, 110, 2, 2.0) is True


def test_a_sell_trail_is_judged_the_same_way_mirrored():
    assert sr.judge_tight_trail("SELL", "tighten", 100, 105, 91, 90, 2, 1.0) is True
    assert sr.judge_tight_trail("SELL", "tighten", 100, 105, 94, 90, 2, 1.0) is False


def test_breakeven_once_price_is_one_r_up_is_never_tight():
    # risk 5; price 105 is +1R. A big ATR would make any stop "tight" without the exemption.
    assert sr.judge_tight_trail("BUY", "tighten", 100, 95, 100, 105, 10, 1.0) is False
    # the same stop before +1R (price 103) is not the exempt move
    assert sr.judge_tight_trail("BUY", "tighten", 100, 95, 100, 103, 10, 1.0) is True


def test_nothing_is_judged_without_price_or_atr_or_for_a_move_that_is_not_a_tighten():
    assert sr.judge_tight_trail("BUY", "tighten", 100, 95, 109, None, 2) is None
    assert sr.judge_tight_trail("BUY", "tighten", 100, 95, 109, 110, None) is None
    assert sr.judge_tight_trail("BUY", "set", 100, 95, 109, 110, 2) is None
    assert sr.judge_tight_trail("BUY", "widen", 100, 95, 90, 110, 2) is None


def test_fetch_context_survives_market_data_being_down():
    def boom(*a, **k):
        raise RuntimeError("down")

    assert sr.fetch_context(boom, boom, "NSE", "NIFTY", "15min") == (None, None)


def test_fetch_context_returns_the_price_and_the_last_atr():
    candles = [{"high": 10 + i, "low": 8 + i, "close": 9 + i} for i in range(30)]
    price, atr = sr.fetch_context(lambda ex, syms: {"NIFTY": 123.5}, lambda *a: candles, "NSE", "NIFTY", "15min")
    assert price == 123.5 and atr is not None and atr > 0


# ---- a position's stop --------------------------------------------------------------------------------------------

def test_tightening_a_live_stop_is_applied_and_logged():
    r = position("BUY", 100, stop=95)
    db = FakeDb(r)
    out, reason = pm.update_stop_loss(db, ALICE, PID, 98, context=(110.0, 2.0), atr_interval="15min")
    assert reason is None and r.stop_loss_price == 98
    (ev,) = db.added
    assert (ev.field, ev.move, ev.source, ev.accepted) == ("stop_loss", "tighten", "user", True)
    assert (ev.old_price, ev.new_price, ev.price_at_event, ev.atr, ev.atr_interval) == (95, 98, 110.0, 2.0, "15min")
    assert ev.tight_trail is False  # 12 away from price, over one ATR


def test_a_tight_trail_is_flagged_on_the_event():
    r = position("BUY", 100, stop=95)
    db = FakeDb(r)
    pm.update_stop_loss(db, ALICE, PID, 109, context=(110.0, 2.0), atr_interval="5min")
    assert db.added[0].tight_trail is True


def test_widening_a_live_stop_is_refused_logged_and_left_alone():
    r = position("BUY", 100, stop=95)
    db = FakeDb(r)
    out, reason = pm.update_stop_loss(db, ALICE, PID, 90)
    assert reason == sr.STOP_WIDEN_MESSAGE
    assert r.stop_loss_price == 95
    (ev,) = db.added
    assert (ev.move, ev.accepted, ev.refused_reason, ev.new_price) == ("widen", False, sr.STOP_WIDEN_MESSAGE, 90)
    assert db.commits == 1  # the refused attempt is saved on its own


def test_a_sell_stop_moved_up_is_a_widening():
    r = position("SELL", 100, stop=105, initial=105)
    out, reason = pm.update_stop_loss(FakeDb(r), ALICE, PID, 108)
    assert reason == sr.STOP_WIDEN_MESSAGE and r.stop_loss_price == 105


def test_setting_the_same_price_again_is_allowed():
    r = position("BUY", 100, stop=95)
    out, reason = pm.update_stop_loss(FakeDb(r), ALICE, PID, 95)
    assert reason is None


def test_a_position_with_no_stop_can_be_given_one():
    r = position("BUY", 100, stop=None, initial=None)
    db = FakeDb(r)
    out, reason = pm.update_stop_loss(db, ALICE, PID, 95)
    assert reason is None and r.stop_loss_price == 95 and db.added[0].move == "set"


def test_a_method_stop_that_resolves_wider_than_the_current_stop_is_refused():
    # 5% below entry 100 is 95; the stop has already been trailed up to 99
    r = position("BUY", 100, stop=99)
    out, reason = pm.update_stop_loss(FakeDb(r), ALICE, PID, None, "percent", None, 5.0)
    assert reason == sr.STOP_WIDEN_MESSAGE and r.stop_loss_price == 99


# ---- targets ------------------------------------------------------------------------------------------------------

def test_a_target_move_is_logged_as_closer_or_further():
    r = position("BUY", 100, stop=95, target=120)
    db = FakeDb(r)
    pm.update_target(db, ALICE, PID, 110)
    pm.update_target(db, ALICE, PID, 130)
    assert [(e.field, e.move, e.old_price, e.new_price) for e in db.added] == [("target", "closer", 120, 110), ("target", "further", 110, 130)]


# ---- an option group's stops ---------------------------------------------------------------------------------------

def group(action="BUY", spot_stop=22000.0, combined_stop=-5.0, spot_target=None, entry_spot=22500.0, scope="combined"):
    return SimpleNamespace(
        id=PID, user_id=ALICE, action=action, spot_stop_loss_price=spot_stop, combined_stop_loss_price=combined_stop,
        spot_target_price=spot_target, combined_target_price=None, entry_spot_price=entry_spot, sl_scope=scope,
        spot_stop_loss_trailing_enabled=True,
    )


def test_a_spot_stop_can_tighten_but_not_widen():
    g = group("BUY", spot_stop=22000)
    db = FakeDb(g)
    assert opm.update_group_spot_stop_loss(db, ALICE, PID, 22100) is g and g.spot_stop_loss_price == 22100
    assert db.added[0].move == "tighten" and db.added[0].field == "spot_stop_loss"
    with pytest.raises(sr.StopWidenRefused):
        opm.update_group_spot_stop_loss(db, ALICE, PID, 21900)
    assert g.spot_stop_loss_price == 22100
    assert db.added[-1].accepted is False and db.commits >= 2


def test_a_bearish_group_spot_stop_widens_upward():
    g = group("SELL", spot_stop=23000)
    with pytest.raises(sr.StopWidenRefused):
        opm.update_group_spot_stop_loss(FakeDb(g), ALICE, PID, 23200)


def test_a_combined_premium_stop_cannot_be_lowered_either():
    g = group(combined_stop=-5.0)
    with pytest.raises(sr.StopWidenRefused):
        opm.update_group_stop_loss(FakeDb(g), ALICE, PID, -8.0)
    db = FakeDb(g)
    opm.update_group_stop_loss(db, ALICE, PID, -3.0)
    assert g.combined_stop_loss_price == -3.0 and db.added[0].field == "combined_stop_loss"


def test_group_targets_are_logged():
    g = group("BUY", spot_target=22800)
    db = FakeDb(g)
    opm.update_group_spot_target(db, ALICE, PID, 22600)
    assert (db.added[0].field, db.added[0].move) == ("spot_target", "closer")


def test_a_group_spot_stop_set_for_the_first_time_is_allowed():
    g = group("BUY", spot_stop=None)
    db = FakeDb(g)
    opm.update_group_spot_stop_loss(db, ALICE, PID, 22000)
    assert g.spot_stop_loss_price == 22000 and db.added[0].move == "set"
