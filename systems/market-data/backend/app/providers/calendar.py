import logging
import threading
import time
from typing import Optional

import requests

from app.domain.models import EconomicEvent

logger = logging.getLogger(__name__)

CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"

# One currency per chart underlying - which macro releases actually move
# it. Gold, crude, and every crypto pair here are USD-priced, so USD
# releases (Fed, US CPI/NFP) are the direct driver. NIFTY/BANKNIFTY are
# INR-denominated, but Forex Factory's calendar only covers major forex
# currencies (confirmed live 2026-09-12: USD/EUR/JPY/GBP/AUD/CHF/CNY/NZD/
# CAD - zero INR rows in a full week's data) - INR would always come back
# empty, so these map to USD too: Fed/US macro is also the biggest single
# swing factor for Indian equity sentiment via FII flows, and it's a far
# more useful signal than an empty list.
_CURRENCY_FOR_UNDERLYING = {
    "NIFTY": "USD",
    "BANKNIFTY": "USD",
    "GOLDM": "USD",
    "CRUDEOILM": "USD",
    "BTCUSD": "USD",
    "ETHUSD": "USD",
    "SOLUSD": "USD",
}

SUPPORTED_UNDERLYINGS = set(_CURRENCY_FOR_UNDERLYING)

# The feed covers the current week and Forex Factory refreshes it through
# the day as events release (actual values populate live) - the
# faireconomy.media host enforces a documented, formal rate limit (2
# downloads/5min, confirmed live 2026-09-12: a proper 429 "Rate Limited"
# page, not a silent block or CAPTCHA wall), so this TTL keeps every
# chart tab/underlying well under that regardless of traffic.
_CACHE_TTL_SECONDS = 30 * 60

_cache_lock = threading.Lock()
_cache: Optional[tuple[list[dict], float]] = None
_refresh_lock = threading.Lock()


def _fetch() -> list[dict]:
    resp = requests.get(
        CALENDAR_URL,
        timeout=15,
        headers={"User-Agent": "Mozilla/5.0 (compatible; algo-trading-calendar/1.0)"},
    )
    resp.raise_for_status()
    return resp.json()


def _cached_rows(ttl: float) -> Optional[list[dict]]:
    with _cache_lock:
        if _cache is None:
            return None
        rows, fetched_at = _cache
        if (time.monotonic() - fetched_at) >= ttl:
            return None
        return rows


def _stale_rows() -> Optional[list[dict]]:
    with _cache_lock:
        return _cache[0] if _cache else None


def _refresh() -> None:
    global _cache
    with _refresh_lock:
        if _cached_rows(_CACHE_TTL_SECONDS) is not None:
            return  # someone else refreshed it while we waited for the lock
        try:
            rows = _fetch()
        except Exception as exc:
            logger.warning("Forex Factory calendar refresh failed: %s", exc)
            return
        with _cache_lock:
            _cache = (rows, time.monotonic())


def get_events(underlying: str) -> list[EconomicEvent]:
    """Cached, currency-filtered economic calendar for one chart
    underlying - see module comments for the source/cadence. Falls back
    to a stale cached copy (if any) rather than raising when a refresh
    fails, so a transient hiccup doesn't blank the Events tab."""
    if underlying not in SUPPORTED_UNDERLYINGS:
        raise ValueError(f"no calendar mapping configured for '{underlying}'")

    rows = _cached_rows(_CACHE_TTL_SECONDS)
    if rows is None:
        _refresh()
        rows = _cached_rows(_CACHE_TTL_SECONDS) or _stale_rows()
    if rows is None:
        raise RuntimeError("economic calendar is temporarily unavailable - try again shortly")

    currency = _CURRENCY_FOR_UNDERLYING[underlying]
    events = []
    for row in rows:
        if row.get("country") != currency:
            continue
        impact = (row.get("impact") or "").strip().lower()
        if impact not in ("medium", "high", "holiday"):
            continue  # "low" is mostly noise - minor regional data, filler rows
        events.append(
            EconomicEvent(
                title=row.get("title") or "",
                currency=currency,
                timestamp=row.get("date") or "",
                impact=impact,
                forecast=row.get("forecast") or None,
                previous=row.get("previous") or None,
                actual=row.get("actual") or None,
            )
        )
    events.sort(key=lambda e: e.timestamp)
    return events
