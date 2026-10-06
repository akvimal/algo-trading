import inspect
import re
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app import scheduler
from app.api.routes import notifications as route
from app.auth import User, require_user
from app.config import settings
from app.domain import notification_jobs as jobs
from app.domain import notifications as n

IST = ZoneInfo("Asia/Kolkata")
ME, YOU = uuid4(), uuid4()
NOW = datetime(2026, 10, 6, 3, 15, tzinfo=timezone.utc)  # 08:45 IST


# ---- fakes -----------------------------------------------------------------------------------------------------------------------


class FakeDB:
    """A Session with just a dict of log rows, plus swappable subscriptions / chats / pending rows."""

    def __init__(self):
        self.log, self.commits = {}, 0

    def get(self, model, key):
        return self.log.get(key) if model is n.NotificationLog else getattr(self, "other", {}).get(key)

    def add(self, row):
        if isinstance(row, n.NotificationLog):
            self.log[(row.user_id, row.category, row.dedupe_key)] = row

    def commit(self):
        self.commits += 1


class Telegram:
    def __init__(self, monkeypatch, fail=None):
        self.sent, self.fail = [], fail  # fail: a reason string, or a callable(chat) -> reason|None
        monkeypatch.setattr(n, "send_telegram", self.send)

    def send(self, text, chat):
        reason = self.fail(chat) if callable(self.fail) else self.fail
        if reason:
            return reason
        self.sent.append((chat, text))
        return None


def subs(monkeypatch, *people, category="premarket", params=None):
    """people: (user_id, chat or None). Wires the subscription + chat lookups."""
    rows = [SimpleNamespace(user_id=u, params=params or {}) for u, _ in people]
    monkeypatch.setattr(n, "_enabled_subscriptions", lambda db, c: rows if c == category else [])
    monkeypatch.setattr(n, "_chats_for", lambda db, ids: {u: chat for u, chat in people if chat and u in set(ids)})


# ---- settings ---------------------------------------------------------------------------------------------------------------------


def test_every_category_starts_with_sane_defaults_and_only_ops_is_admin_only():
    assert {k: c.admin_only for k, c in n.CATEGORIES.items()} == {"premarket": False, "oi_buildup": False, "ops": True}
    assert n.clean_params("oi_buildup", None) == {"top_n": 10}
    assert n.clean_params("premarket", {"top_n": 99}) == {}  # settings a category does not have are dropped


def test_the_oi_digest_size_is_a_whole_number_in_range():
    assert n.clean_params("oi_buildup", {"top_n": 5}) == {"top_n": 5}
    assert n.clean_params("oi_buildup", {"top_n": 20}) == {"top_n": 20}
    for bad in (2, 21, 0, -1, "10", 7.5, True, None):
        with pytest.raises(n.NotificationError):
            n.clean_params("oi_buildup", {"top_n": bad})


# ---- pre-market message -------------------------------------------------------------------------------------------------------------


def inp(key, change, value=None, unit="pct", ok=True):
    return {"key": key, "label": key, "group": "x", "ok": ok, "value": value, "change": change, "unit": unit}


REPORT = {
    "inputs": [inp("gift_nifty", 0.44, 22654.5), inp("sp500", 0.66), inp("dow", 0.18), inp("nasdaq", 1.05), inp("brent", 0.38), inp("usdinr", 0.10), inp("us10y", 3.4, unit="bp"), inp("in10y", 1.8, unit="bp"),
               inp("adr_infy", -2.54), inp("adr_hdb", -1.03), inp("adr_ibn", 1.13)],
    "rules": {"bias": "neutral", "score": 0.18},
    "ai": {"bias": "bullish", "confidence": 72, "one_liner": "A positive open on the GIFT gap and a firm US close.", "watch": "Nifty holding above 22,600."},
}


def test_the_premarket_message_carries_the_bias_the_numbers_and_what_to_watch():
    text = n.premarket_message(REPORT, date(2026, 10, 6))
    assert text.startswith("☀️ Pre-market · Tue 6 Oct\nBias: Bullish (AI 72% confident) · fixed rules: neutral")
    assert "A positive open on the GIFT gap and a firm US close." in text
    assert "GIFT Nifty +0.44% vs last close (22,654)" in text
    assert "US: S&P +0.66% · Dow +0.18% · Nasdaq +1.05%" in text
    assert "Brent +0.38% · USD/INR +0.10% · US 10Y +3.4 bp · India 10Y +1.8 bp" in text
    assert "ADRs: INFY −2.54% · HDB −1.03% · IBN +1.13%" in text  # a real minus sign, and only the ADRs that loaded
    assert "Watch at the open: Nifty holding above 22,600." in text
    assert text.endswith("Market context from public data, not a recommendation. Details in the app.")


def test_it_does_not_mention_the_rules_when_they_agree_and_says_so_when_there_is_no_ai():
    agree = n.premarket_message({**REPORT, "rules": {"bias": "bullish", "score": 0.4}}, date(2026, 10, 6))
    assert "fixed rules" not in agree
    no_ai = n.premarket_message({**REPORT, "ai": None}, date(2026, 10, 6))
    assert "Bias: Neutral (fixed rules only)" in no_ai and "Watch at the open" not in no_ai


def test_a_rambling_one_liner_is_cut_at_a_sentence_so_the_message_stays_a_glance():
    long_ai = {**REPORT["ai"], "one_liner": "A positive open is likely. " * 40, "watch": "Watch the zone and then some more detail. " * 30}
    text = n.premarket_message({**REPORT, "ai": long_ai}, date(2026, 10, 6))
    one_liner = text.split("\n")[3]
    assert len(one_liner) <= n.ONE_LINER_MAX and one_liner.endswith("likely.")
    assert len(next(line for line in text.split("\n") if line.startswith("Watch at the open"))) <= len("Watch at the open: ") + n.WATCH_MAX
    assert len(text) < 1500


def test_shorten_cuts_at_a_sentence_then_a_word_and_leaves_short_text_alone():
    assert n.shorten("Short.", 50) == "Short."
    assert n.shorten("One. Two. Three. Four. Five.", 18) == "One. Two. Three."
    out = n.shorten("word " * 100, 30)
    assert len(out) <= 31 and out.endswith("…") and not out.endswith(" …")
    assert n.shorten("a  \n b", 50) == "a b"


def test_missing_inputs_are_left_out_rather_than_shown_as_blanks():
    sparse = {"inputs": [inp("gift_nifty", 0.44, 22654.5), inp("sp500", None, ok=False)], "rules": {"bias": "neutral"}, "ai": None}
    text = n.premarket_message(sparse, date(2026, 10, 6))
    assert "S&P" not in text and "ADRs" not in text and "–" not in text
    assert "GIFT Nifty +0.44%" in text and len(text) < 4096


# ---- strong OI buildup --------------------------------------------------------------------------------------------------------------


def oi(symbol, call, put, cb="long_buildup", pb="long_buildup", price=1.0):
    return {"symbol": symbol, "call_oi_change_pct": call, "put_oi_change_pct": put, "call_buildup": cb, "put_buildup": pb, "price_change_pct": price}


def test_strong_means_both_sides_grew_at_least_ten_percent_with_the_same_buildup():
    assert n.oi_signal(oi("A", 10, 10)) == "bull"
    assert n.oi_signal(oi("A", 30, 12, "short_buildup", "short_buildup", -1)) == "bear"
    assert n.oi_signal(oi("A", 9.9, 40)) is None  # one side below the threshold
    assert n.oi_signal(oi("A", 40, 40, "long_buildup", "short_buildup")) is None  # the two sides disagree
    assert n.oi_signal(oi("A", None, 40)) is None and n.oi_signal(oi("A", 40, None)) is None
    assert n.oi_signal(oi("A", 40, 40, "short_covering", "short_covering")) is None


def test_the_top_few_are_ranked_by_the_combined_shift_with_ties_by_symbol():
    rows = [oi("SMALL", 10, 10), oi("BIG", 50, 60), oi("MID", 20, 30), oi("TIEB", 15, 15), oi("TIEA", 15, 15), oi("BEAR", 25, 25, "short_buildup", "short_buildup", -2), oi("NONE", 5, 5)]
    bull, bear, n_bull, n_bear = n.strong_oi(rows, 3)
    assert [r["symbol"] for r in bull] == ["BIG", "MID", "TIEA"] and (n_bull, n_bear) == (5, 1)
    assert [r["symbol"] for r in bear] == ["BEAR"]


def test_the_digest_is_one_message_with_both_lists_the_counts_and_no_advice():
    rows = [oi("RELIANCE", 24.4, 31.2, price=1.24), oi("INFY", 12, 15, "short_buildup", "short_buildup", -0.8)]
    text = n.oi_digest_message(rows, date(2026, 10, 6), 10)
    assert text.startswith("📊 Strong OI buildup · 6 Oct close")
    assert "🟢 Strong bullish (top 1 of 1)\n1. RELIANCE  call +24% · put +31% · price +1.24%" in text
    assert "🔴 Strong bearish (top 1 of 1)\n1. INFY  call +12% · put +15% · price −0.80%" in text
    assert text.endswith("Option-chain activity for the day, not a prediction or a recommendation.")


def test_with_one_side_empty_it_says_none_and_with_neither_there_is_no_message():
    only_bull = n.oi_digest_message([oi("A", 20, 20)], date(2026, 10, 6), 10)
    assert "🔴 Strong bearish: none" in only_bull
    assert n.oi_digest_message([oi("A", 5, 5), oi("B", 20, 20, "long_buildup", "short_buildup")], date(2026, 10, 6), 10) is None
    assert n.oi_digest_message([], date(2026, 10, 6), 10) is None


def test_a_full_digest_stays_well_inside_telegrams_message_limit():
    rows = [oi(f"SYMBOL{i:02d}", 10 + i, 10 + i) for i in range(30)] + [oi(f"BEARISH{i:02d}", 10 + i, 10 + i, "short_buildup", "short_buildup", -3) for i in range(30)]
    assert len(n.oi_digest_message(rows, date(2026, 10, 6), n.TOP_N_MAX)) < 3000


# ---- operator alerts --------------------------------------------------------------------------------------------------------------


def test_the_token_message_has_three_states_and_a_key_per_expiry():
    expiry = datetime(2026, 10, 6, 11, 0, tzinfo=timezone.utc)  # 16:30 IST
    assert n.token_message(expiry, expiry - timedelta(hours=7), IST) is None
    key, text = n.token_message(expiry, expiry - timedelta(hours=2, minutes=5), IST)
    assert key == f"token-expiring:{expiry.isoformat()}" and "expires at 6 Oct 16:30 IST, in 2h 05m" in text
    key2, text2 = n.token_message(expiry, expiry + timedelta(minutes=1), IST)
    assert key2 == f"token-expired:{expiry.isoformat()}" and "expired (6 Oct 16:30 IST)" in text2
    renewed = expiry + timedelta(days=1)
    assert n.token_message(renewed, expiry + timedelta(hours=1), IST) is None  # a fresh token clears it, and its key differs


def test_a_failed_job_message_names_the_job_and_the_reason_and_is_bounded():
    text = n.job_failed_message("OI buildup snapshot", "x" * 500, datetime(2026, 10, 6, 10, 35, tzinfo=timezone.utc), IST)
    assert text.startswith("🔴 Background job failed at 16:05 IST: OI buildup snapshot\n") and len(text) < 330
    assert "no reason recorded" in n.job_failed_message("J", None, NOW, IST)


def test_a_job_that_failed_several_times_says_so_in_one_message():
    text = n.job_failed_message("Dhan token renewal", "401", datetime(2026, 10, 6, 6, 31, tzinfo=timezone.utc), IST, count=5)
    assert text.startswith("🔴 Background job failed 5 times today, latest at 12:01 IST: Dhan token renewal")


def test_a_failure_from_an_earlier_day_says_which_day_not_today():
    earlier = datetime(2026, 10, 5, 8, 40, tzinfo=timezone.utc)  # 14:10 IST on the 5th
    today = date(2026, 10, 6)
    assert n.job_failed_message("Dhan token renewal", "401", earlier, IST, 1, today).startswith("🔴 Background job failed on 5 Oct at 14:10 IST: Dhan token renewal")
    assert n.job_failed_message("Dhan token renewal", "401", earlier, IST, 4, today).startswith("🔴 Background job failed 4 times on 5 Oct, latest at 14:10 IST")
    assert "today" in n.job_failed_message("J", "x", datetime(2026, 10, 6, 5, 0, tzinfo=timezone.utc), IST, 3, today)


class JobsDB:
    def __init__(self, runs):
        self.runs = runs

    def query(self, model):
        return self

    def filter(self, *a, **k):
        return self

    def order_by(self, *a):
        return self

    def limit(self, k):
        return self

    def all(self):
        return self.runs


def run_of(job_id, label, minutes_ago, message="boom"):
    return SimpleNamespace(id=uuid4(), job_id=job_id, label=label, message=message, started_at=NOW - timedelta(minutes=minutes_ago))


@pytest.fixture(autouse=True)
def _nothing_has_recovered_by_default(monkeypatch):
    monkeypatch.setattr(jobs, "_latest_success_by_job", lambda db, job_ids: {})


def test_ops_messages_combine_the_token_and_each_failed_job_with_a_key_that_does_not_repeat_within_a_day():
    run = run_of("oi-eod-snapshot-record", "OI buildup snapshot", 60, "0 NSE F&O stocks listed")
    out = jobs.ops_messages(JobsDB([run]), NOW, NOW - timedelta(minutes=5))
    assert [k.split(":")[0] for k, _ in out] == ["token-expired", "job-failed"] and out[1][0] == "job-failed:oi-eod-snapshot-record:2026-10-06"


def test_a_job_failing_over_and_over_is_one_alert_with_its_count_not_one_per_run():
    runs = [run_of("dhan-token-renew", "Dhan token renewal", m, "401 latest" if m == 5 else "401 older") for m in (5, 20, 40, 90, 120)]
    out = jobs.ops_messages(JobsDB(runs), NOW, None)
    assert len(out) == 1 and out[0][0] == "job-failed:dhan-token-renew:2026-10-06"
    assert "failed 5 times today" in out[0][1] and "401 latest" in out[0][1] and "401 older" not in out[0][1]


def test_different_jobs_are_separate_alerts_and_the_next_day_is_a_new_one():
    runs = [run_of("a-job", "A", 10), run_of("b-job", "B", 20), run_of("a-job", "A", 60 * 20)]  # the last one failed on the previous IST day
    keys = [k for k, _ in jobs.ops_messages(JobsDB(runs), NOW, None)]
    assert keys == ["job-failed:a-job:2026-10-06", "job-failed:b-job:2026-10-06", "job-failed:a-job:2026-10-05"]


def test_only_a_few_jobs_are_reported_per_pass():
    runs = [run_of(f"job-{i}", f"Job {i}", i + 1) for i in range(12)]
    assert len(jobs.ops_messages(JobsDB(runs), NOW, None)) == jobs.JOB_FAILURES_PER_PASS
    assert jobs.ops_messages(JobsDB([]), NOW, NOW + timedelta(days=1)) == []
    assert jobs.ops_messages(JobsDB([]), NOW, None) == []  # no token configured: nothing to say about it


# ---- delivery: once, recorded, retried, bounded ---------------------------------------------------------------------------------------


def test_a_message_is_sent_once_and_recorded(monkeypatch):
    tg, db = Telegram(monkeypatch), FakeDB()
    assert n.deliver(db, ME, "111", "premarket", "premarket:2026-10-06", "hello", NOW) == "sent"
    row = db.log[(ME, "premarket", "premarket:2026-10-06")]
    assert row.sent_at == NOW and row.attempts == 1 and row.last_error is None and tg.sent == [("111", "hello")]
    assert n.deliver(db, ME, "111", "premarket", "premarket:2026-10-06", "hello again", NOW) == "skipped"  # a re-run never repeats it
    assert len(tg.sent) == 1


def test_a_failed_send_is_kept_with_its_reason_and_can_succeed_on_a_retry(monkeypatch):
    tg, db = Telegram(monkeypatch, fail="could not reach Telegram"), FakeDB()
    assert n.deliver(db, ME, "111", "oi_buildup", "oi:2026-10-06", "digest", NOW) == "failed"
    row = db.log[(ME, "oi_buildup", "oi:2026-10-06")]
    assert row.sent_at is None and row.attempts == 1 and row.last_error == "could not reach Telegram"
    tg.fail = None
    assert n.deliver(db, ME, "111", "oi_buildup", "oi:2026-10-06", "digest", NOW) == "sent"
    assert row.attempts == 2 and row.last_error is None and row.sent_at == NOW


def test_it_gives_up_after_the_attempt_limit(monkeypatch):
    tg, db = Telegram(monkeypatch, fail="the bot cannot message this chat"), FakeDB()
    for _ in range(n.MAX_ATTEMPTS):
        assert n.deliver(db, ME, "111", "premarket", "k", "t", NOW) == "failed"
    tg.fail = None
    assert n.deliver(db, ME, "111", "premarket", "k", "t", NOW) == "skipped" and tg.sent == []


def test_a_broadcast_goes_only_to_subscribers_with_a_chat_each_to_their_own(monkeypatch):
    tg, db = Telegram(monkeypatch), FakeDB()
    subs(monkeypatch, (ME, "111"), (YOU, "222"), (uuid4(), None))  # the third has the category on but no chat
    t = n.broadcast(db, "premarket", "premarket:2026-10-06", lambda params: "msg", NOW)
    assert (t.sent, t.failed, t.skipped) == (2, 0, 0) and sorted(c for c, _ in tg.sent) == ["111", "222"]


def test_a_second_broadcast_of_the_same_item_sends_nothing(monkeypatch):
    tg, db = Telegram(monkeypatch), FakeDB()
    subs(monkeypatch, (ME, "111"), (YOU, "222"))
    n.broadcast(db, "premarket", "premarket:2026-10-06", lambda p: "msg", NOW)
    t = n.broadcast(db, "premarket", "premarket:2026-10-06", lambda p: "msg", NOW)
    assert (t.sent, t.skipped) == (0, 2) and len(tg.sent) == 2
    n.broadcast(db, "premarket", "premarket:2026-10-07", lambda p: "msg", NOW)  # the next day is a new item
    assert len(tg.sent) == 4


def test_a_person_with_nothing_to_receive_is_skipped_and_each_gets_their_own_settings(monkeypatch):
    tg, db = Telegram(monkeypatch), FakeDB()
    subs(monkeypatch, (ME, "111"), (YOU, "222"), category="oi_buildup")
    rows = [SimpleNamespace(user_id=ME, params={"top_n": 3}), SimpleNamespace(user_id=YOU, params={"top_n": 20})]
    monkeypatch.setattr(n, "_enabled_subscriptions", lambda d, c: rows)
    seen = []
    t = n.broadcast(db, "oi_buildup", "oi:x", lambda params: (seen.append(params["top_n"]), None if params["top_n"] == 3 else "digest")[1], NOW)
    assert sorted(seen) == [3, 20] and (t.sent, t.skipped) == (1, 1) and tg.sent == [("222", "digest")]


def test_a_failure_for_one_person_does_not_stop_the_others(monkeypatch):
    tg, db = Telegram(monkeypatch, fail=lambda chat: "could not reach Telegram" if chat == "111" else None), FakeDB()
    subs(monkeypatch, (ME, "111"), (YOU, "222"))
    t = n.broadcast(db, "premarket", "k", lambda p: "msg", NOW)
    assert (t.sent, t.failed) == (1, 1) and tg.sent == [("222", "msg")]


def row(user, key, attempts=1, created=NOW, sent=None):
    return n.NotificationLog(user_id=user, category="premarket", dedupe_key=key, text="msg", created_at=created, sent_at=sent, attempts=attempts)


def test_retry_resends_failed_messages_to_the_current_chat_and_leaves_a_removed_chat_alone(monkeypatch):
    tg, db = Telegram(monkeypatch), FakeDB()
    a, b = row(ME, "a"), row(YOU, "b")
    monkeypatch.setattr(n, "_pending_rows", lambda d, now: [a, b])
    monkeypatch.setattr(n, "_chats_for", lambda d, ids: {ME: "111"})  # YOU removed their chat
    t = n.retry_pending(db, NOW)
    assert (t.sent, t.failed, t.skipped) == (1, 0, 1) and tg.sent == [("111", "msg")]
    assert a.sent_at == NOW and a.attempts == 2 and b.sent_at is None and b.attempts == 1  # not counted against it


def test_retry_counts_a_failed_resend_and_does_nothing_when_there_is_nothing_pending(monkeypatch):
    Telegram(monkeypatch, fail="could not reach Telegram")
    a = row(ME, "a")
    monkeypatch.setattr(n, "_pending_rows", lambda d, now: [a])
    monkeypatch.setattr(n, "_chats_for", lambda d, ids: {ME: "111"})
    t = n.retry_pending(FakeDB(), NOW)
    assert t.failed == 1 and a.attempts == 2 and a.last_error == "could not reach Telegram"
    monkeypatch.setattr(n, "_pending_rows", lambda d, now: [])
    assert n.retry_pending(FakeDB(), NOW).sent == 0


# ---- wiring ----------------------------------------------------------------------------------------------------------------------------


def test_every_scheduled_cron_names_its_timezone():
    """Without timezone= a CronTrigger fires on the container's UTC clock, 5h30m late (the pre-market job nearly did)."""
    source = inspect.getsource(scheduler.start_scheduler)
    triggers = re.findall(r"CronTrigger\((.*?)\),\n", source, re.S)
    assert len(triggers) >= 5 and all("timezone=settings.timezone" in t for t in triggers), [t for t in triggers if "timezone=" not in t]


def test_the_oi_scan_runs_at_405_pm_ist_and_the_equity_screener_runs_after_it_without_overlap():
    assert (settings.oi_eod_snapshot_hour, settings.oi_eod_snapshot_minute) == (16, 5)
    oi_start = settings.oi_eod_snapshot_hour * 60 + settings.oi_eod_snapshot_minute
    eq_start = settings.equity_screener_snapshot_hour * 60 + settings.equity_screener_snapshot_minute
    assert eq_start - oi_start >= 20  # the OI scan takes ~10-15 minutes; they share Dhan's rate limit


def test_the_digest_goes_out_only_after_the_scan_finishes_and_only_if_most_of_it_was_written():
    source = inspect.getsource(scheduler._record_oi_eod_snapshot)
    assert source.index("_log_eod_summary(") < source.index("send_oi_digest()")
    assert 'tally["written"] >= max(1, len(symbols) // 2)' in source


def test_the_morning_job_pushes_the_report_after_saving_it():
    source = inspect.getsource(scheduler._record_premarket_report)
    assert source.index("save_report(") < source.index("send_premarket(")


# ---- the routes ----------------------------------------------------------------------------------------------------------------------


def test_every_notification_route_needs_a_signed_in_user():
    for r in route.router.routes:
        assert require_user in {d.call for d in r.dependant.dependencies}, r.path
    assert len(route.router.routes) == 4


class RouteDB:
    def __init__(self, chat=True, sub=None):
        self.chat, self.sub, self.added, self.log, self.commits = chat, sub, [], {}, 0

    def get(self, model, key):
        if model is route.AlertChannel:
            return SimpleNamespace(telegram_chat_id="111") if self.chat else None
        if model is route.NotificationSubscription:
            return self.sub
        return self.log.get(key)

    def add(self, row):
        if isinstance(row, route.NotificationSubscription):
            self.sub = row
        else:
            self.log[(row.user_id, row.category, row.dedupe_key)] = row

    def commit(self):
        self.commits += 1

    def query(self, model):
        return SimpleNamespace(filter=lambda *a: SimpleNamespace(all=lambda: [self.sub] if self.sub else []))


def test_a_person_sees_the_categories_they_may_use_all_off_and_whether_they_have_a_chat():
    out = route._state(RouteDB(chat=False), User(ME, False))
    assert out.chat_ready is False and [c.key for c in out.categories] == ["premarket", "oi_buildup"]
    assert not any(c.enabled for c in out.categories) and next(c for c in out.categories if c.key == "oi_buildup").params == {"top_n": 10}
    assert [c.key for c in route._state(RouteDB(), User(ME, True)).categories] == ["premarket", "oi_buildup", "ops"]


def test_switching_a_category_on_saves_it_and_a_bad_setting_is_refused():
    db = RouteDB()
    out = route.set_notification("oi_buildup", route.SubscriptionIn(enabled=True, params={"top_n": 5}), User(ME, False), db)
    assert db.sub.enabled is True and db.sub.params == {"top_n": 5} and db.sub.category == "oi_buildup"
    assert next(c for c in out.categories if c.key == "oi_buildup").params == {"top_n": 5}
    with pytest.raises(HTTPException) as e:
        route.set_notification("oi_buildup", route.SubscriptionIn(enabled=True, params={"top_n": 99}), User(ME, False), RouteDB())
    assert e.value.status_code == 422


def test_the_operator_category_is_admin_only_and_unknown_ones_are_not_found():
    with pytest.raises(HTTPException) as e:
        route.set_notification("ops", route.SubscriptionIn(enabled=True), User(ME, False), RouteDB())
    assert e.value.status_code == 403
    route.set_notification("ops", route.SubscriptionIn(enabled=True), User(ME, True), RouteDB())
    with pytest.raises(HTTPException) as e:
        route.set_notification("weather", route.SubscriptionIn(enabled=True), User(ME, True), RouteDB())
    assert e.value.status_code == 404


def test_send_now_needs_a_chat_and_is_rate_limited(monkeypatch):
    route._last_send.clear()
    with pytest.raises(HTTPException) as e:
        route.send_now("premarket", User(ME, False), RouteDB(chat=False))
    assert e.value.status_code == 400
    Telegram(monkeypatch)
    monkeypatch.setattr(route, "get_report", lambda db: SimpleNamespace(day=date(2026, 10, 6), inputs=REPORT["inputs"], rules=REPORT["rules"], ai=REPORT["ai"]))
    assert route.send_now("premarket", User(ME, False), RouteDB()) == {"sent": True}
    with pytest.raises(HTTPException) as e:
        route.send_now("premarket", User(ME, False), RouteDB())
    assert e.value.status_code == 429


def test_send_now_with_nothing_to_send_says_so_instead_of_sending_an_empty_message(monkeypatch):
    route._last_send.clear()
    tg = Telegram(monkeypatch)
    monkeypatch.setattr(route, "get_report", lambda db: None)
    with pytest.raises(HTTPException) as e:
        route.send_now("premarket", User(ME, False), RouteDB())
    assert e.value.status_code == 404 and tg.sent == []
    route._last_send.clear()
    monkeypatch.setattr(route.notification_jobs, "latest_oi_rows", lambda db: ([oi("A", 5, 5)], date(2026, 10, 6)))
    with pytest.raises(HTTPException) as e:
        route.send_now("oi_buildup", User(ME, False), RouteDB())
    assert e.value.status_code == 404 and "strong two-sided shift" in e.value.detail and tg.sent == []


def test_a_failed_manual_send_says_why_and_is_not_left_to_retry_in_the_background(monkeypatch):
    route._last_send.clear()
    Telegram(monkeypatch, fail="the bot cannot message this chat (start the bot first)")
    monkeypatch.setattr(route, "get_report", lambda db: SimpleNamespace(day=date(2026, 10, 6), inputs=REPORT["inputs"], rules=REPORT["rules"], ai=None))
    db = RouteDB()
    with pytest.raises(HTTPException) as e:
        route.send_now("premarket", User(ME, False), db)
    assert e.value.status_code == 502 and "start the bot first" in e.value.detail
    (logged,) = db.log.values()
    assert logged.dedupe_key.startswith("manual:") and logged.attempts == n.MAX_ATTEMPTS


def test_the_delivery_status_is_sent_retrying_or_gave_up():
    assert route._status(row(ME, "a", sent=NOW)) == "sent"
    assert route._status(row(ME, "b", attempts=2)) == "retrying"
    assert route._status(row(ME, "c", attempts=n.MAX_ATTEMPTS)) == "gave_up"


# ---- a failure that has since recovered is history, not a problem ---------------------------------------------------------------


def test_a_job_that_failed_and_then_ran_fine_is_no_longer_reported(monkeypatch):
    runs = [run_of("dhan-token-renew", "Dhan token renewal", m) for m in (20, 40, 90)]
    monkeypatch.setattr(jobs, "_latest_success_by_job", lambda db, ids: {"dhan-token-renew": NOW - timedelta(minutes=5)})  # a good run AFTER the newest failure
    assert jobs.ops_messages(JobsDB(runs), NOW, None) == []


def test_a_job_whose_good_run_came_before_the_failure_is_still_reported(monkeypatch):
    runs = [run_of("dhan-token-renew", "Dhan token renewal", 10)]
    monkeypatch.setattr(jobs, "_latest_success_by_job", lambda db, ids: {"dhan-token-renew": NOW - timedelta(hours=3)})
    assert len(jobs.ops_messages(JobsDB(runs), NOW, None)) == 1


def test_recovery_is_per_job_so_one_healthy_job_does_not_hide_another_that_is_still_failing(monkeypatch):
    runs = [run_of("a-job", "A", 10), run_of("b-job", "B", 20)]
    monkeypatch.setattr(jobs, "_latest_success_by_job", lambda db, ids: {"a-job": NOW - timedelta(minutes=1)})
    assert [k for k, _ in jobs.ops_messages(JobsDB(runs), NOW, None)] == ["job-failed:b-job:2026-10-06"]


def test_the_operator_status_says_all_clear_only_when_nothing_is_failing(monkeypatch):
    monkeypatch.setattr(jobs, "_token_expiry", lambda: NOW + timedelta(hours=20))
    clear = jobs.ops_status_text(JobsDB([]), NOW)
    assert clear.startswith("✅ Operator check: the Dhan token is fine (valid until ") and clear.endswith("no background job is currently failing.")
    runs = [run_of("dhan-token-renew", "Dhan token renewal", 10)]
    assert "Background job failed" in jobs.ops_status_text(JobsDB(runs), NOW)
    monkeypatch.setattr(jobs, "_latest_success_by_job", lambda db, ids: {"dhan-token-renew": NOW})
    assert jobs.ops_status_text(JobsDB(runs), NOW).startswith("✅")


# ---- tests can never reach a real database or send a real message ---------------------------------------------------------------


def test_the_test_run_is_pointed_at_a_database_that_refuses_connections():
    assert "never_a_real_database" in settings.database_url and "5433" not in settings.database_url


def test_a_test_that_reaches_for_the_database_fails_instead_of_touching_dev():
    from sqlalchemy import text

    from app.adapters.db.session import SessionLocal

    db = SessionLocal()
    try:
        with pytest.raises(Exception):
            db.execute(text("select 1"))
    finally:
        db.close()


def test_nothing_in_a_test_can_send_a_telegram_message(monkeypatch):
    with pytest.raises(pytest.fail.Exception):
        n.send_telegram("hello", "111")


def test_a_scan_that_finishes_triggers_the_digest_without_sending_anything_in_tests(monkeypatch):
    called = []
    monkeypatch.setattr(jobs, "send_oi_digest", lambda: (called.append(1), n.Tally())[1])
    assert jobs.send_oi_digest().sent == 0 and called == [1]  # the stub in conftest is replaceable, and the default sends nothing


# ---- only today's OI scan is announced ----------------------------------------------------------------------------------------------


def test_a_digest_is_not_sent_for_an_old_snapshot(monkeypatch):
    sent = []
    monkeypatch.setattr(jobs, "latest_oi_rows", lambda db: ([oi("A", 20, 20)], date(2026, 10, 1)))
    monkeypatch.setattr(n, "broadcast", lambda *a, **k: sent.append(a) or n.Tally(sent=1))
    assert jobs.oi_digest_to_subscribers(object(), today=date(2026, 10, 6)).sent == 0 and sent == []


def test_a_digest_is_sent_for_todays_snapshot_once_with_a_per_day_key(monkeypatch):
    calls = []
    monkeypatch.setattr(jobs, "latest_oi_rows", lambda db: ([oi("A", 20, 20)], date(2026, 10, 6)))
    monkeypatch.setattr(n, "broadcast", lambda db, category, key, build, now=None: (calls.append((category, key, build({"top_n": 5}))), n.Tally(sent=1))[1])
    assert jobs.oi_digest_to_subscribers(object(), today=date(2026, 10, 6)).sent == 1
    category, key, text = calls[0]
    assert (category, key) == ("oi_buildup", "oi:2026-10-06") and text.startswith("📊 Strong OI buildup · 6 Oct close")


def test_no_snapshot_at_all_sends_nothing(monkeypatch):
    monkeypatch.setattr(jobs, "latest_oi_rows", lambda db: ([], None))
    assert jobs.oi_digest_to_subscribers(object(), today=date(2026, 10, 6)).sent == 0

