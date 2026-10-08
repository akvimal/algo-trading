"""Raw inputs for the morning pre-market bias (app/domain/premarket_report.py): the US close, crude, USDINR, US and
India 10Y yields, the Indian ADRs and GIFT Nifty. Each input has its own small fetcher so one source failing costs
that input (it comes back `ok=False` with a reason), never the whole report.

Sources, chosen by a live feasibility test (2026-10-06): Yahoo's public chart endpoint carries everything except GIFT
Nifty and the India 10Y, which only TradingView's public scanner carried (moneycontrol, NSE's own site and Investing.com
all returned 403/404 to a server). Both are unofficial, undocumented endpoints - fine for one call per morning, but
worth revisiting (a licensed feed) before this becomes a paid feature.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional
from zoneinfo import ZoneInfo

import requests

from app.config import settings

logger = logging.getLogger(__name__)

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
TRADINGVIEW_SCAN_URL = "https://scanner.tradingview.com/global/scan"
_TIMEOUT = 15


@dataclass
class RawInput:
    key: str
    label: str
    group: str  # us | commodity | currency | yield | adr | india
    ok: bool = False
    value: Optional[float] = None
    # Percent change for prices; for the two yields the move in basis points instead (see `unit`).
    change: Optional[float] = None
    unit: str = "pct"  # "pct" | "bp" | "pt" (index points, the crypto Fear & Greed index)
    source: str = ""
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "key": self.key, "label": self.label, "group": self.group, "ok": self.ok, "value": self.value,
            "change": self.change, "unit": self.unit, "source": self.source, "error": self.error,
        }


# key, label, group, Yahoo symbol
YAHOO_INPUTS = [
    ("sp500", "S&P 500", "us", "^GSPC"),
    ("dow", "Dow Jones", "us", "^DJI"),
    ("nasdaq", "Nasdaq", "us", "^IXIC"),
    ("brent", "Brent crude", "commodity", "BZ=F"),
    ("wti", "WTI crude", "commodity", "CL=F"),
    ("usdinr", "USD/INR", "currency", "INR=X"),
    ("us10y", "US 10Y yield", "yield", "^TNX"),
    ("adr_infy", "Infosys ADR", "adr", "INFY"),
    ("adr_hdb", "HDFC Bank ADR", "adr", "HDB"),
    ("adr_wit", "Wipro ADR", "adr", "WIT"),
    ("adr_ibn", "ICICI Bank ADR", "adr", "IBN"),
    ("adr_rdy", "Dr Reddy's ADR", "adr", "RDY"),
]


def _yahoo_series(symbol: str) -> list[tuple[date, float]]:
    """(IST date, close) per bar, oldest first, with null bars dropped."""
    resp = requests.get(YAHOO_CHART_URL.format(symbol=symbol), params={"range": "5d", "interval": "1d"}, headers=_HEADERS, timeout=_TIMEOUT)
    resp.raise_for_status()
    result = (resp.json().get("chart") or {}).get("result")
    if not result:
        raise ValueError("no data")
    ist = ZoneInfo(settings.timezone)
    stamps = result[0].get("timestamp") or []
    closes = result[0]["indicators"]["quote"][0].get("close") or []
    return [(datetime.fromtimestamp(t, ist).date(), c) for t, c in zip(stamps, closes) if c is not None]


def _fetch_yahoo(key: str, label: str, group: str, symbol: str) -> RawInput:
    out = RawInput(key=key, label=label, group=group, source="yahoo", unit="bp" if key == "us10y" else "pct")
    try:
        series = _yahoo_series(symbol)
        if len(series) < 2:
            raise ValueError("fewer than two daily bars")
        last, prev = series[-1][1], series[-2][1]
        out.value = round(last, 4)
        # ^TNX quotes the yield in percent, so a 0.034 move is 3.4 basis points.
        out.change = round((last - prev) * 100, 2) if out.unit == "bp" else round((last / prev - 1) * 100, 3)
        out.ok = True
    except Exception as exc:
        out.error = f"{type(exc).__name__}: {exc}"[:200]
        logger.warning("premarket: yahoo %s failed: %s", symbol, exc)
    return out


def _fetch_nifty_reference() -> RawInput:
    """Nifty's last COMPLETED close (the most recent bar dated before today in IST) - what the GIFT Nifty gap is
    measured against. During the session Yahoo's newest bar is today's partial one, so it must be skipped."""
    out = RawInput(key="nifty_close", label="Nifty last close", group="india", source="yahoo")
    try:
        today = datetime.now(ZoneInfo(settings.timezone)).date()
        earlier = [c for d, c in _yahoo_series("^NSEI") if d < today]
        if not earlier:
            raise ValueError("no completed session in range")
        out.value, out.ok = round(earlier[-1], 2), True
    except Exception as exc:
        out.error = f"{type(exc).__name__}: {exc}"[:200]
        logger.warning("premarket: nifty reference failed: %s", exc)
    return out


def _fetch_tradingview() -> list[RawInput]:
    wanted = [
        ("gift_nifty", "GIFT Nifty", "india", "NSEIX:NIFTY1!", "pct"),
        ("in10y", "India 10Y yield", "yield", "TVC:IN10Y", "bp"),
    ]
    outs = [RawInput(key=k, label=lbl, group=g, source="tradingview", unit=u) for k, lbl, g, _, u in wanted]
    try:
        resp = requests.post(
            TRADINGVIEW_SCAN_URL,
            headers={"User-Agent": _HEADERS["User-Agent"], "Content-Type": "application/json"},
            json={"symbols": {"tickers": [w[3] for w in wanted]}, "columns": ["close", "change", "change_abs"]},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = {r["s"]: r["d"] for r in resp.json().get("data", [])}
        for out, (_, _, _, ticker, unit) in zip(outs, wanted):
            d = rows.get(ticker)
            if not d or d[0] is None:
                out.error = "not returned by TradingView"
                continue
            out.value = round(d[0], 4)
            if unit == "bp":
                out.change = round(d[2] * 100, 2) if d[2] is not None else None
            else:
                out.change = round(d[1], 3) if d[1] is not None else None
            out.ok = out.change is not None
            if not out.ok:
                out.error = "no change figure"
    except Exception as exc:
        for out in outs:
            out.error = f"{type(exc).__name__}: {exc}"[:200]
        logger.warning("premarket: tradingview failed: %s", exc)
    return outs


def fetch_inputs() -> list[RawInput]:
    """Every input, fetched in parallel. Never raises; a failed input is returned with `ok=False`."""
    with ThreadPoolExecutor(max_workers=8) as pool:
        yahoo_futs = [pool.submit(_fetch_yahoo, *spec) for spec in YAHOO_INPUTS]
        ref_fut = pool.submit(_fetch_nifty_reference)
        tv_fut = pool.submit(_fetch_tradingview)
        inputs = [f.result() for f in yahoo_futs] + [ref_fut.result()] + tv_fut.result()
    return _gift_as_gap(inputs)


def _gift_as_gap(inputs: list[RawInput]) -> list[RawInput]:
    """GIFT Nifty's own quoted change is against ITS previous close, which is not what the morning read cares about: the
    gap against Nifty's last completed close is. Show that number on the GIFT row so the card, the model and the rules
    all quote the same figure; when Nifty's close is unavailable the row keeps the feed's own change."""
    by_key = {i.key: i for i in inputs}
    gift, ref = by_key.get("gift_nifty"), by_key.get("nifty_close")
    if gift and ref and gift.ok and ref.ok and gift.value and ref.value:
        gift.change = round((gift.value / ref.value - 1) * 100, 3)
        gift.label = "GIFT Nifty vs last close"
    return inputs
