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
def item(symbol, pnl, verdict, issues=(), r=None, side="long", entry=100.0, exit=105.0, held=45, label=None):
    return {"symbol": symbol, "label": label, "side": side, "pnl": pnl, "r": r, "entry": entry, "exit": exit, "held_minutes": held, "exit_reason": "target",
            "followed": verdict in ("good_win", "good_loss"), "verdict": verdict, "issues": list(issues)}


ITEMS = [item("NIFTY", 900.0, "good_win", r=2.1, held=95), item("TCS", -300.0, "good_loss", r=-1.0, side="short"), item("INFY", 640.0, "lucky_win", ["no stop", "market entry"])]
MODE = {"trades": 3, "wins": 2, "losses": 1, "net_pnl": 1240.0, "charges": 30.0, "with_plan": 2, "best": ITEMS[0], "worst": ITEMS[1],
        "followed_count": 2, "followed_pnl": 600.0, "broke_count": 1, "broke_pnl": 640.0, "items": ITEMS, "more": 0}
STATS = {"days": 30, "trades": 34, "win_rate_pct": 58.8, "profit_factor": 1.7, "avg_win": 910.0, "avg_loss": -520.0, "expectancy": 181.0, "avg_r": 0.4, "net_pnl": 6150.0, "max_consecutive_losses": 3}
ACCOUNT = {"balance": 104350.0, "starting_balance": 100000.0, "day_change": 1240.0, "day_change_pct": 1.2, "since_start_pct": 4.35, "month_pnl": 3100.0, "curve": [100000, 101110, 104350], "max_drawdown_pct": 1.8}


def trader(paper=MODE, live=None, open_now=1, score=72, account=ACCOUNT, stats=STATS):
    return {"segment": "NSE", "day": DAY.isoformat(), "paper": paper, "live": live, "account": account, "stats": {"paper": stats, "live": None}, "open_now": open_now, "discipline_score": score}


def test_the_message_leads_with_your_account_and_trades_then_the_market():
    text = n.session_message("NSE", DAY, MARKET, trader(), bias="bullish")
    assert text.startswith("📈 Your trading day · NSE · Tue 6 Oct")
    assert text.index("Paper account:") < text.index("Paper: 3 closed") < text.index("Last 30 days") < text.index("Market:")
    assert "Paper account: +₹1,240 (+1.20%) today · balance ₹104,350 · +4.35% since the start · +₹3,100 this month" in text
    assert "Paper: 3 closed · 2 won, 1 lost · net +₹1,240 after charges" in text
    assert "Still open: 1 · Discipline (30 days): 72/100" in text
    assert text.rstrip().endswith("not a recommendation. Details in the app.")


def test_each_trade_is_judged_by_the_plan_with_its_levels_and_why():
    text = n.session_message("NSE", DAY, MARKET, trader())
    assert "✅ NIFTY long  +₹900 (+2.1R)" in text and "Good trade · followed the plan · 100.00 → 105.00 · 1h35m" in text
    assert "✅ TCS short  −₹300 (−1.0R)" in text and "Good loss · stayed within the plan" in text
    assert "⚠️ INFY long  +₹640" in text and "Won, but off the plan (luck) · no stop, market entry" in text


def test_the_plan_insight_says_what_following_or_breaking_it_was_worth():
    assert n.plan_insight(MODE, "NSE") == "On-plan +₹600 · off-plan +₹640. Off-plan gains are luck."
    costly = {**MODE, "broke_count": 1, "broke_pnl": -260.0}
    assert "Breaking the plan cost ₹260" in n.plan_insight(costly, "NSE")
    assert n.plan_insight({**MODE, "broke_count": 0, "broke_pnl": 0.0}, "NSE") == "Every trade followed the plan."
    assert n.plan_insight({**MODE, "followed_count": 0, "followed_pnl": 0.0, "broke_count": 3}, "NSE") == "No trade followed the plan today."
    assert n.plan_insight({**MODE, "trades": 0}, "NSE") is None


def test_the_thirty_day_line_has_win_rate_profit_factor_averages_and_expectancy():
    text = n.session_message("NSE", DAY, MARKET, trader())
    assert "Last 30 days (34 trades): win rate 59% · profit factor 1.7 · avg win ₹910 / avg loss ₹520 · expectancy +₹181 a trade" in text


def test_the_market_is_one_line_at_the_end_with_the_bias_check():
    text = n.session_message("NSE", DAY, MARKET, trader(), bias="bullish")
    assert "Market: NIFTY +0.42% · BANKNIFTY −0.15% · India VIX −3.10% · bias held" in text
    assert "did not hold" in n.bias_check("bearish", 0.5) and "it held" in n.bias_check("neutral", 0.2)
    assert n.bias_check(None, 0.5) is None and n.bias_check("bullish", None) is None


def test_paper_and_live_are_reported_apart_and_never_summed():
    live = {**MODE, "trades": 1, "wins": 1, "losses": 0, "net_pnl": 500.0, "items": [ITEMS[0]], "followed_count": 1, "followed_pnl": 900.0, "broke_count": 0, "broke_pnl": 0.0}
    text = n.session_message("NSE", DAY, MARKET, trader(live=live))
    assert "Paper: 3 closed" in text and "Live: 1 closed · 1 won · net +₹500" in text and "net +₹1,740" not in text


def test_no_trades_and_unreachable_execution_are_said_differently():
    assert "You had no closed trades today." in n.session_message("NSE", DAY, MARKET, trader(paper=None, open_now=0, score=None))
    unreachable = n.session_message("NSE", DAY, MARKET, None, trader_known=False)
    assert "could not be loaded just now" in unreachable and "no closed trades" not in unreachable


def test_a_long_day_says_how_many_trades_were_left_off():
    assert "…and 4 more in the app" in n.session_message("NSE", DAY, MARKET, trader(paper={**MODE, "more": 4}))


def test_the_crypto_message_uses_dollars_and_has_no_bias_line():
    crypto = {"day": DAY, "rows": [{"label": "BTC", "close": 85981.5, "change_pct": 1.2, "high": 86400.0, "low": 85100.0, "position": 0.7}]}
    text = n.session_message("CRYPTO", DAY, crypto, {**trader(), "segment": "CRYPTO"}, bias="bullish")
    assert text.startswith("🪙 Your trading day · crypto") and "net +$1,240" in text and "bias held" not in text


def _wire(monkeypatch, *, market=MARKET, people=((ME, "111"),), trader_result=None):
    monkeypatch.setattr(session_market, "fetch_nse", lambda day=None: market)
    monkeypatch.setattr(execution_client, "trader_day", lambda user, seg, day: trader_result if trader_result is not None else trader())
    monkeypatch.setattr("app.domain.premarket_report.get_report", lambda db, day=None: SimpleNamespace(ai={"bias": "bullish"}, rules={"bias": "neutral"}))
    subs(monkeypatch, *people, category="session_nse")
    monkeypatch.setattr(jobs, "session_card_for", lambda *a, **k: (None, None))  # these tests are about the text message; the card has its own tests
    return Telegram(monkeypatch)


def test_it_is_sent_once_to_each_subscribers_own_chat_with_their_own_trades(monkeypatch):
    tg = _wire(monkeypatch)
    db = FakeDB()
    first = jobs.session_to_subscribers(db, "NSE", DAY)
    again = jobs.session_to_subscribers(db, "NSE", DAY)
    assert (first.sent, again.sent, again.skipped) == (1, 0, 1)
    assert [c for c, _ in tg.sent] == ["111"] and "bias held" in tg.sent[0][1]


def test_a_holiday_sends_nothing(monkeypatch):
    tg = _wire(monkeypatch, market=None)
    out = jobs.session_to_subscribers(FakeDB(), "NSE", DAY)
    assert tg.sent == [] and (out.sent, out.failed) == (0, 0)


def test_execution_being_down_still_sends_the_market_and_says_the_trades_are_missing(monkeypatch):
    tg = _wire(monkeypatch)
    monkeypatch.setattr(execution_client, "trader_day", lambda user, seg, day: None)
    jobs.session_to_subscribers(FakeDB(), "NSE", DAY)
    assert "NIFTY +0.42%" in tg.sent[0][1] and "could not be loaded just now" in tg.sent[0][1]


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


def test_the_mcx_session_is_built_from_hourly_bars_with_text_timestamps(monkeypatch):
    """The provider returns timestamps as ISO text; the day's change is against the previous session's last close."""
    def bar(ts, o, h, l, c):
        return SimpleNamespace(timestamp=ts, open=o, high=h, low=l, close=c)

    bars = [
        bar("2026-10-05T10:00:00+05:30", 100, 101, 99, 100), bar("2026-10-05T23:00:00+05:30", 100, 103, 100, 102),
        bar("2026-10-06T09:00:00+05:30", 102, 104, 101, 103), bar("2026-10-06T23:00:00+05:30", 103, 106, 102, 105),
    ]
    provider = SimpleNamespace(resolve_underlying=lambda name: SimpleNamespace(chart_symbol=name + "-FUT"), get_candle_history=lambda *a, **k: bars)
    monkeypatch.setattr("app.providers.router.get_provider", lambda ex: provider)
    row, day = session_market._mcx_session("GOLDM", DAY)
    assert day == DAY and row["close"] == 105 and row["high"] == 106 and row["low"] == 101
    assert row["change_pct"] == round((105 / 102 - 1) * 100, 2)
    assert session_market._mcx_session("GOLDM", date(2026, 10, 7))[0] is None  # no bar that day: a holiday


# ---- the picture card ----------------------------------------------------------------------------------------------------------


def _png_size(data: bytes):
    import io

    from PIL import Image

    img = Image.open(io.BytesIO(data))
    img.load()
    return img.format, img.size


def test_the_card_renders_a_real_png_for_every_shape_of_day():
    from app.domain.session_card import render_session_card

    for tr, known in ((trader(), True), (trader(paper=None, open_now=0, score=None), True), (None, False)):
        fmt, (w, h) = _png_size(render_session_card("NSE", DAY, MARKET, tr, ("bullish", True), trader_known=known))
        assert fmt == "PNG" and w == 1080 and h > 400
    crypto = {"day": DAY, "rows": [{"label": "BTC", "close": 85981.5, "change_pct": -1.2, "high": 86400.0, "low": 85100.0, "position": 0.2}]}
    assert _png_size(render_session_card("CRYPTO", DAY, crypto, trader()))[0] == "PNG"


def test_a_card_with_more_trades_is_taller_and_still_draws_without_the_dejavu_font(monkeypatch):
    from app.domain import session_card as sc

    both = _png_size(sc.render_session_card("NSE", DAY, MARKET, trader(live={**MODE, "trades": 1}))) [1][1]
    one = _png_size(sc.render_session_card("NSE", DAY, MARKET, trader()))[1][1]
    assert both > one
    monkeypatch.setattr(sc, "_font_path", lambda bold: None)
    sc._cache.clear()
    try:
        assert _png_size(sc.render_session_card("NSE", DAY, MARKET, trader()))[0] == "PNG"
        assert sc.rupee() == "Rs " and sc.minus() == "-"
    finally:
        sc._cache.clear()


def test_the_caption_is_short_and_carries_the_headline():
    cap = n.session_caption("NSE", DAY, MARKET, trader(live={**MODE, "net_pnl": -450.0}), bias="bullish")
    assert cap.startswith("📈 Your trading day · NSE · Tue 6 Oct\n")
    assert "Paper +₹1,240 · 3 trades · plan followed 2/3" in cap and "Live −₹450" in cap and "NIFTY +0.42%" in cap and "bias held" in cap and len(cap) < 400
    assert cap.index("Paper") < cap.index("NIFTY")  # your result comes before the index


def test_a_summary_goes_as_a_photo_with_its_caption_and_the_text_is_the_fallback(monkeypatch):
    sent = {"photo": [], "text": []}
    fail_photo = {"on": False}

    def photo(png, caption, chat):
        if fail_photo["on"]:
            return "Telegram rejected the picture"
        sent["photo"].append((chat, caption, png[:4]))
        return None

    monkeypatch.setattr(n, "send_telegram_photo", photo)
    monkeypatch.setattr(n, "send_telegram", lambda text, chat: sent["text"].append((chat, text)))
    db = FakeDB()
    assert n.deliver(db, ME, "111", "session_nse", "k1", "FULL TEXT", image=b"\x89PNG-bytes", caption="short caption") == "sent"
    assert sent["photo"] == [("111", "short caption", b"\x89PNG")] and sent["text"] == []
    fail_photo["on"] = True
    assert n.deliver(db, ME, "111", "session_nse", "k2", "FULL TEXT", image=b"\x89PNG-bytes", caption="short caption") == "sent"
    assert sent["text"] == [("111", "FULL TEXT")]  # the picture failed, so the person still got the message
    assert n.deliver(db, ME, "111", "session_nse", "k3", "PLAIN") == "sent" and sent["text"][-1] == ("111", "PLAIN")


def test_the_job_sends_the_card_and_still_sends_text_if_it_cannot_be_drawn(monkeypatch):
    photos, texts = [], []
    monkeypatch.setattr(n, "send_telegram_photo", lambda png, cap, chat: photos.append((chat, cap)))
    monkeypatch.setattr(n, "send_telegram", lambda text, chat: texts.append((chat, text)))
    monkeypatch.setattr(session_market, "fetch_nse", lambda day=None: MARKET)
    monkeypatch.setattr(execution_client, "trader_day", lambda user, seg, day: trader())
    monkeypatch.setattr("app.domain.premarket_report.get_report", lambda db, day=None: None)
    subs(monkeypatch, (ME, "111"), category="session_nse")
    jobs.session_to_subscribers(FakeDB(), "NSE", DAY)
    assert len(photos) == 1 and texts == []
    monkeypatch.setattr("app.domain.session_card.render_session_card", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no pillow")))
    jobs.session_to_subscribers(FakeDB(), "NSE", DAY)
    assert len(photos) == 1 and len(texts) == 1 and "Your trading day · NSE" in texts[0][1]


# ---- the pre-market card and its clearer text ----------------------------------------------------------------------------------


PM_REPORT = {
    "inputs": [
        {"key": "gift_nifty", "label": "GIFT Nifty vs last close", "group": "india", "value": 22713.5, "change": 0.699, "unit": "pct", "ok": True},
        {"key": "nifty_close", "label": "Nifty last close", "group": "india", "value": 22555.75, "change": None, "unit": "pct", "ok": True},
        {"key": "sp500", "label": "S&P 500", "group": "us", "value": 7773.9, "change": 0.663, "unit": "pct", "ok": True},
        {"key": "us10y", "label": "US 10Y yield", "group": "yield", "value": 5.311, "change": 3.4, "unit": "bp", "ok": True},
    ],
    "rules": {"bias": "bullish", "score": 0.29, "factors": [
        {"key": "gift_gap", "move": 0.699, "label": "GIFT Nifty gap", "score": 1.0, "weight": 3.0},
        {"key": "us_close", "move": 0.631, "label": "US close", "score": 0.631, "weight": 2.0},
        {"key": "adr", "move": -0.722, "label": "Indian ADRs", "score": -0.481, "weight": 1.5},
        {"key": "us10y", "move": 3.4, "label": "US 10Y yield", "score": -0.425, "weight": 0.5},
        {"key": "in10y", "move": None, "label": "India 10Y yield", "score": None, "weight": 0.5}]},
    "ai": {"bias": "bullish", "confidence": 72, "one_liner": "A positive open is likely.", "watch": "Watch 22555-22713.", "risks": ["A reversal in risk appetite."], "model": "m"},
}


def test_the_premarket_text_says_what_is_lifting_and_what_is_weighing_on_the_market():
    text = n.premarket_message(PM_REPORT, DAY)
    assert "🟢 Lifting: GIFT Nifty gap +0.70% · US close +0.63%" in text
    assert "🔴 Weighing: Indian ADRs −0.72% · US 10Y yield +3.40 bp" in text
    assert text.index("Lifting") < text.index("GIFT Nifty +0.70% vs last close")  # the why comes before the raw numbers


def test_the_premarket_caption_has_the_call_and_the_gap():
    cap = n.premarket_caption(PM_REPORT, DAY)
    assert cap == "☀️ Pre-market · Tue 6 Oct\n🟢 Bullish (72% sure) · GIFT Nifty +0.70%"
    assert n.premarket_caption({**PM_REPORT, "ai": None, "rules": {**PM_REPORT["rules"], "bias": "neutral"}}, DAY).splitlines()[1].startswith("🟡 Neutral")


def test_the_premarket_card_renders_with_and_without_the_ai_and_with_missing_inputs():
    from app.domain.premarket_card import render_premarket_card

    assert _png_size(render_premarket_card(PM_REPORT, DAY))[0] == "PNG"
    no_ai = {**PM_REPORT, "ai": None}
    fmt, (w, h) = _png_size(render_premarket_card(no_ai, DAY))
    assert fmt == "PNG" and w == 1080
    bare = {"inputs": [], "rules": {"bias": "neutral", "score": 0.0, "factors": []}, "ai": None}
    assert _png_size(render_premarket_card(bare, DAY))[0] == "PNG"  # nothing could be fetched: still a card, never an error


def test_the_premarket_push_is_one_picture_for_everyone_and_falls_back_to_text(monkeypatch):
    photos, texts = [], []
    monkeypatch.setattr(n, "send_telegram_photo", lambda png, cap, chat: photos.append((chat, cap)))
    monkeypatch.setattr(n, "send_telegram", lambda text, chat: texts.append((chat, text)))
    other = uuid4()
    subs(monkeypatch, (ME, "111"), (other, "222"), category="premarket")
    jobs.premarket_to_subscribers(FakeDB(), PM_REPORT, DAY)
    assert [c for c, _ in photos] == ["111", "222"] and texts == []
    monkeypatch.setattr("app.domain.premarket_card.render_premarket_card", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no pillow")))
    jobs.premarket_to_subscribers(FakeDB(), PM_REPORT, DAY)
    assert len(photos) == 2 and [c for c, _ in texts] == ["111", "222"]


# ---- the strong OI buildup card ------------------------------------------------------------------------------------------------


def oi_row(symbol, call, put, price=1.0, buildup=("long_buildup", "long_buildup")):
    return {"symbol": symbol, "call_oi_change_pct": call, "put_oi_change_pct": put, "price_change_pct": price, "call_buildup": buildup[0], "put_buildup": buildup[1]}


OI_ROWS = [oi_row("RELIANCE", 42, 35, 1.8), oi_row("TCS", 25, 31, 0.6), oi_row("INFY", 18, 22, -0.4, ("short_buildup", "short_buildup")),
           oi_row("SBIN", 12, 14, -1.1, ("short_buildup", "short_buildup")), oi_row("ITC", 3, 4, 0.2)]


def test_the_oi_card_renders_for_a_busy_day_a_one_sided_day_and_a_day_with_nothing():
    from app.domain.oi_card import render_oi_card

    fmt, (w, h) = _png_size(render_oi_card(OI_ROWS, DAY, 10))
    assert fmt == "PNG" and w == 1080 and h > 900
    one_sided = [r for r in OI_ROWS if r["call_buildup"] == "long_buildup"]
    assert _png_size(render_oi_card(one_sided, DAY, 10))[0] == "PNG"
    assert _png_size(render_oi_card([oi_row("ITC", 3, 4)], DAY, 10))[0] == "PNG"  # nothing qualified: still a card, never an error


def test_the_oi_card_is_taller_with_a_longer_list_and_respects_the_top_n():
    from app.domain.oi_card import render_oi_card

    many = [oi_row(f"S{i}", 20 + i, 25 + i) for i in range(12)]
    assert _png_size(render_oi_card(many, DAY, 3))[1][1] < _png_size(render_oi_card(many, DAY, 10))[1][1]


def test_the_oi_caption_names_the_leaders_on_each_side():
    cap = n.oi_caption(OI_ROWS, DAY, 10)
    assert cap == "📊 Strong OI buildup · 6 Oct close\n🟢 2 bullish (RELIANCE, TCS) · 🔴 2 bearish (INFY, SBIN)"
    assert "0 bullish · 🔴 0 bearish" in n.oi_caption([oi_row("ITC", 3, 4)], DAY, 10)


def test_the_digest_goes_as_a_picture_sized_to_each_persons_top_n_and_falls_back_to_text(monkeypatch):
    photos, texts, drawn = [], [], []
    monkeypatch.setattr(n, "send_telegram_photo", lambda png, cap, chat: photos.append((chat, cap)))
    monkeypatch.setattr(n, "send_telegram", lambda text, chat: texts.append((chat, text)))
    monkeypatch.setattr(jobs, "latest_oi_rows", lambda db: (OI_ROWS, DAY))
    real = jobs.oi_card_for
    monkeypatch.setattr(jobs, "oi_card_for", lambda rows, day, top_n: (drawn.append(top_n), real(rows, day, top_n))[1])
    other = uuid4()
    rows = [SimpleNamespace(user_id=ME, params={"top_n": 5}), SimpleNamespace(user_id=other, params={"top_n": 5})]
    monkeypatch.setattr(n, "_enabled_subscriptions", lambda db, c: rows if c == "oi_buildup" else [])
    monkeypatch.setattr(n, "_chats_for", lambda db, ids: {ME: "111", other: "222"})
    jobs.oi_digest_to_subscribers(FakeDB(), today=DAY)
    assert [c for c, _ in photos] == ["111", "222"] and texts == [] and drawn == [5]  # drawn once for two people with the same setting
    monkeypatch.setattr("app.domain.oi_card.render_oi_card", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no pillow")))
    monkeypatch.setattr(jobs, "oi_card_for", real)
    jobs.oi_digest_to_subscribers(FakeDB(), today=DAY)
    assert len(photos) == 2 and [c for c, _ in texts] == ["111", "222"] and "Strong OI buildup" in texts[0][1]


def test_both_tally_tiles_are_drawn_and_an_outlier_does_not_squash_the_other_bars():
    """The bullish tile used to be painted over by the bearish one's panel; and one stock whose OI tripled shrank every other bar to a sliver."""
    import io

    from PIL import Image

    from app.domain.oi_card import BAR_CAP, render_oi_card

    outlier = [oi_row("ENRIN", 349, 296, 4.1), oi_row("TCS", 40, 35, 0.6)]
    img = Image.open(io.BytesIO(render_oi_card(outlier, DAY, 10))).convert("RGB")
    # The bullish count is drawn in bright green in the left tile (x 40-530, y 200-270); the bug painted that tile over, leaving none.
    green = sum(1 for x in range(60, 300) for y in range(200, 270) if img.getpixel((x, y)) == (61, 220, 151))
    assert green > 100, "the bullish tile looks empty"
    assert BAR_CAP < 349
