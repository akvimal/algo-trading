"""Major OI shifts (app/domain/oi_shifts.py), the intraday index shift (oi_index_shift.py), and what they say."""

from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.domain import notification_jobs as jobs
from app.domain import notifications as n
from app.domain import oi_index_shift as ix
from app.domain import oi_shifts as sh

DAY = date(2026, 10, 15)  # well clear of the monthly expiry window


def row(symbol="AAA", price=1.5, pcr=1.25, call_act="writers_covering", put_act="writing", call_chg=-6.0, put_chg=18.0, total=2_000_000, **o):
    return {
        "symbol": symbol, "pcr": pcr, "price_change_pct": price, "call_activity": call_act, "put_activity": put_act, "call_oi_change_pct": call_chg,
        "put_oi_change_pct": put_chg, "total_call_oi": total // 2, "total_put_oi": total // 2, "call_buildup": None, "put_buildup": None, **o,
    }


def hist(days=8, pcr=1.0, call=1.0, put=1.0, wobble=0.05, **o):
    """A quiet history: PCR drifts a few hundredths a day, OI changes a percent or two."""
    return [
        {"snapshot_date": DAY - timedelta(days=days - i), "pcr": pcr + (wobble if i % 2 else -wobble), "call_oi_change_pct": call + (i % 3 - 1), "put_oi_change_pct": put + (i % 3 - 1),
         "call_activity": None, "put_activity": None, "call_buildup": None, "put_buildup": None, **o}
        for i in range(days)
    ]


def one(r, h=None, floor=None):
    return sh.score_stock(r, hist() if h is None else h, floor, DAY)


# --- what counts as a major shift ------------------------------------------------------------------------------------------------


def test_put_writing_with_call_short_covering_and_a_big_pcr_move_is_a_strong_bullish_shift():
    s = one(row())
    assert s["direction"] == "bullish" and s["source"] == "premium_flow" and s["pcr_ok"] and s["size_ok"]
    assert s["reasons"] == ["call short covering", "put writing"] and s["lead_side"] == "put"
    assert (s["prev_pcr"], s["pcr"]) == (pytest.approx(1.05, abs=0.06), 1.25)


def test_call_buying_alone_with_the_price_up_is_bullish_and_the_mirror_is_bearish():
    assert one(row(call_act="buying", put_act=None, call_chg=25.0, put_chg=0.0))["direction"] == "bullish"
    bear = one(row(price=-1.6, pcr=0.8, call_act="writing", put_act="buying", call_chg=22.0, put_chg=14.0), hist(pcr=1.0))
    assert bear["direction"] == "bearish" and bear["reasons"] == ["call writing", "put buying"]


def test_flow_pointing_both_ways_or_unwinding_only_is_not_a_shift():
    assert one(row(call_act="writing", put_act="writing")) is None  # call writing is bearish, put writing bullish: no lean
    assert one(row(call_act="unwinding", put_act="unwinding")) is None  # buyers and sellers just leaving: not a new view


def test_the_price_must_agree_and_move_enough():
    assert one(row(price=-1.5)) is None  # bullish flow into a falling price
    assert one(row(price=0.2)) is None  # not enough of a move


def test_a_small_move_for_that_stock_is_not_a_shift_even_with_the_right_words():
    assert one(row(pcr=1.06, put_chg=3.0, call_chg=-2.0)) is None  # PCR barely moved and OI barely changed


def test_pcr_moving_against_the_read_does_not_back_it_but_a_big_oi_move_still_can():
    s = one(row(pcr=0.85))  # bullish flow but PCR fell
    assert s is not None and not s["pcr_ok"] and s["size_ok"]


def test_a_thin_stock_is_left_out():
    assert one(row(total=100_000), floor=1_000_000) is None
    assert one(row(total=5_000_000), floor=1_000_000) is not None


def test_a_flip_from_last_scans_lean_scores_higher_and_is_marked():
    before = hist(call_activity="writing", put_activity="buying")  # yesterday: bearish
    flipped = one(row(), before)
    plain = one(row(), hist())
    assert flipped["flipped"] and not plain["flipped"] and flipped["score"] > plain["score"]


def test_a_flip_is_only_claimed_between_two_nights_read_the_same_way():
    proxy_yesterday = hist(call_buildup="short_buildup", put_buildup="short_buildup")  # price-based, and bearish
    s = one(row(), proxy_yesterday)  # today's read is the measured premium flow
    assert not s["flipped"]  # a change of instrument is not a change of mind
    same = [{**h, "call_activity": "writing", "put_activity": "buying"} for h in hist()]
    assert one(row(), same)["flipped"]


def test_the_expiry_week_is_marked_and_docked():
    near = sh.score_stock(row(), hist(), None, date(2026, 10, 26))
    assert near["expiry_week"] and near["score"] < one(row())["score"]


def test_without_premium_flow_it_falls_back_to_the_price_based_labels_and_says_so():
    s = one(row(call_act=None, put_act=None, call_buildup="long_buildup", put_buildup="long_buildup", call_chg=20.0, put_chg=20.0))
    assert s["source"] == "price_proxy" and s["direction"] == "bullish" and s["reasons"] == ["call buying", "put writing"]


def test_too_little_history_skips_the_own_history_tests_and_uses_a_higher_plain_floor():
    short = hist(days=2)
    assert one(row(put_chg=12.0, call_act=None, pcr=1.0), short) is None  # 12% would pass with history, not without
    assert one(row(put_chg=18.0, pcr=1.0), short) is not None


def test_the_day_keeps_only_the_best_few_across_both_directions_and_is_empty_when_quiet():
    rows = [row(f"B{i}", put_chg=18.0 + i) for i in range(5)] + [row("S1", price=-1.6, pcr=0.8, call_act="writing", put_act="buying", call_chg=22.0, put_chg=14.0)]
    histories = {r["symbol"]: hist() for r in rows}
    picked = sh.pick_major_shifts(rows, histories, DAY, limit=5)
    assert len(picked) == 5 and [p["score"] for p in picked] == sorted((p["score"] for p in picked), reverse=True)
    assert {"bullish", "bearish"} == {p["direction"] for p in sh.pick_major_shifts(rows, histories, DAY, limit=6)}
    assert sh.pick_major_shifts([row("Q", price=0.1, pcr=1.0)], {}, DAY) == []


# --- the nightly message ------------------------------------------------------------------------------------------------------------


def test_the_shifts_message_gives_the_reasons_the_numbers_and_the_flags():
    s = one(row(), hist(call_activity="writing", put_activity="buying"))
    text = n.oi_shifts_message([s], DAY)
    assert text.startswith("⚡ OI major shifts · 15 Oct close")
    assert "AAA" in text and "call short covering + put writing" in text and "PCR 1.0" in text and "flipped from bearish last scan" in text
    assert "not a prediction or a recommendation" in text
    assert n.oi_shifts_message([], DAY) is None  # nothing on a quiet day


# --- the intraday index shift --------------------------------------------------------------------------------------------------------


def strikes(spot, ce_oi, pe_oi, ce_ltp, pe_ltp, n_=7):
    return {"spot": spot, "rows": [{"strike": 24000 + (i - n_ // 2) * 50, "ce_oi": ce_oi, "pe_oi": pe_oi, "ce_ltp": ce_ltp, "pe_ltp": pe_ltp} for i in range(n_)]}


FLAT = strikes(24000, 100_000, 100_000, 100.0, 100.0)
# half an hour later: put OI up and put premium down (put writing), call OI down and call premium up (call writers covering), the index up
BULLISH_NOW = strikes(24060, 96_000, 106_000, 102.0, 96.0)
BEARISH_NOW = strikes(23940, 106_000, 96_000, 96.0, 102.0)  # call writing + put writers covering... mirrored below


def test_two_flows_leaning_the_same_way_with_pcr_and_the_index_agreeing_is_a_shift():
    w = ix.detect(None, FLAT, BULLISH_NOW)
    assert w["direction"] == "bullish" and w["reasons"] == ["call short covering", "put writing"]
    assert w["pcr_then"] == 1.0 and w["pcr_now"] > 1.08 and w["spot_move_pct"] > 0.1


def test_a_single_flow_is_not_enough_unless_the_lean_flipped():
    one_flow = strikes(24060, 100_000, 109_000, 100.0, 96.0)  # only the put side moved: put writing, PCR up, the index up
    assert ix.detect(None, FLAT, one_flow) is None
    before = strikes(24100, 90_000, 90_000, 110.0, 90.0)  # from here to FLAT: call OI up with the premium down (call writing), put OI up with the premium up (put buying) - bearish
    assert ix.window(before, FLAT)["direction"] == "bearish"
    w = ix.detect(before, FLAT, one_flow)
    assert w["direction"] == "bullish" and w["flipped"] and w["reasons"] == ["put writing"]
    assert ix.detect(None, FLAT, one_flow) is None and ix.detect(FLAT, FLAT, one_flow) is None  # no earlier half hour, or one that was not opposite


def test_a_move_the_index_did_not_confirm_or_a_small_pcr_move_is_ignored():
    assert ix.detect(None, FLAT, strikes(23990, 96_000, 106_000, 102.0, 96.0)) is None  # the index fell while the flow said bullish
    assert ix.detect(None, FLAT, strikes(24060, 99_000, 101_500, 100.5, 99.0)) is None  # nothing near the flow thresholds


def test_alerts_only_run_inside_the_session_and_on_weekdays():
    ist = timezone(timedelta(hours=5, minutes=30))
    assert ix.active_now(datetime(2026, 10, 15, 10, 0, tzinfo=ist)) and ix.active_now(datetime(2026, 10, 15, 15, 15, tzinfo=ist))
    assert not ix.active_now(datetime(2026, 10, 15, 9, 20, tzinfo=ist)) and not ix.active_now(datetime(2026, 10, 15, 15, 30, tzinfo=ist))
    assert not ix.active_now(datetime(2026, 10, 17, 11, 0, tzinfo=ist))  # a Saturday


def test_it_compares_with_the_snapshot_half_an_hour_back_and_refuses_a_stale_recorder():
    t0 = datetime(2026, 10, 15, 5, 0, tzinfo=timezone.utc)
    times = [t0 + timedelta(minutes=5 * i) for i in range(14)]  # 65 minutes of snapshots
    now = times[-1] + timedelta(minutes=1)
    before, then, last = ix.pick_snapshots(times, now)
    assert last == 13 and times[last] - times[then] == timedelta(minutes=30) and times[then] - times[before] == timedelta(minutes=30)
    assert ix.pick_snapshots(times, now + timedelta(minutes=30)) is None  # the recorder stalled: do not alert on old data
    assert ix.pick_snapshots(times[:3], times[2] + timedelta(minutes=1)) is None  # not half an hour of history yet


def test_the_index_message_says_what_moved():
    w = ix.detect(None, FLAT, BULLISH_NOW)
    at = datetime(2026, 10, 15, 11, 5, tzinfo=timezone(timedelta(hours=5, minutes=30)))
    text = n.oi_index_message("NIFTY", w, at)
    assert text.startswith("🟢 NIFTY OI shift · 11:05") and "call short covering + put writing" in text and "PCR 1.00 →" in text and "not a prediction" in text


# --- the cooldown and the send ---------------------------------------------------------------------------------------------------------


class FakeQuery:
    def __init__(self, found):
        self.found = found

    def filter(self, *a):
        return self

    def first(self):
        return self.found


def test_an_index_is_not_alerted_twice_inside_the_cooldown(monkeypatch):
    now = datetime(2026, 10, 15, 5, 30, tzinfo=timezone.utc)
    sent = []
    monkeypatch.setattr(jobs, "oi_index_shift_symbols", lambda: ["NIFTY"])
    monkeypatch.setattr(jobs, "detect_index_shift", lambda db, symbol, when: ix.detect(None, FLAT, BULLISH_NOW))
    monkeypatch.setattr(n, "broadcast", lambda db, category, key, build, now=None, **kw: (sent.append((category, key, build({}))), n.Tally(sent=1))[1])
    db = SimpleNamespace(query=lambda *a: FakeQuery(None))
    assert jobs.check_oi_index_shift(db, now) == {"checked": 1, "detected": 1, "sent": 1}
    assert sent[0][0] == "oi_index_shift" and sent[0][1].startswith("NIFTY:2026") and "NIFTY OI shift" in sent[0][2]
    db2 = SimpleNamespace(query=lambda *a: FakeQuery(object()))  # one went out in the last hour
    assert jobs.check_oi_index_shift(db2, now) == {"checked": 1, "detected": 0, "sent": 0} and len(sent) == 1


def test_nothing_is_checked_outside_the_alert_hours(monkeypatch):
    monkeypatch.setattr(jobs, "detect_index_shift", lambda *a: pytest.fail("must not look"))
    night = datetime(2026, 10, 15, 18, 0, tzinfo=timezone.utc)  # 23:30 IST
    assert jobs.check_oi_index_shift(SimpleNamespace(), night) == {"checked": 0, "detected": 0, "sent": 0}


def test_the_shifts_go_only_to_people_on_shifts_or_both_and_only_for_todays_scan(monkeypatch):
    s = one(row())
    monkeypatch.setattr(jobs, "latest_shifts", lambda db: ([s], DAY))
    seen = []
    monkeypatch.setattr(n, "broadcast", lambda db, category, key, build, now=None, **kw: (seen.append((key, [build({"mode": m}) is not None for m in ("shifts", "digest", "both")])), n.Tally(sent=1))[1])
    assert jobs.oi_shifts_to_subscribers(object(), today=DAY).sent == 1
    assert seen == [("oi-shifts:2026-10-15", [True, False, True])]
    assert jobs.oi_shifts_to_subscribers(object(), today=date(2026, 10, 16)).sent == 0  # an old scan is never announced as today's
    monkeypatch.setattr(jobs, "latest_shifts", lambda db: ([], DAY))
    seen.clear()
    jobs.oi_shifts_to_subscribers(object(), today=DAY)
    assert seen == [("oi-shifts:2026-10-15", [False, False, False])]  # a quiet day sends nobody anything
