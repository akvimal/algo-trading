"""The post-session Telegram summaries: the message wording, who gets it, and that it is sent once and skipped on a holiday."""

from datetime import date
from types import SimpleNamespace
from uuid import uuid4

from app import scheduler
from app.adapters import execution_client
from app.domain import notification_jobs as jobs
from app.domain import notifications as n
from app.providers import session_market
from tests.test_notifications import FakeDB, Telegram, subs  # the same fakes the other notification tests use

DAY = date(2026, 10, 6)
ME = uuid4()
MARKET = {
    "day": DAY,
    "rows": [
        {"label": "NIFTY", "close": 24580.4, "change_pct": 0.42, "high": 24610.0, "low": 24420.0, "position": 0.84},
        {"label": "BANKNIFTY", "close": 52310.0, "change_pct": -0.15, "high": 52500.0, "low": 52100.0, "position": 0.52},
        {"label": "India VIX", "close": 13.2, "change_pct": -3.1, "high": 13.9, "low": 13.1, "position": 0.1},
    ],
}
MODE = {"trades": 3, "wins": 2, "losses": 1, "net_pnl": 1240.0, "charges": 30.0, "with_plan": 2,
        "best": {"symbol": "NIFTY", "pnl": 900.0, "r": 2.1, "exit_reason": "target"}, "worst": {"symbol": "TCS", "pnl": -300.0, "r": -1.0, "exit_reason": "stop"}}


def trader(paper=MODE, live=None, open_now=1, score=72):
    return {"segment": "NSE", "day": DAY.isoformat(), "paper": paper, "live": live, "open_now": open_now, "discipline_score": score}


def test_the_nse_message_has_the_market_the_bias_check_and_the_persons_trades():
    text = n.session_message("NSE", DAY, MARKET, trader(), bias="bullish")
    assert text.startswith("📈 Post-session · NSE · Tue 6 Oct")
    assert "NIFTY 24,580 (+0.42%) · range 24,420–24,610, closed near the high" in text
    assert "BANKNIFTY 52,310 (−0.15%)" in text and "mid-range" in text
    assert "India VIX 13.20 (−3.10%)" in text
    assert "Morning bias was Bullish: it held (NIFTY +0.42%)." in text
    assert "Paper: 3 closed · 2 won, 1 lost · net +₹1,240 after charges" in text
    assert "Best NIFTY +₹900 (+2.1R) · Worst TCS −₹300 (−1.0R)" in text
    assert "With a limit entry and a stop: 2 of 3" in text
    assert "Still open: 1 · Discipline (30 days): 72/100" in text
    assert text.rstrip().endswith("not a recommendation. Details in the app.")


def test_a_bias_that_did_not_hold_says_so_and_a_neutral_one_holds_in_a_band():
    assert "did not hold" in n.bias_check("bearish", 0.5)
    assert "it held" in n.bias_check("neutral", 0.2)
    assert "did not hold" in n.bias_check("neutral", -0.6)
    assert n.bias_check(None, 0.5) is None and n.bias_check("bullish", None) is None


def test_paper_and_live_are_reported_apart_and_never_summed():
    live = {**MODE, "trades": 1, "wins": 1, "losses": 0, "net_pnl": 500.0, "best": MODE["best"], "worst": MODE["best"]}
    text = n.session_message("NSE", DAY, MARKET, trader(live=live))
    assert "Paper: 3 closed" in text and "Live: 1 closed · 1 won · net +₹500" in text
    assert "net +₹1,740" not in text


def test_no_trades_and_unreachable_execution_are_said_differently():
    assert "You had no closed trades today." in n.session_message("NSE", DAY, MARKET, trader(paper=None, open_now=0, score=None))
    unreachable = n.session_message("NSE", DAY, MARKET, None, trader_known=False)
    assert "could not be loaded just now" in unreachable and "no closed trades" not in unreachable


def test_the_crypto_message_uses_dollars_and_has_no_bias_line():
    crypto = {"day": DAY, "rows": [{"label": "BTC", "close": 85981.5, "change_pct": 1.2, "high": 86400.0, "low": 85100.0, "position": 0.7}]}
    text = n.session_message("CRYPTO", DAY, crypto, {**trader(), "segment": "CRYPTO"}, bias="bullish")
    assert text.startswith("🪙 Daily summary · crypto") and "net +$1,240" in text and "Morning bias" not in text


def _wire(monkeypatch, *, market=MARKET, people=((ME, "111"),), trader_result=None):
    monkeypatch.setattr(session_market, "fetch_nse", lambda day=None: market)
    monkeypatch.setattr(execution_client, "trader_day", lambda user, seg, day: trader_result if trader_result is not None else trader())
    monkeypatch.setattr("app.domain.premarket_report.get_report", lambda db, day=None: SimpleNamespace(ai={"bias": "bullish"}, rules={"bias": "neutral"}))
    subs(monkeypatch, *people, category="session_nse")
    return Telegram(monkeypatch)


def test_it_is_sent_once_to_each_subscribers_own_chat_with_their_own_trades(monkeypatch):
    tg = _wire(monkeypatch)
    db = FakeDB()
    first = jobs.session_to_subscribers(db, "NSE", DAY)
    again = jobs.session_to_subscribers(db, "NSE", DAY)
    assert (first.sent, again.sent, again.skipped) == (1, 0, 1)
    assert [c for c, _ in tg.sent] == ["111"] and "Morning bias was Bullish" in tg.sent[0][1]


def test_a_holiday_sends_nothing(monkeypatch):
    tg = _wire(monkeypatch, market=None)
    out = jobs.session_to_subscribers(FakeDB(), "NSE", DAY)
    assert tg.sent == [] and (out.sent, out.failed) == (0, 0)


def test_execution_being_down_still_sends_the_market_and_says_the_trades_are_missing(monkeypatch):
    tg = _wire(monkeypatch)
    monkeypatch.setattr(execution_client, "trader_day", lambda user, seg, day: None)
    jobs.session_to_subscribers(FakeDB(), "NSE", DAY)
    assert "NIFTY 24,580" in tg.sent[0][1] and "could not be loaded just now" in tg.sent[0][1]


def test_the_two_summaries_are_separate_categories_and_start_off():
    assert {"session_nse", "session_crypto"} <= set(n.CATEGORIES)
    assert not n.CATEGORIES["session_nse"].admin_only and not n.CATEGORIES["session_crypto"].admin_only


def test_the_schedules_are_3_50_pm_on_weekdays_and_11_30_pm_daily_in_ist():
    import inspect
    import re

    from app.config import settings

    assert (settings.session_summary_nse_hour, settings.session_summary_nse_minute) == (15, 50)
    assert (settings.session_summary_crypto_hour, settings.session_summary_crypto_minute) == (23, 30)
    source = inspect.getsource(scheduler.start_scheduler)

    def trigger(job):
        return re.search(job + r",\s*CronTrigger\((.*?)\),\s*id=", source, re.S).group(1)

    nse, crypto = trigger("_send_session_summary_nse"), trigger("_send_session_summary_crypto")
    assert 'day_of_week="mon-fri"' in nse and "timezone=settings.timezone" in nse
    assert "day_of_week" not in crypto and "timezone=settings.timezone" in crypto  # crypto trades every day
