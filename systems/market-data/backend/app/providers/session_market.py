"""How the market did in a session, for the post-session Telegram summary: index closes, the day's range, volatility. From Yahoo's public
chart feed (the same source the pre-market report uses), so it needs no broker token. NSE is read as daily bars and refuses a day the
market did not trade (a holiday has no bar for it); crypto trades round the clock, so it is read as the last 24 hours of hourly bars."""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from typing import Optional
from zoneinfo import ZoneInfo

import requests

from app.config import settings
from app.providers.premarket import YAHOO_CHART_URL, _HEADERS, _TIMEOUT

logger = logging.getLogger(__name__)

NSE_SYMBOLS = [("NIFTY", "^NSEI"), ("BANKNIFTY", "^NSEBANK"), ("India VIX", "^INDIAVIX")]
CRYPTO_SYMBOLS = [("BTC", "BTC-USD"), ("ETH", "ETH-USD")]
# MCX: the mini contracts this platform trades, read as their front-month future from Dhan (Yahoo has no MCX prices, only global futures)
MCX_UNDERLYINGS = ["GOLDM", "CRUDEOILM", "SILVERM", "NATGASMINI"]


def _chart(symbol: str, range_: str, interval: str) -> tuple[list[datetime], dict]:
    resp = requests.get(YAHOO_CHART_URL.format(symbol=symbol), params={"range": range_, "interval": interval}, headers=_HEADERS, timeout=_TIMEOUT)
    resp.raise_for_status()
    result = (resp.json().get("chart") or {}).get("result")
    if not result:
        raise ValueError("no data")
    ist = ZoneInfo(settings.timezone)
    stamps = [datetime.fromtimestamp(t, ist) for t in (result[0].get("timestamp") or [])]
    return stamps, result[0]["indicators"]["quote"][0]


def _row(label: str, last: float, prev: float, high: float, low: float) -> dict:
    span = high - low
    return {
        "label": label,
        "close": round(last, 2),
        "change_pct": round((last / prev - 1) * 100, 2) if prev else None,
        "high": round(high, 2),
        "low": round(low, 2),
        # Where it finished inside the range: 0 = at the low, 1 = at the high.
        "position": round((last - low) / span, 2) if span > 0 else 0.5,
    }


def _daily(label: str, symbol: str, day: Optional[date]) -> tuple[Optional[dict], Optional[date]]:
    stamps, q = _chart(symbol, "5d", "1d")
    bars = [(s.date(), o, h, l, c) for s, o, h, l, c in zip(stamps, q.get("open") or [], q.get("high") or [], q.get("low") or [], q.get("close") or []) if None not in (o, h, l, c)]
    if len(bars) < 2:
        raise ValueError("fewer than two daily bars")
    if day is not None and bars[-1][0] != day:
        return None, bars[-1][0]  # no bar for that day: a holiday, or the day has not finished
    d, _o, h, l, c = bars[-1]
    return _row(label, c, bars[-2][4], h, l), d


def fetch_nse(day: Optional[date] = None) -> Optional[dict]:
    """{day, rows} for the NSE session, or None when the market has no bar for `day` (a holiday). Without `day` it is the latest session."""
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [(label, pool.submit(_daily, label, sym, day)) for label, sym in NSE_SYMBOLS]
        rows, session = [], None
        for label, f in futures:
            try:
                row, d = f.result()
            except Exception as exc:
                logger.warning("session summary: %s failed: %s", label, exc)
                continue
            if label == "NIFTY":
                if row is None:
                    return None
                session = d
            if row is not None:
                rows.append(row)
    if session is None:
        raise RuntimeError("NIFTY could not be read")
    return {"day": session, "rows": rows}


def _last_24h(label: str, symbol: str) -> dict:
    stamps, q = _chart(symbol, "2d", "1h")
    bars = [(h, l, c) for h, l, c in zip(q.get("high") or [], q.get("low") or [], q.get("close") or []) if None not in (h, l, c)]
    if len(bars) < 25:
        raise ValueError("fewer than 25 hourly bars")
    window = bars[-24:]
    return _row(label, window[-1][2], bars[-25][2], max(b[0] for b in window), min(b[1] for b in window))


def _mcx_session(label: str, day: Optional[date]) -> tuple[Optional[dict], Optional[date]]:
    from datetime import timedelta

    from app.providers.router import get_provider

    provider = get_provider("MCX")
    resolved = provider.resolve_underlying(label)
    if resolved is None:
        raise ValueError("not resolved")
    end = day or datetime.now(ZoneInfo(settings.timezone)).date()
    candles = provider.get_candle_history(resolved.chart_symbol, "60min", end - timedelta(days=7), end)
    by_day: dict[date, list] = {}
    for c in candles:
        ts = c.timestamp if isinstance(c.timestamp, datetime) else datetime.fromisoformat(str(c.timestamp))
        by_day.setdefault(ts.astimezone(ZoneInfo(settings.timezone)).date(), []).append((ts, c))
    days = sorted(by_day)
    target = day if day is not None else (days[-1] if days else None)
    if target is None or target not in by_day:
        return None, days[-1] if days else None
    earlier = [d for d in days if d < target]
    if not earlier:
        raise ValueError("no earlier session to compare with")
    bars = [c for _, c in sorted(by_day[target], key=lambda t: t[0])]
    prev_close = sorted(by_day[earlier[-1]], key=lambda t: t[0])[-1][1].close
    return _row(label, bars[-1].close, prev_close, max(c.high for c in bars), min(c.low for c in bars)), target


def fetch_mcx(day: Optional[date] = None) -> Optional[dict]:
    """{day, rows} for the MCX session, or None when it did not trade on `day` (a holiday). Without `day` it is the latest session."""
    rows, session = [], None
    for label in MCX_UNDERLYINGS:
        try:
            row, d = _mcx_session(label, day)
        except Exception as exc:
            logger.warning("session summary: %s failed: %s", label, exc)
            continue
        if row is None:
            if label == MCX_UNDERLYINGS[0]:
                return None
            continue
        session = session or d
        rows.append(row)
    if not rows:
        raise RuntimeError("no MCX prices could be read")
    return {"day": session, "rows": rows}


def fetch_crypto(day: Optional[date] = None) -> dict:
    """{day, rows} for the last 24 hours of the crypto market."""
    rows = []
    for label, sym in CRYPTO_SYMBOLS:
        try:
            rows.append(_last_24h(label, sym))
        except Exception as exc:
            logger.warning("session summary: %s failed: %s", label, exc)
    if not rows:
        raise RuntimeError("no crypto prices could be read")
    return {"day": day or datetime.now(ZoneInfo(settings.timezone)).date(), "rows": rows}
