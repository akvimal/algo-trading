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
        Category("oi_buildup", "Strong OI buildup", "The F&O stocks whose call and put open interest both grew a lot in the same direction that day: the top few bullish and bearish, in one message.", "Weekdays after the end-of-day OI scan finishes (about 4:05 PM IST)", defaults={"top_n": 10}),
        Category("session_nse", "Post-session summary: NSE", "How the NSE session went (NIFTY, BANKNIFTY, VIX, and whether the morning bias held) and your own closed trades that day, paper and live apart.", "Weekdays at 3:50 PM IST, after the 3:30 PM close; skipped on a market holiday"),
        Category("session_mcx", "Post-session summary: MCX", "How gold, crude, silver and natural gas (the mini contracts) did in the MCX session, and your own closed MCX trades that day, paper and live apart.", "Weekdays at 11:58 PM IST, after the late-evening close; skipped on an MCX holiday"),
        Category("session_crypto", "Post-session summary: crypto", "The last 24 hours in BTC and ETH and your own crypto trades that day, paper and live apart. Crypto never closes, so this goes out at a fixed time.", "Every day at 11:30 PM IST"),
        Category("ops", "Operator alerts", "The Dhan token expiring or expired, and background jobs that failed.", "Checked every 10 minutes", admin_only=True),
    )
}

TOP_N_MIN, TOP_N_MAX = 3, 20
STRONG_MIN_SHIFT = 10.0  # percent: how much BOTH call and put OI must have grown, the same default the Scan screen uses


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


def broadcast(db: Session, category: str, key: str, build: Callable[[dict], Optional[str]], now: Optional[datetime] = None) -> Tally:
    """Send a category's message to every subscriber, once each. `build(params)` returns the text for that person's settings, or None
    when there is nothing worth sending them."""
    tally = Tally()
    for sub in subscribers(db, category):
        text = build(sub.params)
        if not text:
            tally.skipped += 1
            continue
        outcome = deliver(db, sub.user_id, sub.chat_id, category, key, text, now)
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


def oi_signal(row: dict, min_shift: float = STRONG_MIN_SHIFT) -> Optional[str]:
    """"bull" / "bear" when BOTH call and put open interest grew at least `min_shift` percent in the same direction of buildup (price up
    with long buildup on both sides, or price down with short buildup on both); else None. The same rule as the Scan screen's strong
    bullish / strong bearish. A row missing a change figure never qualifies."""
    call, put = row.get("call_oi_change_pct"), row.get("put_oi_change_pct")
    if call is None or put is None or call < min_shift or put < min_shift:
        return None
    if row.get("call_buildup") == "long_buildup" and row.get("put_buildup") == "long_buildup":
        return "bull"
    if row.get("call_buildup") == "short_buildup" and row.get("put_buildup") == "short_buildup":
        return "bear"
    return None


def strong_oi(rows: list[dict], top_n: int) -> tuple[list[dict], list[dict], int, int]:
    """(top bullish, top bearish, total bullish, total bearish), each list ranked by the combined call+put shift, biggest first."""
    bull = sorted((r for r in rows if oi_signal(r) == "bull"), key=lambda r: (-(r["call_oi_change_pct"] + r["put_oi_change_pct"]), r["symbol"]))
    bear = sorted((r for r in rows if oi_signal(r) == "bear"), key=lambda r: (-(r["call_oi_change_pct"] + r["put_oi_change_pct"]), r["symbol"]))
    return bull[:top_n], bear[:top_n], len(bull), len(bear)


def _oi_line(i: int, r: dict) -> str:
    price = f" · price {_signed(r.get('price_change_pct'))}" if r.get("price_change_pct") is not None else ""
    return f"{i}. {r['symbol']}  call {_signed(r['call_oi_change_pct'], 0)} · put {_signed(r['put_oi_change_pct'], 0)}{price}"


def oi_digest_message(rows: list[dict], snapshot_date: date, top_n: int) -> Optional[str]:
    """The strong OI buildup digest, or None when no stock qualified (no message rather than an empty one)."""
    bull, bear, n_bull, n_bear = strong_oi(rows, top_n)
    if not bull and not bear:
        return None
    lines = [f"📊 Strong OI buildup · {snapshot_date.day} {snapshot_date.strftime('%b')} close", f"Stocks whose call AND put open interest both grew at least {STRONG_MIN_SHIFT:.0f}% the same way. Ranked by the size of the shift.", ""]
    for title, items, total in (("🟢 Strong bullish", bull, n_bull), ("🔴 Strong bearish", bear, n_bear)):
        lines.append(f"{title} (top {len(items)} of {total})" if items else f"{title}: none")
        lines += [_oi_line(i, r) for i, r in enumerate(items, 1)]
        lines.append("")
    lines.append("Option-chain activity for the day, not a prediction or a recommendation.")
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


def _mode_lines(name: str, d: dict, segment: str) -> list[str]:
    won = f"{d['wins']} won" + (f", {d['losses']} lost" if d["losses"] else "")
    lines = [f"{name}: {d['trades']} closed · {won} · net {_money(d['net_pnl'], segment)} after charges"]

    def leg(word: str, t: dict) -> str:
        r = f" ({t['r']:+.1f}R)".replace("-", MINUS) if t.get("r") is not None else ""
        return f"{word} {t['symbol']} {_money(t['pnl'], segment)}{r}"

    if d["trades"] > 1 and d.get("best") and d.get("worst"):
        lines.append(f"{leg('Best', d['best'])} · {leg('Worst', d['worst'])}")
    elif d.get("best"):
        lines.append(leg("Trade", d["best"]))
    lines.append(f"With a limit entry and a stop: {d['with_plan']} of {d['trades']}")
    return lines


def session_message(segment: str, day: date, market: dict, trader: Optional[dict], bias: Optional[str] = None, trader_known: bool = True) -> str:
    """The post-session summary: how the market did, then the person's own day. `trader` is execution's answer for that day (None with
    `trader_known=False` when execution could not be reached, which the message says rather than claiming no trades)."""
    icon, title = SESSION_TITLES[segment]
    lines = [f"{icon} {title} · {day.strftime('%a')} {day.day} {day.strftime('%b')}"]
    rows = market["rows"]
    for r in rows:
        if r["label"] == "India VIX":
            lines.append(f"India VIX {r['close']:.2f} ({_signed(r['change_pct'])})")
            continue
        near = "near the high" if r["position"] >= 0.8 else "near the low" if r["position"] <= 0.2 else "mid-range"
        lines.append(f"{r['label']} {_level(r['label'], r['close'])} ({_signed(r['change_pct'])}) · range {_level(r['label'], r['low'])}–{_level(r['label'], r['high'])}, closed {near}")
    nifty = next((r for r in rows if r["label"] == "NIFTY"), None)
    check = bias_check(bias, nifty["change_pct"] if nifty else None) if segment == "NSE" else None
    if check:
        lines += ["", check]
    lines.append("")
    if not trader_known:
        lines.append("Your trades: could not be loaded just now. See them in the app.")
    else:
        modes = [(n_, trader[k]) for n_, k in (("Paper", "paper"), ("Live", "live")) if trader and trader.get(k)]
        if not modes:
            lines.append("You had no closed trades today.")
        for i, (name, d) in enumerate(modes):
            lines += ([""] if i else []) + _mode_lines(name, d, segment)
        extras = []
        if trader and trader.get("open_now"):
            extras.append(f"Still open: {trader['open_now']}")
        if trader and trader.get("discipline_score") is not None:
            extras.append(f"Discipline (30 days): {trader['discipline_score']}/100")
        if extras:
            lines.append(" · ".join(extras))
    lines += ["", "Market data and your own record, not a recommendation. Details in the app."]
    return "\n".join(lines)


def session_caption(segment: str, day: date, market: dict, trader: Optional[dict], bias: Optional[str] = None) -> str:
    """The short line that goes with the picture (and shows in a notification): the day, the lead index and the person's net result."""
    icon, title = SESSION_TITLES[segment]
    lead = market["rows"][0]
    parts = [f"{lead['label']} {_level(lead['label'], lead['close'])} ({_signed(lead['change_pct'])})"]
    if segment == "NSE":
        nifty = next((r for r in market["rows"] if r["label"] == "NIFTY"), None)
        check = bias_check(bias, nifty["change_pct"] if nifty else None)
        if check:
            parts.append("bias held" if "it held" in check else "bias did not hold")
    for name, key in (("Paper", "paper"), ("Live", "live")):
        if trader and trader.get(key):
            parts.append(f"{name} {_money(trader[key]['net_pnl'], segment)}")
    return f"{icon} {title} · {day.strftime('%a')} {day.day} {day.strftime('%b')}\n" + " · ".join(parts)


def session_bias_held(segment: str, market: dict, bias: Optional[str]) -> Optional[tuple[str, bool]]:
    """(the morning's bias, whether it held) for the card, or None when there is no call to check."""
    if segment != "NSE" or bias is None:
        return None
    nifty = next((r for r in market["rows"] if r["label"] == "NIFTY"), None)
    check = bias_check(bias, nifty["change_pct"] if nifty else None)
    return (bias, "it held" in check) if check else None


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
