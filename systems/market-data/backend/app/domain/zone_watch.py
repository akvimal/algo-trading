"""Zones and levels a person drew on a chart, watched by the server so a touch reaches their own Telegram chat even with every tab closed.

Why: zone alerts drawn on the chart were watched by the open page only. Someone looking at NSE never heard that a GOLDM zone they had
marked in the morning was tested, precisely, in the afternoon. The browser still holds the drawings; it sends the armed zones (and horizontal
levels) here (app/api/routes/zone_watches.py), and two scheduled checks do the watching:

  * `check_live` (every few seconds): the price against each zone. Entering a zone, or crossing straight through it, is a TOUCH and is
    announced at once.
  * `check_bars` (every minute): looks at the candles that have CLOSED since a zone was armed. A candle whose high-low range overlapped the
    zone touched it even if the live check was never looking at that instant (a wick), so a touch missed live is announced late rather
    than never; and the candle's CLOSE says what happened: it HELD (closed back on the side the price came from), BROKE (closed through the
    zone) or closed INSIDE. That second message is the one worth acting on.

Each event happens once (zone_events.dedupe_key), is kept after the zone is removed (the end-of-day recap reads it), and goes to the owner's
own chat through the same delivery that records and retries every Telegram message (app/domain/notifications.py). The pure parts (sides,
touch tests, outcome, wording) are separate from the database and Telegram parts, so they are tested exactly."""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Callable, Optional
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.adapters.db.models import AlertChannel, ZoneEvent, ZoneWatch
from app.config import settings
from app.domain import notifications as n
from app.providers.router import get_provider

logger = logging.getLogger(__name__)

EXCHANGES = ("NSE", "MCX", "CRYPTO")
MAX_WATCHES_PER_USER = 30
MAX_WATCHES_PER_SYMBOL = 10
DEFAULT_INTERVAL = "15min"
FALLBACK_INTERVAL = "60min"  # a daily or weekly chart has no intraday candle to judge a close on: judge it hourly
MINUS = "−"

BatchQuote = Callable[[str, list[str]], dict[str, float]]
HistoryFetch = Callable[[str, str, str, date, date], list]  # (exchange, symbol, interval, from, to) -> candles, oldest first

_lock = threading.Lock()


# ---- pure: sides, touches, outcomes -----------------------------------------------------------------------------------------------


def side_of(price: float, lo: float, hi: float) -> str:
    """above / inside / below. A level (lo == hi) has only two sides; sitting exactly on it counts as above."""
    if lo == hi:
        return "above" if price >= lo else "below"
    return "above" if price > hi else "below" if price < lo else "inside"


def role_from_side(side: str) -> str:
    """A zone the price first sat above is support, one it first sat below is resistance; first seen inside it is just a zone."""
    return "support" if side == "above" else "resistance" if side == "below" else "zone"


def candle_touches(low: float, high: float, lo: float, hi: float) -> bool:
    """Did this candle's high-low range overlap the zone? That is a touch even if only a wick got there."""
    return low <= hi and high >= lo


@dataclass(frozen=True)
class LiveCheck:
    state: str
    touched: bool
    approach: Optional[str]  # which side the price came from, when it touched


def evaluate_ltp(prev: Optional[str], ltp: float, lo: float, hi: float) -> LiveCheck:
    """One live check. The first check only learns which side the price is on (nothing can have been touched yet). After that, entering the
    zone is a touch, and so is jumping from one side straight to the other (a level, or a fast move between two checks)."""
    state = side_of(ltp, lo, hi)
    if prev is None or prev == state:
        return LiveCheck(state, False, None)
    entered = state == "inside"
    crossed = prev in ("above", "below") and state in ("above", "below")
    return LiveCheck(state, entered or crossed, prev if prev != "inside" else None)


def candle_outcome(open_: float, close: float, prev_close: Optional[float], lo: float, hi: float, role: Optional[str]) -> tuple[str, str]:
    """(approach, outcome) for a candle that touched the zone. `approach` is the side the price came from (the candle's open, else the close
    before it); `outcome` is held (closed back on that side), broke (closed through), or inside (closed in the zone). A candle that opened
    inside the zone with no side to come from is judged by the zone's role: support holds when it closes above, resistance when below."""
    approach = side_of(open_, lo, hi)
    if approach == "inside" and prev_close is not None:
        approach = side_of(prev_close, lo, hi)
    close_side = side_of(close, lo, hi)
    if close_side == "inside":
        return approach, "inside"
    if approach == "inside":
        held = (role == "support" and close_side == "above") or (role == "resistance" and close_side == "below")
        return approach, ("held" if held else "broke") if role in ("support", "resistance") else "inside"
    return approach, "held" if close_side == approach else "broke"


def _num(v: float) -> str:
    return f"{v:,.0f}" if abs(v) >= 1000 else f"{v:,.2f}"


def band_text(lo: float, hi: float) -> str:
    return _num(lo) if lo == hi else f"{_num(lo)}–{_num(hi)}"


def label(role: Optional[str], kind: str) -> str:
    return "level" if kind == "line" else {"support": "support zone", "resistance": "resistance zone"}.get(role or "", "zone")


def touch_message(symbol: str, role: Optional[str], kind: str, lo: float, hi: float, ltp: Optional[float] = None, extreme: Optional[float] = None, when: Optional[str] = None) -> str:
    """The first message: the price reached it. From a live check it carries the price now; from a candle it carries the wick."""
    head = f"🎯 {symbol} reached your {label(role, kind)} {band_text(lo, hi)}"
    if ltp is not None:
        return f"{head} · now {_num(ltp)}"
    tail = f" (wick to {_num(extreme)}" + (f" at {when}" if when else "") + ")" if extreme is not None else ""
    return f"{head}{tail}"


def outcome_message(symbol: str, role: Optional[str], kind: str, lo: float, hi: float, approach: str, outcome: str, extreme: Optional[float], close: float) -> str:
    """The second message, at the candle's close: did it hold or break. The side it closed on comes from the zone's role first (support holds
    above, resistance below) and only then from where the price came from: a candle that OPENED inside the zone has no side to have come from."""
    name, band = label(role, kind), band_text(lo, hi)
    came = {"above": "from above", "below": "from below"}.get(approach, "")
    wick = f", {'low' if approach == 'above' else 'high'} {_num(extreme)}" if extreme is not None and approach in ("above", "below") else ""
    held_side = "above" if role == "support" else "below" if role == "resistance" else ("above" if approach == "above" else "below")
    broke_side = "above" if held_side == "below" else "below"
    tested = " ".join(part for part in (f"{symbol} tested your {name} {band}", came) if part) + wick
    if outcome == "held":
        return f"✅ {tested} and closed back {held_side} at {_num(close)}: it held"
    if outcome == "broke":
        return f"⚠️ {symbol} closed {broke_side} your {name} {band} at {_num(close)}: it broke"
    return f"{symbol} closed inside your {name} {band} at {_num(close)}"


def eval_interval(interval: Optional[str]) -> str:
    """The candle size a zone's close is judged on: the chart's own when it is an intraday 'Nmin', else hourly."""
    if interval and interval.endswith("min") and interval[:-3].isdigit() and int(interval[:-3]) > 0:
        return interval
    return FALLBACK_INTERVAL


def interval_minutes(interval: str) -> int:
    return int(eval_interval(interval)[:-3])


def bar_floor(moment: datetime, minutes: int) -> datetime:
    """The start of the `minutes`-long bar `moment` falls in (aligned to the clock; only used to keep a bar's live touch to one message)."""
    epoch = int(moment.timestamp())
    return datetime.fromtimestamp(epoch - epoch % (minutes * 60), tz=timezone.utc)


# ---- reconcile what the browser sends ------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class WatchSpec:
    kind: str
    lo: float
    hi: float


class ZoneWatchError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


def _q(v) -> Decimal:
    return Decimal(str(round(float(v), 4)))


def clean_specs(raw: list[dict]) -> list[WatchSpec]:
    """Check what the browser sent: a zone is a band with lo < hi, a level has lo == hi, prices are positive and finite."""
    out: dict[tuple, WatchSpec] = {}
    for item in raw:
        kind = item.get("kind")
        try:
            lo, hi = float(item["lo"]), float(item["hi"])
        except (KeyError, TypeError, ValueError):
            raise ZoneWatchError(422, "Each zone needs a numeric lo and hi.")
        if kind not in ("zone", "line") or not (lo > 0 and hi > 0) or lo != lo or hi != hi:
            raise ZoneWatchError(422, "A zone or level needs a positive price.")
        lo, hi = min(lo, hi), max(lo, hi)
        if kind == "line":
            hi = lo
        elif lo == hi:
            kind = "line"
        spec = WatchSpec(kind, float(_q(lo)), float(_q(hi)))
        out[(spec.kind, spec.lo, spec.hi)] = spec
    return list(out.values())


def sync_watches(db: Session, user_id: UUID, exchange: str, symbol: str, specs: list[WatchSpec], interval: str) -> list[ZoneWatch]:
    """Make the server's watches for this person and instrument exactly `specs`: keep the ones that match (with their memory of where the
    price was), add new ones, drop the rest (zones removed or moved on the chart: a moved zone is a new one, as it is in the browser)."""
    if exchange not in EXCHANGES:
        raise ZoneWatchError(404, f"Unknown exchange {exchange}.")
    if len(specs) > MAX_WATCHES_PER_SYMBOL:
        raise ZoneWatchError(422, f"At most {MAX_WATCHES_PER_SYMBOL} zones and levels per instrument.")
    mine = db.query(ZoneWatch).filter(ZoneWatch.user_id == user_id).all()
    rows = [r for r in mine if (r.exchange, r.symbol) == (exchange, symbol)]
    elsewhere = len(mine) - len(rows)
    if elsewhere + len(specs) > MAX_WATCHES_PER_USER:
        raise ZoneWatchError(422, f"At most {MAX_WATCHES_PER_USER} zones and levels in all. Remove some you no longer need.")
    have = {(r.kind, float(r.lo), float(r.hi)): r for r in rows}
    want = {(s.kind, s.lo, s.hi) for s in specs}
    kept: list[ZoneWatch] = []
    for key, row in have.items():
        if key not in want:
            db.delete(row)
        else:
            if row.interval != interval:
                row.interval = interval
            kept.append(row)
    for s in specs:
        if (s.kind, s.lo, s.hi) not in have:
            row = ZoneWatch(id=uuid4(), user_id=user_id, exchange=exchange, symbol=symbol, kind=s.kind, lo=_q(s.lo), hi=_q(s.hi), interval=interval)
            db.add(row)
            kept.append(row)
    db.commit()
    return kept


# ---- events and delivery ---------------------------------------------------------------------------------------------------------------


def _channels(db: Session) -> dict[UUID, str]:
    return {c.user_id: c.telegram_chat_id for c in db.query(AlertChannel).all()}


ALERT_LEVELS = ("all", "close", "off")  # all: the touch and then the verdict; close: only the verdict (held / broke); off: nothing
_QUIETNESS = {"all": 0, "close": 1, "off": 2}
# The same kind of event for the same zone is sent at most this often: on a 1-minute chart every candle that touches or closes in a band
# used to send its own message.
COOLDOWN = timedelta(minutes=30)


def _levels(db: Session) -> dict[UUID, str]:
    """Each person's own setting for all their zones (alert_channels.zone_alerts)."""
    return {c.user_id: c.zone_alerts or "all" for c in db.query(AlertChannel).all()}


def effective_level(person: Optional[str], zone: Optional[str]) -> str:
    """The quieter of the person's setting and the zone's own: switching either one down is enough."""
    return max((person or "all", zone or "all"), key=lambda lv: _QUIETNESS.get(lv, 0))


def should_notify(db: Session, w: ZoneWatch, ev: ZoneEvent, person_level: Optional[str]) -> bool:
    """Is this event worth a message? It is always RECORDED (the recap and the Latest list read it); this only decides the Telegram message.
    Not when it is switched off, not for 'closed inside' (a candle that ended in the zone is not news - the touch said it was there), not a
    touch ping in 'close only' mode, and not a repeat of the same kind of event on the same zone within the cooldown."""
    level = effective_level(person_level, w.alerts)
    if level == "off" or ev.event == "inside" or (level == "close" and ev.event == "touch"):
        return False
    since = (ev.at or datetime.now(timezone.utc)) - COOLDOWN
    recent = db.query(ZoneEvent).filter(ZoneEvent.watch_id == w.id, ZoneEvent.event == ev.event, ZoneEvent.at >= since, ZoneEvent.dedupe_key != ev.dedupe_key).all()
    return not any(e.notified is not False for e in recent)  # an event that was itself held back does not start a cooldown


def _announce(db: Session, w: ZoneWatch, ev: ZoneEvent, key: str, text: str, channels: dict[UUID, str], levels: dict[UUID, str]) -> bool:
    """Send the message for a recorded event unless it should be held back. Returns whether one was sent."""
    ok = should_notify(db, w, ev, levels.get(w.user_id))
    ev.notified = ok
    if ok:
        _send(db, w, key, text, channels)
    return ok


def _record(db: Session, w: ZoneWatch, event: str, key: str, at: datetime, bar_time: Optional[datetime], approach: Optional[str], extreme: Optional[float], close: Optional[float]) -> Optional[ZoneEvent]:
    """Store an event once. Returns it, or None when that event already happened."""
    if db.query(ZoneEvent).filter(ZoneEvent.user_id == w.user_id, ZoneEvent.dedupe_key == key).first() is not None:
        return None
    ev = ZoneEvent(
        watch_id=w.id, user_id=w.user_id, exchange=w.exchange, symbol=w.symbol, kind=w.kind, lo=w.lo, hi=w.hi, role=w.role, event=event, at=at,
        bar_time=bar_time, approach=approach, extreme=_q(extreme) if extreme is not None else None, close=_q(close) if close is not None else None, dedupe_key=key,
    )
    db.add(ev)
    db.flush()
    return ev


def _send(db: Session, w: ZoneWatch, key: str, text: str, channels: dict[UUID, str]) -> None:
    chat = channels.get(w.user_id)
    if not chat:
        logger.info("zone watch %s: %s - no Telegram chat set for this person, recorded only", w.id, text)
        return
    n.deliver(db, w.user_id, chat, "zones", key, text)


def _default_batch_quote(exchange: str, symbols: list[str]) -> dict[str, float]:
    try:
        return get_provider(exchange).get_ltp_batch(symbols, credentials=None)
    except Exception:
        logger.warning("zone watch: LTP fetch failed for %s %s", exchange, symbols, exc_info=True)
        return {}


def _default_history(exchange: str, symbol: str, interval: str, from_date: date, to_date: date) -> list:
    try:
        return get_provider(exchange).get_candle_history(symbol, interval, from_date, to_date)
    except Exception:
        logger.warning("zone watch: candle fetch failed for %s:%s %s", exchange, symbol, interval, exc_info=True)
        return []


# ---- the live check ------------------------------------------------------------------------------------------------------------------


def check_live(db: Session, batch_quote: BatchQuote = _default_batch_quote, now: Optional[datetime] = None) -> int:
    """The price against every armed zone. Returns how many touches were announced."""
    with _lock:
        return _check_live(db, batch_quote, now or datetime.now(timezone.utc))


def _check_live(db: Session, batch_quote: BatchQuote, now: datetime) -> int:
    watches = db.query(ZoneWatch).all()
    if not watches:
        return 0
    by_exchange: dict[str, set[str]] = {}
    for w in watches:
        by_exchange.setdefault(w.exchange, set()).add(w.symbol)
    quotes: dict[tuple[str, str], float] = {}
    for exchange, symbols in by_exchange.items():
        for sym, px in batch_quote(exchange, sorted(symbols)).items():
            if isinstance(px, (int, float)):
                quotes[(exchange, sym)] = float(px)
    channels = _channels(db)
    levels = _levels(db)
    announced = 0
    for w in watches:
        ltp = quotes.get((w.exchange, w.symbol))
        if ltp is None:
            continue
        lo, hi = float(w.lo), float(w.hi)
        check = evaluate_ltp(w.last_state, ltp, lo, hi)
        if w.role is None:
            w.role = role_from_side(check.state)
        w.last_state, w.last_checked_at = check.state, now
        if not check.touched:
            continue
        minutes = interval_minutes(w.interval)
        bar = bar_floor(now, minutes)
        key = f"touch:{w.id}:{bar.isoformat()}"
        ev = _record(db, w, "touch", key, now, bar, check.approach, None, None)
        if ev is None:
            continue  # this bar's touch was already announced
        if _announce(db, w, ev, key, touch_message(w.symbol, w.role, w.kind, lo, hi, ltp=ltp), channels, levels):
            announced += 1
    db.commit()
    return announced


# ---- the candle check ----------------------------------------------------------------------------------------------------------------


def _ts(c) -> datetime:
    t = c.timestamp
    return t if isinstance(t, datetime) else datetime.fromisoformat(str(t))


def check_bars(db: Session, history: HistoryFetch = _default_history, now: Optional[datetime] = None) -> int:
    """Look at the candles that have closed since each zone was armed: announce a touch the live check missed (a wick), and say how each
    touching candle closed. Returns how many messages were produced."""
    with _lock:
        return _check_bars(db, history, now or datetime.now(timezone.utc))


def _check_bars(db: Session, history: HistoryFetch, now: datetime) -> int:
    watches = db.query(ZoneWatch).all()
    if not watches:
        return 0
    channels = _channels(db)
    levels = _levels(db)
    candles: dict[tuple[str, str, str], list] = {}
    produced = 0
    today = now.astimezone(ZoneInfo(settings.timezone)).date()
    for w in watches:
        interval = eval_interval(w.interval)
        minutes = int(interval[:-3])
        ck = (w.exchange, w.symbol, interval)
        if ck not in candles:
            candles[ck] = sorted(history(w.exchange, w.symbol, interval, today - timedelta(days=3), today), key=_ts)
        series = candles[ck]
        if not series:
            continue
        armed_at = w.created_at
        judged_to = w.last_bar_checked  # the start of the newest candle already judged
        lo, hi = float(w.lo), float(w.hi)
        newest = judged_to
        for i, c in enumerate(series):
            start = _ts(c)
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc)
            end = start + timedelta(minutes=minutes)
            if end > now:
                continue  # still forming
            if judged_to is not None and start <= judged_to:
                continue  # already judged
            if armed_at is not None and start < armed_at:
                continue  # began before the zone existed
            newest = start
            if not candle_touches(c.low, c.high, lo, hi):
                continue
            prev_close = series[i - 1].close if i > 0 else None
            approach, outcome = candle_outcome(c.open, c.close, prev_close, lo, hi, w.role)
            if w.role is None and approach in ("above", "below"):
                w.role = role_from_side(approach)  # the live check never saw this one: the side the price came from says what it is
            wick = c.low if approach == "above" else c.high if approach == "below" else (c.low if w.role == "support" else c.high)
            when = start.astimezone(ZoneInfo(settings.timezone)).strftime("%H:%M")
            # a touch the live check did not see: announce it now, late, with the wick that proves it
            live = db.query(ZoneEvent).filter(ZoneEvent.user_id == w.user_id, ZoneEvent.watch_id == w.id, ZoneEvent.event == "touch", ZoneEvent.at >= start, ZoneEvent.at < end).first()
            if live is None:
                tkey = f"touch:{w.id}:{start.isoformat()}"
                tev = _record(db, w, "touch", tkey, start, start, approach, wick, None)
                if tev is not None and _announce(db, w, tev, tkey, touch_message(w.symbol, w.role, w.kind, lo, hi, extreme=wick, when=when), channels, levels):
                    produced += 1
            okey = f"out:{w.id}:{start.isoformat()}"
            oev = _record(db, w, outcome, okey, end, start, approach, wick, c.close)
            if oev is not None and _announce(db, w, oev, okey, outcome_message(w.symbol, w.role, w.kind, lo, hi, approach, outcome, wick, c.close), channels, levels):
                produced += 1
        if newest is not None:
            w.last_bar_checked = newest
    db.commit()
    return produced


# ---- the recap and the morning list ------------------------------------------------------------------------------------------------


def zone_recap(db: Session, user_id: UUID, exchange: str, day: date) -> list[dict]:
    """What happened to each zone the person has on this exchange that IST day: untouched, tested and held, tested and broke, or closed
    inside. Includes zones removed since (their events are kept)."""
    tz = ZoneInfo(settings.timezone)
    start = datetime(day.year, day.month, day.day, tzinfo=tz)
    end = start + timedelta(days=1)
    watches = db.query(ZoneWatch).filter(ZoneWatch.user_id == user_id, ZoneWatch.exchange == exchange).all()
    events = db.query(ZoneEvent).filter(ZoneEvent.user_id == user_id, ZoneEvent.exchange == exchange, ZoneEvent.at >= start, ZoneEvent.at < end).order_by(ZoneEvent.at).all()
    items: dict[tuple, dict] = {}
    for w in watches:
        items[(w.symbol, w.kind, float(w.lo), float(w.hi))] = {"symbol": w.symbol, "kind": w.kind, "role": w.role, "lo": float(w.lo), "hi": float(w.hi), "status": "untouched", "at": None, "extreme": None}
    for e in events:
        key = (e.symbol, e.kind, float(e.lo), float(e.hi))
        it = items.setdefault(key, {"symbol": e.symbol, "kind": e.kind, "role": e.role, "lo": float(e.lo), "hi": float(e.hi), "status": "untouched", "at": None, "extreme": None})
        local = e.at.astimezone(tz).strftime("%H:%M")
        if e.event == "touch" and it["status"] == "untouched":
            it.update(status="tested", at=local, extreme=float(e.extreme) if e.extreme is not None else None)
        elif e.event in ("held", "broke", "inside"):
            it.update(status={"held": "held", "broke": "broke", "inside": "closed_inside"}[e.event], at=local, extreme=float(e.extreme) if e.extreme is not None else it["extreme"])
    return sorted(items.values(), key=lambda i: (i["symbol"], i["lo"]))


def morning_message(rows: list[dict], day: date) -> Optional[str]:
    """The person's zones for today, nearest first, each with how far the price is from it. None when they have none."""
    if not rows:
        return None
    lines = [f"🗺️ Your zones today · {day.strftime('%a')} {day.day} {day.strftime('%b')}"]
    for r in sorted(rows, key=lambda r: abs(r["distance_pct"]) if r.get("distance_pct") is not None else 1e9):
        dist = ""
        if r.get("distance_pct") is not None:
            side = "above" if r["distance_pct"] > 0 else "below"
            dist = f" · price {_num(r['ltp'])}, {abs(r['distance_pct']):.1f}% {side}" if abs(r["distance_pct"]) >= 0.05 else f" · price {_num(r['ltp'])}, right at it"
        lines.append(f"{'🟢' if r['role'] == 'support' else '🔴' if r['role'] == 'resistance' else '🟡'} {r['symbol']} {label(r['role'], r['kind'])} {band_text(r['lo'], r['hi'])}{dist}")
    lines += ["", "I will message you when price reaches one, and again at the candle close to say whether it held or broke."]
    return "\n".join(lines)


def morning_rows(db: Session, user_id: UUID, batch_quote: BatchQuote = _default_batch_quote) -> list[dict]:
    watches = db.query(ZoneWatch).filter(ZoneWatch.user_id == user_id).all()
    by_exchange: dict[str, set[str]] = {}
    for w in watches:
        by_exchange.setdefault(w.exchange, set()).add(w.symbol)
    quotes: dict[tuple[str, str], float] = {}
    for exchange, symbols in by_exchange.items():
        for sym, px in batch_quote(exchange, sorted(symbols)).items():
            if isinstance(px, (int, float)):
                quotes[(exchange, sym)] = float(px)
    rows = []
    for w in watches:
        lo, hi = float(w.lo), float(w.hi)
        ltp = quotes.get((w.exchange, w.symbol))
        dist = None
        if ltp is not None:
            ref = hi if ltp > hi else lo if ltp < lo else ltp
            dist = (ltp - ref) / ref * 100 if ref else None
        rows.append({"symbol": w.symbol, "kind": w.kind, "role": w.role, "lo": lo, "hi": hi, "ltp": ltp, "distance_pct": dist})
    return rows


def send_morning(db: Session, day: date, batch_quote: BatchQuote = _default_batch_quote) -> n.Tally:
    """Each person with zones gets one message listing them, once a day."""
    tally = n.Tally()
    user_ids = sorted({w.user_id for w in db.query(ZoneWatch).all()}, key=str)
    channels = _channels(db)
    for uid in user_ids:
        chat = channels.get(uid)
        text = morning_message(morning_rows(db, uid, batch_quote), day)
        if not chat or not text:
            tally.skipped += 1
            continue
        outcome = n.deliver(db, uid, chat, "zones", f"zones-morning:{day.isoformat()}", text)
        setattr(tally, outcome, getattr(tally, outcome) + 1)
    return tally
