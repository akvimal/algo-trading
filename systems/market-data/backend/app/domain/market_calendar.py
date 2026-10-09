"""The Markets panel's Calendar tab: what is scheduled in the next few days for one market, from four layers merged into one
list, each with its own source:

- global macro (the Fed, US CPI, jobs ...) from the Forex Factory weekly feed (app/providers/calendar.py) - every market;
- India: the RBI policy decision, MoSPI's CPI / IIP / GDP releases and exchange holidays, from a small hand-maintained file
  (app/data/india_calendar.json - dates verified against the RBI, MoSPI and the exchanges, see that file) - NSE and MCX;
- NSE F&O expiry days, computed from the exchange's rule (every NSE index and stock contract expires on a Tuesday, the
  last Tuesday of the month for the monthlies, moved to the previous trading day when that is a holiday);
- crypto options expiries (Fridays), from Delta Exchange's live contract list.

Nothing here is a trade signal. Anything that could not be included (a feed down, MCX expiries, dates past the file's end) is
named in `notes`, so a missing row is never mistaken for "nothing is scheduled".
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Literal, Optional
from zoneinfo import ZoneInfo

from pydantic import BaseModel

from app.config import settings
from app.providers import calendar as global_calendar
from app.providers.router import get_provider

logger = logging.getLogger(__name__)

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "india_calendar.json"
SEGMENTS = ("NSE", "MCX", "CRYPTO")
# Any chart symbol of the market works for the global feed (every one of them maps to USD releases).
_GLOBAL_UNDERLYING = {"NSE": "NIFTY", "MCX": "GOLDM", "CRYPTO": "BTCUSD"}

Kind = Literal["global", "rbi", "data", "holiday", "expiry"]
Impact = Literal["high", "medium", "low"]


class CalendarEvent(BaseModel):
    date: date
    time: Optional[str] = None  # "HH:MM" IST; None = no published time / all day
    title: str
    kind: Kind
    impact: Impact
    detail: Optional[str] = None
    forecast: Optional[str] = None
    previous: Optional[str] = None
    actual: Optional[str] = None


class UpcomingCalendar(BaseModel):
    segment: str
    start: date
    end: date  # inclusive
    events: list[CalendarEvent]
    notes: list[str]


@lru_cache(maxsize=1)
def _static() -> dict:
    return json.loads(DATA_FILE.read_text(encoding="utf-8"))


def _d(iso: str) -> date:
    return date.fromisoformat(iso)


def _next_working_day(d: date) -> date:
    """MoSPI: a release that falls on a holiday goes out on the next working day (weekends are the holidays known here)."""
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def _nse_closed_days() -> set[date]:
    return {_d(h["date"]) for h in _static()["holidays"] if h["nse"] == "closed"}


def _previous_trading_day(d: date, closed: set[date]) -> date:
    while d.weekday() >= 5 or d in closed:
        d -= timedelta(days=1)
    return d


def _last_tuesday(year: int, month: int) -> date:
    d = date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)
    while d.weekday() != 1:
        d -= timedelta(days=1)
    return d


def _nse_expiries(start: date, end: date) -> list[CalendarEvent]:
    closed = _nse_closed_days()
    out: list[CalendarEvent] = []
    t = start - timedelta(days=7)
    while t.weekday() != 1:
        t += timedelta(days=1)
    while t <= end + timedelta(days=7):
        actual = _previous_trading_day(t, closed)
        if start <= actual <= end:
            monthly = t == _last_tuesday(t.year, t.month)
            out.append(
                CalendarEvent(
                    date=actual,
                    title="Monthly F&O expiry: Nifty, Bank Nifty, Fin Nifty, Midcap Nifty and stock options" if monthly else "Nifty weekly options expiry",
                    kind="expiry",
                    impact="high" if monthly else "medium",
                    detail=f"Moved from Tuesday {t:%d %b}, an exchange holiday." if actual != t else None,
                )
            )
        t += timedelta(days=7)
    return out


def _holiday_events(segment: str, start: date, end: date) -> list[CalendarEvent]:
    out = []
    for h in _static()["holidays"]:
        d = _d(h["date"])
        if not start <= d <= end:
            continue
        status = h["nse"] if segment == "NSE" else h["mcx"]
        if status == "special":
            out.append(CalendarEvent(date=d, title=f"{h['name']}: special trading session", kind="holiday", impact="medium", detail=h.get("detail")))
        elif segment == "NSE":
            out.append(CalendarEvent(date=d, title=f"{h['name']}: NSE closed", kind="holiday", impact="high"))
        elif status == "closed":
            out.append(CalendarEvent(date=d, title=f"{h['name']}: MCX closed all day", kind="holiday", impact="high", detail="Confirm on mcxindia.com."))
        else:
            out.append(CalendarEvent(date=d, title=f"{h['name']}: MCX morning session closed, evening session open", kind="holiday", impact="medium", detail="Confirm on mcxindia.com."))
    return out


def _india_events(start: date, end: date) -> list[CalendarEvent]:
    data = _static()
    out = []
    for r in data["rbi_policy"]:
        d = _d(r["decision"])
        if start <= d <= end:
            out.append(CalendarEvent(date=d, title="RBI monetary policy decision", kind="rbi", impact="high", detail=f"MPC meeting {r['meeting']}."))
    for r in data["releases"]:
        published = _d(r["date"])
        d = _next_working_day(published)
        if start <= d <= end:
            out.append(
                CalendarEvent(
                    date=d,
                    title=r["name"],
                    kind="data",
                    impact="medium" if r["kind"] == "iip" else "high",
                    detail=f"Scheduled for {published:%a %d %b}; MoSPI releases on the next working day." if d != published else None,
                )
            )
    return out


def _global_events(segment: str, start: date, end: date) -> list[CalendarEvent]:
    tz = ZoneInfo(settings.timezone)
    out = []
    for e in global_calendar.get_events(_GLOBAL_UNDERLYING[segment]):
        if e.impact not in ("high", "medium"):
            continue  # the feed's own "holiday" rows are other countries' bank holidays: noise here
        try:
            when = datetime.fromisoformat(e.timestamp).astimezone(tz)
        except ValueError:
            continue
        if start <= when.date() <= end:
            out.append(
                CalendarEvent(
                    date=when.date(), time=when.strftime("%H:%M"), title=f"{e.currency}: {e.title}", kind="global", impact=e.impact,
                    forecast=e.forecast, previous=e.previous, actual=e.actual,
                )
            )
    return out


def _crypto_expiries(start: date, end: date) -> list[CalendarEvent]:
    expiries = get_provider("CRYPTO").get_expiry_list("BTCUSD") or []
    dates = sorted(_d(x) for x in expiries)
    out = []
    for d in dates:
        if d.weekday() != 4 or not start <= d <= end:
            continue  # Fridays only: the daily contracts would bury everything else
        monthly = not any(o.weekday() == 4 and o.month == d.month and o.year == d.year and o > d for o in dates) and d.day > 21
        out.append(CalendarEvent(date=d, title="BTC options monthly expiry" if monthly else "BTC options weekly expiry", kind="expiry", impact="medium" if monthly else "low"))
    return out


_IMPACT_ORDER = {"high": 0, "medium": 1, "low": 2}


def upcoming(segment: str, today: Optional[date] = None, days: int = 7) -> UpcomingCalendar:
    """Everything scheduled for `segment` from `today` for `days` days (today included)."""
    if segment not in SEGMENTS:
        raise ValueError(f"no calendar for '{segment}'")
    today = today or datetime.now(ZoneInfo(settings.timezone)).date()
    end = today + timedelta(days=days - 1)
    events: list[CalendarEvent] = []
    notes: list[str] = []

    try:
        events += _global_events(segment, today, end)
    except (RuntimeError, ValueError):
        notes.append("Global economic events (Fed, US data) are temporarily unavailable.")
    else:
        if end > today + timedelta(days=6 - today.weekday()):
            notes.append("Global economic events cover the current week only, so they stop at Sunday.")

    if segment in ("NSE", "MCX"):
        events += _india_events(today, end) + _holiday_events(segment, today, end)
        if end > _d(_static()["valid_until"]):
            notes.append(f"India holidays and releases are only listed to {_d(_static()['valid_until']):%d %b %Y}.")
    if segment == "NSE":
        events += _nse_expiries(today, end)
    elif segment == "MCX":
        notes.append("MCX contract expiry dates are not included yet.")
    else:
        try:
            events += _crypto_expiries(today, end)
        except Exception:
            logger.warning("calendar: crypto expiries unavailable", exc_info=True)
            notes.append("Crypto options expiries are temporarily unavailable.")
        else:
            notes.append("Only Friday (weekly and monthly) BTC options expiries are shown, not the daily ones.")

    events.sort(key=lambda e: (e.date, e.time is not None, e.time or "", _IMPACT_ORDER[e.impact], e.title))
    return UpcomingCalendar(segment=segment, start=today, end=end, events=events, notes=notes)
