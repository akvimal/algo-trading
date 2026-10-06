"""Zones armed on a chart and watched by the server (app/domain/zone_watch.py): the touch and outcome rules exactly, then the watcher end to end
against an in-memory session (so what it stores, sends and refuses is what is tested, not a stub of it)."""

import operator
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.adapters.db.models import AlertChannel, NotificationLog, ZoneEvent, ZoneWatch
from app.domain import notifications as n
from app.domain import zone_watch as zw

IST = timezone(timedelta(hours=5, minutes=30))
ME, YOU = uuid4(), uuid4()


# ---- the pure rules -----------------------------------------------------------------------------------------------------------------


def test_sides_of_a_zone_and_of_a_level():
    assert [zw.side_of(p, 100, 110) for p in (99.9, 100, 105, 110, 110.1)] == ["below", "inside", "inside", "inside", "above"]
    assert [zw.side_of(p, 100, 100) for p in (99.9, 100, 100.1)] == ["below", "above", "above"]  # a level has two sides; on it counts as above


def test_a_zone_the_price_first_sat_above_is_support_and_below_is_resistance():
    assert (zw.role_from_side("above"), zw.role_from_side("below"), zw.role_from_side("inside")) == ("support", "resistance", "zone")


def test_the_first_look_only_learns_the_side_and_never_touches():
    assert zw.evaluate_ltp(None, 105, 100, 110) == zw.LiveCheck("inside", False, None)


def test_entering_the_zone_is_a_touch_with_the_side_it_came_from():
    assert zw.evaluate_ltp("above", 109, 100, 110) == zw.LiveCheck("inside", True, "above")
    assert zw.evaluate_ltp("below", 101, 100, 110) == zw.LiveCheck("inside", True, "below")


def test_jumping_straight_through_between_two_looks_is_still_a_touch():
    assert zw.evaluate_ltp("above", 95, 100, 110) == zw.LiveCheck("below", True, "above")
    assert zw.evaluate_ltp("below", 120, 100, 110) == zw.LiveCheck("above", True, "below")


def test_staying_put_or_leaving_back_the_way_it_came_is_not_a_new_touch():
    assert zw.evaluate_ltp("above", 120, 100, 110).touched is False
    assert zw.evaluate_ltp("inside", 105, 100, 110).touched is False
    assert zw.evaluate_ltp("inside", 120, 100, 110).touched is False  # it left; the candle's close tells how that ended


def test_a_level_is_touched_when_the_price_crosses_it_either_way():
    assert zw.evaluate_ltp("above", 99, 100, 100) == zw.LiveCheck("below", True, "above")
    assert zw.evaluate_ltp("below", 101, 100, 100) == zw.LiveCheck("above", True, "below")


def test_a_candle_touches_a_zone_when_only_its_wick_gets_there():
    assert zw.candle_touches(low=147_629, high=148_900, lo=147_116, hi=147_673)  # the GOLDM case: the low wicked into the zone
    assert not zw.candle_touches(low=147_700, high=148_900, lo=147_116, hi=147_673)
    assert zw.candle_touches(low=147_673, high=148_900, lo=147_116, hi=147_673)  # exactly on the edge counts


@pytest.mark.parametrize(
    "open_, close, prev_close, role, approach, outcome",
    [
        (148_500, 148_000, 148_400, "support", "above", "held"),  # came from above, wicked in, closed back above
        (148_500, 147_000, 148_400, "support", "above", "broke"),  # closed below the zone
        (148_500, 147_400, 148_400, "support", "above", "inside"),  # closed inside it
        (146_000, 146_500, 146_100, "resistance", "below", "held"),
        (146_000, 148_000, 146_100, "resistance", "below", "broke"),
        (147_400, 148_000, 148_100, "support", "above", "held"),  # opened inside: the close before it says it came from above
        (147_400, 148_000, None, "support", "inside", "held"),  # nothing before it: the role decides (support holds when it closes above)
        (147_400, 146_000, None, "support", "inside", "broke"),
        (147_400, 146_000, None, "resistance", "inside", "held"),
        (147_400, 148_000, None, None, "inside", "inside"),  # no side to come from and no role: it is only reported as inside
    ],
)
def test_how_a_touching_candle_closed(open_, close, prev_close, role, approach, outcome):
    assert zw.candle_outcome(open_, close, prev_close, 147_116, 147_673, role) == (approach, outcome)


def test_the_words_say_what_happened_in_plain_terms():
    assert zw.touch_message("GOLDM", "support", "zone", 147_116, 147_673, ltp=147_650) == "🎯 GOLDM reached your support zone 147,116–147,673 · now 147,650"
    assert zw.touch_message("GOLDM", "support", "zone", 147_116, 147_673, extreme=147_629, when="16:00") == "🎯 GOLDM reached your support zone 147,116–147,673 (wick to 147,629 at 16:00)"
    held = zw.outcome_message("GOLDM", "support", "zone", 147_116, 147_673, "above", "held", 147_629, 148_000)
    assert held == "✅ GOLDM tested your support zone 147,116–147,673 from above, low 147,629 and closed back above at 148,000: it held"
    assert "closed below your support zone" in zw.outcome_message("GOLDM", "support", "zone", 147_116, 147_673, "above", "broke", 147_629, 147_000) and "it broke" in zw.outcome_message("GOLDM", "support", "zone", 147_116, 147_673, "above", "broke", 147_629, 147_000)
    assert zw.outcome_message("GOLDM", None, "line", 148_000, 148_000, "above", "inside", None, 148_000).startswith("GOLDM closed inside your level 148,000")


def test_a_daily_or_weekly_chart_is_judged_on_hourly_candles():
    assert [zw.eval_interval(i) for i in ("15min", "5min", "60min", "daily", "weekly", "1h", None, "0min")] == ["15min", "5min", "60min", "60min", "60min", "60min", "60min", "60min"]


def test_what_the_browser_sends_is_checked_and_deduplicated():
    out = zw.clean_specs([{"kind": "zone", "lo": 147_673, "hi": 147_116}, {"kind": "zone", "lo": 147_116, "hi": 147_673}, {"kind": "line", "lo": 148_000, "hi": 149_000}, {"kind": "zone", "lo": 150, "hi": 150}])
    assert out == [zw.WatchSpec("zone", 147_116.0, 147_673.0), zw.WatchSpec("line", 148_000.0, 148_000.0), zw.WatchSpec("line", 150.0, 150.0)]
    for bad in ([{"kind": "zone", "lo": -1, "hi": 5}], [{"kind": "arrow", "lo": 1, "hi": 2}], [{"kind": "zone", "lo": "x", "hi": 2}], [{"kind": "zone"}]):
        with pytest.raises(zw.ZoneWatchError):
            zw.clean_specs(bad)


# ---- a small in-memory session that really evaluates the filters the watcher builds ---------------------------------------------------


OPS = {operator.eq: operator.eq, operator.ne: operator.ne, operator.ge: operator.ge, operator.gt: operator.gt, operator.le: operator.le, operator.lt: operator.lt}


def _matches(row, c):
    value = getattr(c.right, "value", None)
    return OPS[c.operator](getattr(row, c.left.key), value)


class Q:
    def __init__(self, rows):
        self.rows = list(rows)

    def filter(self, *criteria):
        return Q(r for r in self.rows if all(_matches(r, c) for c in criteria))

    def order_by(self, *a):
        return self

    def first(self):
        return self.rows[0] if self.rows else None

    def all(self):
        return list(self.rows)


class DB:
    def __init__(self, channels=((ME, "111"),)):
        self.tables = {ZoneWatch: [], ZoneEvent: [], AlertChannel: [SimpleNamespace(user_id=u, telegram_chat_id=c) for u, c in channels]}
        self.log = {}

    def query(self, model):
        return Q(self.tables[model])

    def add(self, row):
        if isinstance(row, NotificationLog):
            self.log[(row.user_id, row.category, row.dedupe_key)] = row
        else:
            self.tables[type(row)].append(row)

    def get(self, model, key):
        if model is NotificationLog:
            return self.log.get(key)
        return next((r for r in self.tables.get(model, []) if getattr(r, "id", None) == key), None)

    def delete(self, row):
        self.tables[type(row)].remove(row)

    def flush(self):
        pass

    def commit(self):
        pass


@pytest.fixture
def sent(monkeypatch):
    out = []
    monkeypatch.setattr(n, "send_telegram", lambda text, chat: out.append((chat, text)))
    return out


def arm(db, lo=147_116, hi=147_673, symbol="GOLDM-05Nov2026-FUT", user=ME, interval="15min", armed_at=None):
    # the chart always sends the whole set for an instrument, so arming another zone means sending the ones already armed too
    existing = [{"kind": w.kind, "lo": float(w.lo), "hi": float(w.hi)} for w in db.tables[ZoneWatch] if w.user_id == user and w.symbol == symbol]
    specs = zw.clean_specs(existing + [{"kind": "zone", "lo": lo, "hi": hi}])
    rows = zw.sync_watches(db, user, "MCX", symbol, specs, interval)
    for r in rows:
        if r.created_at is None:
            r.created_at = armed_at or datetime(2026, 10, 6, 3, 0, tzinfo=timezone.utc)  # what the database's own default would have set
    return next(r for r in rows if float(r.lo) == float(lo) and float(r.hi) == float(hi))


NOW = datetime(2026, 10, 6, 11, 0, tzinfo=timezone.utc)  # 16:30 IST


def quotes(price):
    return lambda exchange, symbols: {s: price for s in symbols}


def candle(start, o, h, l, c):
    return SimpleNamespace(timestamp=start.isoformat(), open=o, high=h, low=l, close=c)


# ---- keeping the server's set in step with the chart ------------------------------------------------------------------------------------


def test_syncing_adds_keeps_and_drops_so_the_server_matches_the_chart():
    db = DB()
    w = arm(db)
    w.last_state, w.role = "above", "support"
    again = zw.sync_watches(db, ME, "MCX", "GOLDM-05Nov2026-FUT", zw.clean_specs([{"kind": "zone", "lo": 147_116, "hi": 147_673}, {"kind": "line", "lo": 149_000, "hi": 149_000}]), "5min")
    assert len(again) == 2 and w in again and w.last_state == "above" and w.interval == "5min"  # kept, with its memory of where the price was
    moved = zw.sync_watches(db, ME, "MCX", "GOLDM-05Nov2026-FUT", zw.clean_specs([{"kind": "zone", "lo": 147_000, "hi": 147_500}]), "5min")
    assert [(float(r.lo), float(r.hi)) for r in moved] == [(147_000.0, 147_500.0)] and w not in db.tables[ZoneWatch]  # a moved zone is a new one
    assert zw.sync_watches(db, ME, "MCX", "GOLDM-05Nov2026-FUT", [], "5min") == [] and db.tables[ZoneWatch] == []


def test_the_limits_per_instrument_and_in_all_are_enforced_and_one_persons_zones_are_not_anothers():
    db = DB()
    many = zw.clean_specs([{"kind": "zone", "lo": 100 + i, "hi": 100.5 + i} for i in range(zw.MAX_WATCHES_PER_SYMBOL + 1)])
    with pytest.raises(zw.ZoneWatchError) as e:
        zw.sync_watches(db, ME, "NSE", "NIFTY", many, "15min")
    assert e.value.status == 422
    for k in range(3):
        zw.sync_watches(db, ME, "NSE", f"S{k}", zw.clean_specs([{"kind": "zone", "lo": 100 + i, "hi": 100.5 + i} for i in range(10)]), "15min")
    with pytest.raises(zw.ZoneWatchError):
        zw.sync_watches(db, ME, "NSE", "ONEMORE", zw.clean_specs([{"kind": "line", "lo": 5, "hi": 5}]), "15min")  # 31st in all
    zw.sync_watches(db, YOU, "NSE", "S0", zw.clean_specs([{"kind": "line", "lo": 5, "hi": 5}]), "15min")
    assert len([w for w in db.tables[ZoneWatch] if w.user_id == ME]) == 30
    with pytest.raises(zw.ZoneWatchError):
        zw.sync_watches(db, ME, "LSE", "X", [], "15min")


# ---- the live check ----------------------------------------------------------------------------------------------------------------------


def test_a_live_touch_is_announced_once_to_the_owners_own_chat(sent):
    db = DB(channels=((ME, "111"), (YOU, "222")))
    arm(db)
    zw.check_live(db, quotes(148_500), NOW)  # the first look: only learns the side
    assert sent == [] and db.tables[ZoneWatch][0].role == "support" and db.tables[ZoneWatch][0].last_state == "above"
    assert zw.check_live(db, quotes(147_650), NOW + timedelta(seconds=20)) == 1
    assert sent == [("111", "🎯 GOLDM-05Nov2026-FUT reached your support zone 147,116–147,673 · now 147,650")]
    zw.check_live(db, quotes(148_400), NOW + timedelta(seconds=40))  # leaves
    assert zw.check_live(db, quotes(147_600), NOW + timedelta(seconds=60)) == 0  # back in during the same 15-minute bar: not announced twice
    assert len(sent) == 1 and [e.event for e in db.tables[ZoneEvent]] == ["touch"]


def test_a_new_bar_announces_a_new_touch(sent):
    db = DB()
    arm(db)
    zw.check_live(db, quotes(148_500), NOW)
    zw.check_live(db, quotes(147_650), NOW + timedelta(seconds=20))
    zw.check_live(db, quotes(148_400), NOW + timedelta(minutes=10))
    zw.check_live(db, quotes(147_600), NOW + timedelta(minutes=16))  # the next 15-minute bar
    assert len(sent) == 2


def test_a_zone_with_no_chat_is_still_recorded_but_nothing_is_sent(sent):
    db = DB(channels=())
    arm(db)
    zw.check_live(db, quotes(148_500), NOW)
    zw.check_live(db, quotes(147_650), NOW + timedelta(seconds=20))
    assert sent == [] and [e.event for e in db.tables[ZoneEvent]] == ["touch"]


def test_a_price_that_cannot_be_fetched_changes_nothing(sent):
    db = DB()
    arm(db)
    assert zw.check_live(db, lambda ex, syms: {}, NOW) == 0 and db.tables[ZoneWatch][0].last_state is None


# ---- the candle check --------------------------------------------------------------------------------------------------------------------


def history_of(*candles):
    return lambda exchange, symbol, interval, a, b: list(candles)


BAR = datetime(2026, 10, 6, 10, 15, tzinfo=timezone.utc)  # a 15-minute bar that closed at 10:30 UTC, before NOW


def test_a_wick_the_live_check_never_saw_is_announced_late_and_the_close_says_it_held(sent):
    db = DB()
    arm(db)
    h = history_of(candle(BAR - timedelta(minutes=15), 148_500, 148_700, 148_400, 148_600), candle(BAR, 148_300, 148_400, 147_629, 148_000))
    assert zw.check_bars(db, h, NOW) == 2
    assert sent[0][1] == "🎯 GOLDM-05Nov2026-FUT reached your support zone 147,116–147,673 (wick to 147,629 at 15:45)"
    assert sent[1][1] == "✅ GOLDM-05Nov2026-FUT tested your support zone 147,116–147,673 from above, low 147,629 and closed back above at 148,000: it held"
    assert "wick to 147,629" in sent[0][1] and [e.event for e in db.tables[ZoneEvent]] == ["touch", "held"]


def test_a_touch_the_live_check_did_catch_is_not_announced_a_second_time(sent):
    db = DB()
    w = arm(db)
    zw.check_live(db, quotes(148_500), BAR + timedelta(minutes=1))
    zw.check_live(db, quotes(147_650), BAR + timedelta(minutes=5))
    assert len(sent) == 1
    zw.check_bars(db, history_of(candle(BAR, 148_300, 148_400, 147_629, 148_000)), NOW)
    assert len(sent) == 2 and "it held" in sent[1][1] and [e.event for e in db.tables[ZoneEvent]] == ["touch", "held"]  # only the outcome is new


def test_a_candle_that_closed_through_the_zone_is_reported_as_broken(sent):
    db = DB()
    arm(db)
    zw.check_bars(db, history_of(candle(BAR, 148_300, 148_400, 146_800, 147_000)), NOW)
    assert "closed below your support zone" in sent[-1][1] and db.tables[ZoneEvent][-1].event == "broke"


def test_a_forming_candle_and_one_from_before_the_zone_existed_are_not_judged(sent):
    db = DB()
    arm(db, armed_at=datetime(2026, 10, 6, 10, 20, tzinfo=timezone.utc))
    forming = candle(NOW - timedelta(minutes=5), 148_000, 148_100, 147_000, 147_900)  # ends after NOW
    before = candle(BAR, 148_300, 148_400, 147_629, 148_000)  # started at 10:15, before the zone was armed at 10:20
    assert zw.check_bars(db, history_of(before, forming), NOW) == 0 and sent == []


def test_a_candle_is_judged_once_even_if_the_check_runs_again(sent):
    db = DB()
    arm(db)
    h = history_of(candle(BAR, 148_300, 148_400, 147_629, 148_000))
    zw.check_bars(db, h, NOW)
    zw.check_bars(db, h, NOW + timedelta(minutes=1))
    assert len(sent) == 2 and len(db.tables[ZoneEvent]) == 2


def test_a_candle_that_never_reached_the_zone_says_nothing(sent):
    db = DB()
    arm(db)
    assert zw.check_bars(db, history_of(candle(BAR, 148_500, 148_700, 148_400, 148_600)), NOW) == 0 and sent == []
    assert db.tables[ZoneWatch][0].last_bar_checked == BAR  # but it has been looked at, so it is not looked at again


# ---- the recap and the morning list -------------------------------------------------------------------------------------------------------


def test_the_recap_says_what_became_of_each_zone_that_day_including_removed_ones(sent):
    db = DB()
    a = arm(db)
    arm(db, lo=151_200, hi=152_000)
    zw.check_bars(db, history_of(candle(BAR, 148_300, 148_400, 147_629, 148_000)), NOW)
    zw.sync_watches(db, ME, "MCX", "GOLDM-05Nov2026-FUT", zw.clean_specs([{"kind": "zone", "lo": 151_200, "hi": 152_000}]), "15min")  # the first zone is removed
    rows = zw.zone_recap(db, ME, "MCX", date(2026, 10, 6))
    by_lo = {r["lo"]: r for r in rows}
    assert by_lo[147_116.0]["status"] == "held" and by_lo[147_116.0]["extreme"] == 147_629.0 and by_lo[147_116.0]["at"] == "16:00"
    assert by_lo[151_200.0]["status"] == "untouched"
    assert zw.zone_recap(db, ME, "NSE", date(2026, 10, 6)) == [] and zw.zone_recap(db, YOU, "MCX", date(2026, 10, 6)) == []


def test_the_morning_list_orders_zones_by_distance_and_says_what_each_is(sent):
    db = DB()
    arm(db)
    arm(db, lo=151_200, hi=152_000)
    for w in db.tables[ZoneWatch]:
        w.role = "support" if float(w.lo) < 148_000 else "resistance"
    tally = zw.send_morning(db, date(2026, 10, 6), quotes(148_897))
    assert tally.sent == 1
    text = sent[0][1]
    assert text.startswith("🗺️ Your zones today · Tue 6 Oct") and text.index("support zone 147,116–147,673") < text.index("resistance zone 151,200–152,000")
    assert "price 148,897, 0.8% above" in text and "price 148,897, 1.5% below" in text
    zw.send_morning(db, date(2026, 10, 6), quotes(148_897))
    assert len(sent) == 1  # once a day
    assert zw.morning_message([], date(2026, 10, 6)) is None


def test_events_go_through_the_same_recorded_delivery_as_every_other_message(sent):
    db = DB()
    arm(db)
    zw.check_bars(db, history_of(candle(BAR, 148_300, 148_400, 147_629, 148_000)), NOW)
    assert {k[1] for k in db.log} == {"zones"} and all(r.sent_at is not None for r in db.log.values())


# ---- the recap in the post-session message and card -----------------------------------------------------------------------------------------


ZONES = [
    {"symbol": "GOLDM", "kind": "zone", "role": "support", "lo": 147_116.0, "hi": 147_673.0, "status": "held", "at": "16:00", "extreme": 147_629.0},
    {"symbol": "GOLDM", "kind": "zone", "role": "resistance", "lo": 151_200.0, "hi": 152_000.0, "status": "untouched", "at": None, "extreme": None},
    {"symbol": "NIFTY", "kind": "line", "role": None, "lo": 22_700.0, "hi": 22_700.0, "status": "broke", "at": "14:15", "extreme": None},
]


def test_a_zone_line_says_what_became_of_it():
    assert n.zone_line(ZONES[0]) == "🟢 GOLDM support 147,116–147,673: tested and held ✅ (low 147,629 at 16:00)"
    assert n.zone_line(ZONES[1]) == "🔴 GOLDM resistance 151,200–152,000: not reached today"
    assert n.zone_line(ZONES[2]) == "🟡 NIFTY level 22,700: tested and broke ⚠️ (at 14:15)"


def test_the_session_message_lists_the_zones_before_the_market_and_leaves_the_section_out_without_any():
    market = {"day": date(2026, 10, 6), "rows": [{"label": "GOLDM", "close": 148_897.0, "change_pct": 0.3, "high": 149_000.0, "low": 147_629.0, "position": 0.9}]}
    text = n.session_message("MCX", date(2026, 10, 6), market, {"paper": None, "live": None, "account": None, "stats": {}, "open_now": 0, "discipline_score": None}, zones=ZONES)
    assert "Your zones today\n🟢 GOLDM support 147,116–147,673: tested and held ✅" in text and text.index("Your zones today") < text.index("Market:")
    assert "Your zones today" not in n.session_message("MCX", date(2026, 10, 6), market, None, trader_known=False)


def test_the_session_card_draws_the_zones_block():
    import io

    from PIL import Image

    from app.domain.session_card import render_session_card

    market = {"day": date(2026, 10, 6), "rows": [{"label": "GOLDM", "close": 148_897.0, "change_pct": 0.3, "high": 149_000.0, "low": 147_629.0, "position": 0.9}]}
    base = render_session_card("MCX", date(2026, 10, 6), market, None, trader_known=False)
    with_zones = render_session_card("MCX", date(2026, 10, 6), market, None, trader_known=False, zones=ZONES)
    assert Image.open(io.BytesIO(with_zones)).height > Image.open(io.BytesIO(base)).height + 200  # three rows of zones, taller by their height


# ---- the API ---------------------------------------------------------------------------------------------------------------------------------


def test_the_routes_sync_list_and_remove_only_the_callers_own_zones():
    from fastapi import HTTPException

    from app.api.routes import zone_watches as route
    from app.auth import User

    db = DB()
    out = route.sync("mcx", "GOLDM-05Nov2026-FUT", route.SyncIn(interval="15min", watches=[route.WatchIn(kind="zone", lo=147_116, hi=147_673)]), User(ME, False), db)
    assert [(w.exchange, w.lo, w.hi) for w in out] == [("MCX", 147_116.0, 147_673.0)]
    with pytest.raises(HTTPException) as e:
        route.sync("MCX", "X", route.SyncIn(watches=[route.WatchIn(kind="zone", lo=-5, hi=3)]), User(ME, False), db)
    assert e.value.status_code == 422
    with pytest.raises(HTTPException) as e:
        route.remove(out[0].id, User(YOU, False), db)  # someone else's is the same answer as none
    assert e.value.status_code == 404 and len(db.tables[ZoneWatch]) == 1
    with pytest.raises(HTTPException) as e:
        route.remove("not-a-uuid", User(ME, False), db)
    assert e.value.status_code == 404
    route.remove(out[0].id, User(ME, False), db)
    assert db.tables[ZoneWatch] == []


def test_every_zone_route_needs_a_signed_in_user():
    import inspect

    from app.api.routes import zone_watches as route
    from app.auth import require_user

    for fn in (route.sync, route.list_watches, route.remove):
        assert inspect.signature(fn).parameters["user"].default.dependency is require_user


def test_the_zone_jobs_are_scheduled_in_ist_and_the_morning_list_is_a_cron_at_08_50():
    import inspect
    import re

    from app import scheduler
    from app.config import settings

    source = inspect.getsource(scheduler.start_scheduler)
    assert "_check_zone_live" in source and "_check_zone_bars" in source
    cron = re.search(r"_send_zones_morning,\s*CronTrigger\((.*?)\),\s*id=", source, re.S).group(1)
    assert "timezone=settings.timezone" in cron and (settings.zone_morning_hour, settings.zone_morning_minute) == (8, 50)
