"""Telegram notifications a person subscribes to: the pre-market bias, the strong OI buildup digest, and (for the operator) token and job
problems. Each goes to the subscriber's OWN chat (market_data.alert_channels), the same one their price alerts use.

How it stays well behaved:
  * Nothing is sent unless the person turned that category on AND has a chat set (every category starts off).
  * Each message is recorded in market_data.notification_log under (user, category, dedupe key), so the same item is sent once: the
    pre-market message once per day, the OI digest once per trading day, an operator alert once per distinct problem. A re-run, a
    manual refresh or a restart never repeats it.
  * A send that fails is kept and retried every few minutes (a limited number of times, and only the same day), and the failure and
    its reason show in the person's delivery history; a message is never lost silently and never retried forever.
  * One digest message per category per day (the top ten in a single message), not one message per item.
  * The messages are market context, not recommendations, and say so.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.adapters.db.models import AlertChannel, NotificationLog, NotificationSubscription
from app.domain import oi_quadrants as oiq
from app.domain.notify import send_telegram, send_telegram_photo

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 5
RETRY_WINDOW = timedelta(hours=18)  # a pre-market message is stale by the afternoon; the OI digest is gone by the next morning
MINUS = "−"


@dataclass(frozen=True)
class Category:
    key: str
    label: str
    description: str
    schedule: str
    admin_only: bool = False
    defaults: dict = field(default_factory=dict)


CATEGORIES: dict[str, Category] = {
    c.key: c
    for c in (
        Category("premarket", "Pre-market bias", "The morning read on the overnight US close, crude, USD/INR, yields, ADRs and the GIFT Nifty gap, with the AI's call.", "Weekdays at 8:45 AM IST, 30 minutes before NSE opens"),
        Category("oi_buildup", "OI buildup", "How F&O stocks moved against their open interest that day, in four boxes: long buildup and short covering (bullish), short buildup and long unwinding (bearish), the biggest OI change first.", "Weekdays after the end-of-day OI scan finishes (about 4:05 PM IST)", defaults={"top_n": 5}),
        Category("session_nse", "Post-session summary: NSE", "How the NSE session went (NIFTY, BANKNIFTY, VIX, and whether the morning bias held) and your own closed trades that day, paper and live apart.", "Weekdays at 3:50 PM IST, after the 3:30 PM close; skipped on a market holiday"),
        Category("session_mcx", "Post-session summary: MCX", "How gold, crude, silver and natural gas (the mini contracts) did in the MCX session, and your own closed MCX trades that day, paper and live apart.", "Weekdays at 11:58 PM IST, after the late-evening close; skipped on an MCX holiday"),
        Category("session_crypto", "Post-session summary: crypto", "The last 24 hours in BTC and ETH and your own crypto trades that day, paper and live apart. Crypto never closes, so this goes out at a fixed time.", "Every day at 11:30 PM IST"),
        Category("ops", "Operator alerts", "The Dhan token expiring or expired, and background jobs that failed.", "Checked every 10 minutes", admin_only=True),
    )
}

TOP_N_MIN, TOP_N_MAX = 3, 10  # per box: four boxes of ten would be a very long message


class NotificationError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


def clean_params(category: str, params: Optional[dict]) -> dict:
    """The settings a person may change for a category, checked and defaulted."""
    cat = CATEGORIES[category]
    out = dict(cat.defaults)
    if category == "oi_buildup" and params and "top_n" in params:
        n = params["top_n"]
        if isinstance(n, bool) or not isinstance(n, int) or not TOP_N_MIN <= n <= TOP_N_MAX:
            raise NotificationError(422, f"top_n must be a whole number from {TOP_N_MIN} to {TOP_N_MAX}.")
        out["top_n"] = n
    return out


# ---- who is subscribed ------------------------------------------------------------------------------------------------------


@dataclass
class Subscriber:
    user_id: UUID
    params: dict
    chat_id: str


def _enabled_subscriptions(db: Session, category: str) -> list[NotificationSubscription]:
    return db.query(NotificationSubscription).filter(NotificationSubscription.category == category, NotificationSubscription.enabled.is_(True)).all()


def _chats_for(db: Session, user_ids) -> dict[UUID, str]:
    ids = list(user_ids)
    return {c.user_id: c.telegram_chat_id for c in db.query(AlertChannel).filter(AlertChannel.user_id.in_(ids)).all()} if ids else {}


def _pending_rows(db: Session, now: datetime) -> list[NotificationLog]:
    """Messages whose send failed, still fresh and not out of attempts."""
    return db.query(NotificationLog).filter(NotificationLog.sent_at.is_(None), NotificationLog.attempts < MAX_ATTEMPTS, NotificationLog.created_at >= now - RETRY_WINDOW).all()


def subscribers(db: Session, category: str) -> list[Subscriber]:
    """People with this category switched on and a chat to send to."""
    subs = _enabled_subscriptions(db, category)
    if not subs:
        return []
    chats = _chats_for(db, [s.user_id for s in subs])
    return [Subscriber(s.user_id, {**CATEGORIES[category].defaults, **(s.params or {})}, chats[s.user_id]) for s in subs if s.user_id in chats]


# ---- delivery, recorded and retried ---------------------------------------------------------------------------------------------


@dataclass
class Tally:
    sent: int = 0
    failed: int = 0
    skipped: int = 0  # already sent, or given up on


def _attempt(db: Session, row: NotificationLog, chat_id: str, now: datetime, image: Optional[bytes] = None, caption: Optional[str] = None) -> bool:
    """One send. With a picture it goes as a photo with its short caption; if that fails the full text is sent instead, so the person still
    gets the message. A retry later has no picture (it is not stored) and sends the text."""
    error = send_telegram_photo(image, caption or row.text, chat_id) if image else "no picture"
    if error:
        error = send_telegram(row.text, chat_id)
    row.attempts = (row.attempts or 0) + 1
    row.last_attempt_at = now
    if error:
        row.last_error = error
        return False
    row.sent_at, row.last_error = now, None
    return True


def deliver(db: Session, user_id: UUID, chat_id: str, category: str, key: str, text: str, now: Optional[datetime] = None, image: Optional[bytes] = None, caption: Optional[str] = None) -> str:
    """Send one message once (as a picture with a caption when `image` is given, with the full text as the fallback). Returns "sent", "failed" (kept for a retry) or "skipped" (already sent, or given up on)."""
    now = now or datetime.now(timezone.utc)
    row = db.get(NotificationLog, (user_id, category, key))
    if row is None:
        row = NotificationLog(user_id=user_id, category=category, dedupe_key=key, text=text, created_at=now, attempts=0)
        db.add(row)
    elif row.sent_at is not None or (row.attempts or 0) >= MAX_ATTEMPTS:
        return "skipped"
    ok = _attempt(db, row, chat_id, now, image, caption)
    db.commit()
    return "sent" if ok else "failed"


def broadcast(
    db: Session, category: str, key: str, build: Callable[[dict], Optional[str]], now: Optional[datetime] = None, image: Optional[bytes] = None, caption: Optional[str] = None,
    card: Optional[Callable[[dict], tuple[Optional[bytes], Optional[str]]]] = None,
) -> Tally:
    """Send a category's message to every subscriber, once each. `build(params)` returns the text for that person's settings, or None
    when there is nothing worth sending them."""
    tally = Tally()
    for sub in subscribers(db, category):
        text = build(sub.params)
        if not text:
            tally.skipped += 1
            continue
        pic, cap = card(sub.params) if card is not None else (image, caption)  # `card` for a message whose picture depends on the person's settings
        outcome = deliver(db, sub.user_id, sub.chat_id, category, key, text, now, image=pic, caption=cap)
        setattr(tally, outcome, getattr(tally, outcome) + 1)
    return tally


def retry_pending(db: Session, now: Optional[datetime] = None) -> Tally:
    """Re-send messages whose first attempt failed, while they are still fresh and not out of attempts."""
    now = now or datetime.now(timezone.utc)
    tally = Tally()
    rows = _pending_rows(db, now)
    if not rows:
        return tally
    chats = _chats_for(db, {r.user_id for r in rows})
    for row in rows:
        chat = chats.get(row.user_id)
        if not chat:
            tally.skipped += 1  # they removed their chat: nothing to send to, and it is not counted against the message
            continue
        ok = _attempt(db, row, chat, now)
        tally.sent += ok
        tally.failed += not ok
    db.commit()
    return tally


# ---- message text (pure) -------------------------------------------------------------------------------------------------------


def shorten(text: str, limit: int) -> str:
    """At most `limit` characters, cut at the last sentence end that fits (else at a word, with an ellipsis). Some models write a whole
    paragraph where one line was asked for; a Telegram message should stay a glance."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
    if end > limit * 0.5:
        return cut[: end + 1]
    return cut[: cut.rfind(" ")].rstrip(" ,;:-") + "…"


ONE_LINER_MAX = 280
WATCH_MAX = 220


def _signed(v: Optional[float], digits: int = 2, suffix: str = "%") -> str:
    if v is None:
        return "–"
    body = f"{abs(v):.{digits}f}{suffix}"
    return f"{'+' if v > 0 else MINUS if v < 0 else ''}{body}"


def _input(inputs: list[dict], key: str) -> Optional[dict]:
    return next((i for i in inputs if i["key"] == key and i["ok"]), None)


def _move(inputs: list[dict], key: str, label: str) -> Optional[str]:
    i = _input(inputs, key)
    if i is None or i.get("change") is None:
        return None
    return f"{label} {_signed(i['change'], 1, ' bp')}" if i.get("unit") == "bp" else f"{label} {_signed(i['change'])}"


def _drivers_lines(rules: dict) -> list[str]:
    """What is lifting the market and what is weighing on it, from the fixed rules' own factors, strongest first: the quickest way to read
    WHY the bias is what it is."""
    factors = [f for f in rules.get("factors", []) if f.get("score") is not None and f.get("move") is not None]

    def show(f):
        unit = " bp" if f["key"] in ("us10y", "in10y") else "%"
        return f"{f['label']} {'+' if f['move'] > 0 else MINUS if f['move'] < 0 else ''}{abs(f['move']):.2f}{unit}"

    up = sorted((f for f in factors if f["score"] >= 0.1), key=lambda f: -f["score"] * f["weight"])[:3]
    down = sorted((f for f in factors if f["score"] <= -0.1), key=lambda f: f["score"] * f["weight"])[:3]
    out = []
    if up:
        out.append("🟢 Lifting: " + " · ".join(show(f) for f in up))
    if down:
        out.append("🔴 Weighing: " + " · ".join(show(f) for f in down))
    return out


def premarket_caption(report: dict, day: date) -> str:
    """The short line that goes with the pre-market picture."""
    rules, ai = report["rules"], report.get("ai")
    bias = (ai["bias"] if ai else rules["bias"]).capitalize()
    gift = _input(report["inputs"], "gift_nifty")
    gap = f" · GIFT Nifty {_signed(gift['change'])}" if gift is not None and gift.get("change") is not None else ""
    conf = f" ({ai['confidence']}% sure)" if ai and ai.get("confidence") else ""
    dot = {"Bullish": "🟢", "Bearish": "🔴"}.get(bias, "🟡")
    return f"☀️ Pre-market · {day.strftime('%a')} {day.day} {day.strftime('%b')}\n{dot} {bias}{conf}{gap}"


def premarket_message(report: dict, day: date) -> str:
    """The morning read as one compact message. `report` is the stored report's inputs / rules / ai (as built by premarket_report)."""
    inputs, rules, ai = report["inputs"], report["rules"], report.get("ai")
    bias = (ai["bias"] if ai else rules["bias"]).capitalize()
    if ai:
        calls = f"AI {ai['confidence']}% confident" if ai.get("confidence") else "AI"
        agree = f" · fixed rules: {rules['bias']}" if ai["bias"] != rules["bias"] else ""
        head = f"Bias: {bias} ({calls}){agree}"
    else:
        head = f"Bias: {bias} (fixed rules only)"
    lines = [f"☀️ Pre-market · {day.strftime('%a')} {day.day} {day.strftime('%b')}", head]
    if ai and ai.get("one_liner"):
        lines += ["", shorten(ai["one_liner"], ONE_LINER_MAX)]
    drivers = _drivers_lines(rules)
    if drivers:
        lines += [""] + drivers
    gift = _input(inputs, "gift_nifty")
    block = []
    if gift is not None and gift.get("change") is not None:
        block.append(f"GIFT Nifty {_signed(gift['change'])} vs last close ({gift['value']:,.0f})")
    us = [m for m in (_move(inputs, "sp500", "S&P"), _move(inputs, "dow", "Dow"), _move(inputs, "nasdaq", "Nasdaq")) if m]
    if us:
        block.append("US: " + " · ".join(us))
    macro = [m for m in (_move(inputs, "brent", "Brent"), _move(inputs, "usdinr", "USD/INR"), _move(inputs, "us10y", "US 10Y"), _move(inputs, "in10y", "India 10Y")) if m]
    if macro:
        block.append(" · ".join(macro))
    adrs = [m for m in (_move(inputs, k, label) for k, label in (("adr_infy", "INFY"), ("adr_hdb", "HDB"), ("adr_wit", "WIT"), ("adr_ibn", "IBN"), ("adr_rdy", "RDY"))) if m]
    if adrs:
        block.append("ADRs: " + " · ".join(adrs))
    if block:
        lines += [""] + block
    if ai and ai.get("watch"):
        lines += ["", f"Watch at the open: {shorten(ai['watch'], WATCH_MAX)}"]
    lines += ["", "Market context from public data, not a recommendation. Details in the app."]
    return "\n".join(lines)


def _oi_line(i: int, r: dict) -> str:
    star = " ★" if r.get("strong") else ""
    return f"{i}. {r['symbol']}{star}  OI {_signed(r['oi_change_pct'], 1)} · price {_signed(r['price_change_pct'])}"


def oi_digest_message(rows: list[dict], snapshot_date: date, top_n: int) -> Optional[str]:
    """The end-of-day OI digest: how price moved against open interest, in four boxes (long buildup and short covering are the bullish
    pair, short buildup and long unwinding the bearish pair), the biggest OI changes first. None when no stock cleared the noise floors
    (no message rather than an empty one)."""
    groups = oiq.by_quadrant(rows, top_n)
    if not any(g["total"] for g in groups.values()):
        return None
    lines = [
        f"📊 OI buildup · {snapshot_date.day} {snapshot_date.strftime('%b')} close",
        f"Price against open interest, the biggest OI change first (top {top_n} of each). Only moves of {oiq.MIN_PRICE_MOVE_PCT:g}% or more in price and "
        f"{oiq.MIN_OI_CHANGE_PCT:g}% or more in total OI count.",
    ]
    for heading, keys in (("🟢 Bullish", oiq.BULLISH), ("🔴 Bearish", oiq.BEARISH)):
        lines += ["", heading]
        for key in keys:
            g = groups[key]
            lines.append(f"{oiq.LABEL[key]} · {oiq.MEANING[key]} · {g['total']} stock{'s' if g['total'] != 1 else ''}")
            lines += [_oi_line(i, r) for i, r in enumerate(g["items"], 1)] or ["   none today"]
    lines += ["", f"★ call and put OI both grew {oiq.STRONG_MIN_SHIFT:.0f}% or more the same way (a strong two-sided build).", "Option-chain activity for the day, not a prediction or a recommendation."]
    return "\n".join(lines)


SESSION_TITLES = {"NSE": ("📈", "Post-session · NSE"), "MCX": ("🛢️", "Post-session · MCX"), "CRYPTO": ("🪙", "Daily summary · crypto")}
BIAS_HELD_BAND = 0.10  # percent: a bullish or bearish call needs the index to have moved at least this much its way to count as held
NEUTRAL_BAND = 0.30  # percent: a neutral call holds while the index stays inside this


def _money(v: float, segment: str) -> str:
    sign = "+" if v > 0 else MINUS if v < 0 else ""
    return f"{sign}{'$' if segment == 'CRYPTO' else '₹'}{abs(v):,.0f}"


def _level(label: str, v: float) -> str:
    return f"{v:,.0f}" if v >= 1000 else f"{v:,.2f}"


def bias_check(bias: Optional[str], nifty_change_pct: Optional[float]) -> Optional[str]:
    """Did the morning's call hold? None when there was no call or no index move to judge it by."""
    if bias is None or nifty_change_pct is None:
        return None
    c = nifty_change_pct
    held = c >= BIAS_HELD_BAND if bias == "bullish" else c <= -BIAS_HELD_BAND if bias == "bearish" else abs(c) <= NEUTRAL_BAND
    return f"Morning bias was {bias.capitalize()}: {'it held' if held else 'it did not hold'} (NIFTY {_signed(c)})."


VERDICT_LABEL = {
    "good_win": "Good trade · followed the plan",
    "good_loss": "Good loss · stayed within the plan",
    "lucky_win": "Won, but off the plan (luck)",
    "avoidable_loss": "Avoidable loss · off the plan",
    "flat": "Flat",
}
VERDICT_MARK = {"good_win": "✅", "good_loss": "✅", "lucky_win": "⚠️", "avoidable_loss": "❌", "flat": "➖"}


def trade_note(item: dict) -> str:
    """Why a trade was judged as it was: the verdict, and what was missing (no stop, market entry, closed by hand)."""
    label = VERDICT_LABEL.get(item.get("verdict", ""), "")
    issues = ", ".join(item.get("issues") or [])
    return f"{label}" + (f" · {issues}" if issues and item.get("verdict") not in ("good_win", "good_loss") else "")


def plan_insight(mode: dict, segment: str) -> Optional[str]:
    """One sentence on what following (or not following) the plan was worth today."""
    f_n, f_p, b_n, b_p = mode["followed_count"], mode["followed_pnl"], mode["broke_count"], mode["broke_pnl"]
    if mode["trades"] == 0:
        return None
    if b_n == 0:
        return "Every trade followed the plan."
    if f_n == 0:
        return "No trade followed the plan today."
    tail = f" Breaking the plan cost {_money(abs(b_p), segment).lstrip('+')}." if b_p < 0 else " Off-plan gains are luck."
    return f"On-plan {_money(f_p, segment)} · off-plan {_money(b_p, segment)}.{tail}"


def _price(v: Optional[float]) -> str:
    return "-" if v is None else (f"{v:,.2f}" if abs(v) < 1000 else f"{v:,.0f}")


def _held(minutes: Optional[int]) -> str:
    if minutes is None:
        return ""
    return f"{minutes}m" if minutes < 60 else f"{minutes // 60}h{minutes % 60:02d}m"


def _trade_line(item: dict, segment: str) -> list[str]:
    side = {"long": "long", "short": "short"}.get(item.get("side") or "", "")
    r = f" ({item['r']:+.1f}R)".replace("-", MINUS) if item.get("r") is not None else ""
    name = item.get("label") or ""
    head = f"{VERDICT_MARK.get(item['verdict'], '')} {item['symbol']}{(' ' + name) if name else ''} {side}".rstrip()
    move = f"{_price(item.get('entry'))} → {_price(item.get('exit'))}" if item.get("entry") and item.get("exit") else ""
    held = f" · {_held(item.get('held_minutes'))}" if item.get("held_minutes") is not None else ""
    return [f"{head}  {_money(item['pnl'], segment)}{r}", f"   {trade_note(item)}" + (f" · {move}{held}" if move else "")]


def _stats_line(st: Optional[dict], segment: str) -> Optional[str]:
    if not st:
        return None
    parts = [f"win rate {st['win_rate_pct']:.0f}%"]
    if st.get("profit_factor") is not None:
        parts.append(f"profit factor {st['profit_factor']:.1f}")
    if st.get("avg_win") is not None and st.get("avg_loss") is not None:
        parts.append(f"avg win {_money(st['avg_win'], segment).lstrip('+')} / avg loss {_money(abs(st['avg_loss']), segment).lstrip('+')}")
    if st.get("expectancy") is not None:
        parts.append(f"expectancy {_money(st['expectancy'], segment)} a trade")
    return f"Last {st['days']} days ({st['trades']} trades): " + " · ".join(parts)


def _account_line(acct: Optional[dict], segment: str) -> Optional[str]:
    if not acct:
        return None
    day = f"{_money(acct['day_change'], segment)}" + (f" ({_signed(acct['day_change_pct'])})" if acct.get("day_change_pct") is not None else "")
    parts = [f"{day} today", f"balance {_money(acct['balance'], segment).lstrip('+')}"]
    if acct.get("since_start_pct") is not None:
        parts.append(f"{_signed(acct['since_start_pct'])} since the start")
    parts.append(f"{_money(acct['month_pnl'], segment)} this month")
    return "Paper account: " + " · ".join(parts)


ZONE_STATUS = {
    "untouched": "not reached today",
    "tested": "reached",
    "held": "tested and held ✅",
    "broke": "tested and broke ⚠️",
    "closed_inside": "closed inside it",
}


def _zone_band(lo: float, hi: float) -> str:
    f = lambda v: f"{v:,.0f}" if abs(v) >= 1000 else f"{v:,.2f}"  # noqa: E731
    return f(lo) if lo == hi else f"{f(lo)}–{f(hi)}"


def zone_line(z: dict) -> str:
    """One line on what became of a zone or level the person armed: 'GOLDM support 147,116–147,673: tested and held ✅ (low 147,629 at 16:00)'."""
    role = "level" if z.get("kind") == "line" else (z.get("role") or "zone")
    mark = {"support": "🟢", "resistance": "🔴"}.get(z.get("role") or "", "🟡")
    detail = ""
    if z["status"] != "untouched" and z.get("at"):
        extreme = f"{'low' if z.get('role') == 'support' else 'high'} {z['extreme']:,.0f} at " if z.get("extreme") is not None and z.get("role") in ("support", "resistance") else "at "
        detail = f" ({extreme}{z['at']})"
    return f"{mark} {z['symbol']} {role} {_zone_band(z['lo'], z['hi'])}: {ZONE_STATUS[z['status']]}{detail}"


def _market_strip(market: dict, bias: Optional[str], segment: str) -> str:
    bits = []
    for r in market["rows"]:
        bits.append(f"{r['label']} {_signed(r['change_pct'])}")
    nifty = next((r for r in market["rows"] if r["label"] == "NIFTY"), None)
    check = bias_check(bias, nifty["change_pct"] if nifty else None) if segment == "NSE" else None
    if check:
        bits.append("bias held" if "it held" in check else "bias did not hold")
    return "Market: " + " · ".join(bits)


def session_message(segment: str, day: date, market: dict, trader: Optional[dict], bias: Optional[str] = None, trader_known: bool = True, zones: Optional[list] = None) -> str:
    """The post-session summary, your own trading first: the account, each trade judged by the plan, the last 30 days, then a line on the
    market. `trader` is execution's answer for that day (None with `trader_known=False` when execution could not be reached, which the
    message says rather than claiming no trades)."""
    icon, title = SESSION_TITLES[segment]
    lines = [f"{icon} Your trading day · {title.split('· ')[-1]} · {day.strftime('%a')} {day.day} {day.strftime('%b')}"]
    if not trader_known:
        lines += ["", "Your trades could not be loaded just now. See them in the app."]
    else:
        modes = [(n_, trader[k]) for n_, k in (("Paper", "paper"), ("Live", "live")) if trader and trader.get(k)]
        acct = _account_line(trader.get("account") if trader else None, segment)
        if acct:
            lines += ["", acct]
        if not modes:
            lines += ["", "You had no closed trades today."]
        for name, d in modes:
            won = f"{d['wins']} won" + (f", {d['losses']} lost" if d["losses"] else "")
            lines += ["", f"{name}: {d['trades']} closed · {won} · net {_money(d['net_pnl'], segment)} after charges"]
            insight = plan_insight(d, segment)
            if insight:
                lines.append(insight)
            for item in d.get("items", []):
                lines += _trade_line(item, segment)
            if d.get("more"):
                lines.append(f"…and {d['more']} more in the app")
        stats = (trader.get("stats") or {}) if trader else {}
        stat = _stats_line(stats.get("paper") or stats.get("live"), segment)
        if stat:
            lines += ["", stat]
        extras = []
        if trader and trader.get("open_now"):
            extras.append(f"Still open: {trader['open_now']}")
        if trader and trader.get("discipline_score") is not None:
            extras.append(f"Discipline (30 days): {trader['discipline_score']}/100")
        if extras:
            lines.append(" · ".join(extras))
    if zones:
        lines += ["", "Your zones today"] + [zone_line(z) for z in zones]
    lines += ["", _market_strip(market, bias, segment), "", "Your own record and public market data, not a recommendation. Details in the app."]
    return "\n".join(lines)


def session_caption(segment: str, day: date, market: dict, trader: Optional[dict], bias: Optional[str] = None) -> str:
    """The short line that goes with the picture (and shows in a notification): your result first, then the lead index."""
    icon, title = SESSION_TITLES[segment]
    parts = []
    for name, key in (("Paper", "paper"), ("Live", "live")):
        m = trader.get(key) if trader else None
        if m:
            parts.append(f"{name} {_money(m['net_pnl'], segment)} · {m['trades']} trades · plan followed {m['followed_count']}/{m['trades']}")
    if not parts:
        parts.append("no closed trades" if trader else "trades unavailable")
    lead = market["rows"][0]
    parts.append(f"{lead['label']} {_signed(lead['change_pct'])}")
    if segment == "NSE":
        nifty = next((r for r in market["rows"] if r["label"] == "NIFTY"), None)
        check = bias_check(bias, nifty["change_pct"] if nifty else None)
        if check:
            parts.append("bias held" if "it held" in check else "bias did not hold")
    return f"{icon} Your trading day · {title.split('· ')[-1]} · {day.strftime('%a')} {day.day} {day.strftime('%b')}\n" + " · ".join(parts)


def session_bias_held(segment: str, market: dict, bias: Optional[str]) -> Optional[tuple[str, bool]]:
    """(the morning's bias, whether it held) for the card, or None when there is no call to check."""
    if segment != "NSE" or bias is None:
        return None
    nifty = next((r for r in market["rows"] if r["label"] == "NIFTY"), None)
    check = bias_check(bias, nifty["change_pct"] if nifty else None)
    return (bias, "it held" in check) if check else None


def oi_caption(rows: list[dict], snapshot_date: date, top_n: int) -> str:
    """The short line that goes with the OI picture: how many stocks are in each of the four boxes and the leader of each."""
    groups = oiq.by_quadrant(rows, 1)
    parts = []
    for key, icon in (("long_buildup", "🟢"), ("short_covering", "🟢"), ("short_buildup", "🔴"), ("long_unwinding", "🔴")):
        g = groups[key]
        parts.append(f"{icon} {oiq.LABEL[key]} {g['total']}" + (f" ({g['items'][0]['symbol']})" if g["items"] else ""))
    return f"📊 OI buildup · {snapshot_date.day} {snapshot_date.strftime('%b')} close\n" + " · ".join(parts)


def token_message(expires_at: datetime, now: datetime, tz) -> Optional[tuple[str, str]]:
    """(dedupe key, text) when the Dhan access token has expired or is about to, else None."""
    local = expires_at.astimezone(tz)
    stamp = f"{local.day} {local.strftime('%b %H:%M')} IST"
    if now >= expires_at:
        return f"token-expired:{expires_at.isoformat()}", f"🔴 The Dhan access token expired ({stamp}). NSE and MCX live data and the end-of-day scans will fail until a new token is set."
    if expires_at - now <= timedelta(hours=6):
        left = expires_at - now
        hours, minutes = divmod(int(left.total_seconds() // 60), 60)
        return f"token-expiring:{expires_at.isoformat()}", f"🟠 The Dhan access token expires at {stamp}, in {hours}h {minutes:02d}m. Set a new one before then."
    return None


def job_failed_message(label: str, message: Optional[str], started_at: datetime, tz, count: int = 1, today: Optional[date] = None) -> str:
    """One message for a job that failed, however many times it did that day: the latest run's time and reason, and how many failed.
    A failure from an earlier day says which day ("on 5 Oct"), never "today"."""
    local = started_at.astimezone(tz)
    reason = (message or "no reason recorded").strip()[:240]
    when = "today" if today is None or local.date() == today else f"on {local.day} {local.strftime('%b')}"
    times = f"failed {count} times {when}, latest at" if count > 1 else (f"failed {when} at" if when != "today" else "failed at")
    return f"🔴 Background job {times} {local.strftime('%H:%M')} IST: {label}\n{reason}"
