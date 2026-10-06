"""India's slow-moving macro backdrop for the pre-market report: the latest inflation, industrial production, GDP,
policy rate, CRR and FX reserves prints, and the RBI's recent policy-related releases and speeches.

Why these sources (live feasibility test, 2026-10-06): TradingView's public scanner serves its `ECONOMICS:` series with the
latest value, the change from the previous print and the period it covers (what the other candidates - MOSPI's own CPI site
and API, FRED, Trading Economics' guest key - either could not be reached from a server or had been shut). RBI's own RSS
feeds (press releases, speeches) are reachable. The scanner has no forecast and no next-release date, so this says what the
numbers ARE and how they moved, not what is due.

Both are unofficial or best-effort feeds; each is fetched on its own, so one failing leaves the other (and the rest of the
report) intact.
"""

from __future__ import annotations

import html
import logging
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional
from xml.etree import ElementTree

import requests

logger = logging.getLogger(__name__)

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
TRADINGVIEW_SCAN_URL = "https://scanner.tradingview.com/global/scan"
_TIMEOUT = 15

# key, label, TradingView symbol, unit ("pct" = percent or percent a year, "usd_bn" = US$ billion)
INDICATORS = [
    ("cpi", "Inflation (CPI, YoY)", "ECONOMICS:INIRYY", "pct"),
    ("iip", "Industrial production (IIP, YoY)", "ECONOMICS:INIPYY", "pct"),
    ("gdp", "GDP growth (YoY)", "ECONOMICS:INGDPYY", "pct"),
    ("repo", "RBI repo rate", "ECONOMICS:ININTR", "pct"),
    ("crr", "Cash reserve ratio", "ECONOMICS:INCRR", "pct"),
    ("fx_reserves", "FX reserves", "ECONOMICS:INFER", "usd_bn"),
]

RBI_FEEDS = [
    ("press release", "https://rbi.org.in/pressreleases_rss.xml"),
    ("speech", "https://rbi.org.in/speeches_rss.xml"),
]
# Policy-relevant press releases only: the feed is mostly daily operations notices and bank directions.
_POLICY_RE = re.compile(r"monetary policy|\bMPC\b|policy rate|repo rate|\bCRR\b|\bSLR\b|liquidity|inflation|governor|financial stability|statement on", re.I)
RBI_ITEMS_MAX = 5


def _period(ts) -> Optional[str]:
    try:
        return datetime.fromtimestamp(int(ts), timezone.utc).date().isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def fetch_indicators() -> list[dict]:
    """One row per indicator, in INDICATORS order. A row that could not be read has ok=False and an error."""
    rows = [{"key": k, "label": lbl, "unit": u, "ok": False, "value": None, "previous": None, "change": None, "period": None, "error": None} for k, lbl, _, u in INDICATORS]
    try:
        resp = requests.post(
            TRADINGVIEW_SCAN_URL,
            headers={"User-Agent": _UA, "Content-Type": "application/json"},
            json={"symbols": {"tickers": [t for _, _, t, _ in INDICATORS]}, "columns": ["close", "change_abs", "time"]},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        by_symbol = {r["s"]: r["d"] for r in resp.json().get("data", [])}
    except Exception as exc:
        logger.warning("macro: indicator fetch failed: %s", exc)
        for row in rows:
            row["error"] = f"{type(exc).__name__}: {exc}"[:200]
        return rows
    for row, (_, _, symbol, unit) in zip(rows, INDICATORS):
        d = by_symbol.get(symbol)
        if not d or d[0] is None:
            row["error"] = "not returned by the feed"
            continue
        scale = 1e9 if unit == "usd_bn" else 1.0
        value = d[0] / scale
        change = d[1] / scale if d[1] is not None else None
        row.update(
            ok=True,
            value=round(value, 3),
            change=round(change, 3) if change is not None else None,
            previous=round(value - change, 3) if change is not None else None,
            period=_period(d[2]),
        )
    return rows


def _text(el: Optional[ElementTree.Element]) -> str:
    return (el.text or "").strip() if el is not None else ""


def parse_rbi_feed(xml: bytes, kind: str, policy_only: bool) -> list[dict]:
    items = []
    for item in ElementTree.fromstring(xml).iter("item"):
        # RBI titles carry inline markup (e.g. "13<sup>th</sup> SBI Banking...") and entities; show plain text.
        title = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", _text(item.find("title"))))).strip()
        if not title or (policy_only and not _POLICY_RE.search(title)):
            continue
        try:
            published = parsedate_to_datetime(_text(item.find("pubDate"))).isoformat()
        except (TypeError, ValueError):
            published = None
        items.append({"title": title, "url": _text(item.find("link")) or None, "published": published, "kind": kind})
    return items


def fetch_rbi() -> list[dict]:
    """The newest policy-related RBI releases and speeches, newest first. A feed that fails is skipped."""
    items: list[dict] = []
    for kind, url in RBI_FEEDS:
        try:
            resp = requests.get(url, headers={"User-Agent": _UA}, timeout=_TIMEOUT)
            resp.raise_for_status()
            # Speeches are all relevant (a Governor's address is the policy signal); press releases need filtering.
            items += parse_rbi_feed(resp.content, kind, policy_only=(kind == "press release"))
        except Exception as exc:
            logger.warning("macro: RBI %s feed failed: %s", kind, exc)
    items.sort(key=lambda i: i["published"] or "", reverse=True)
    return items[:RBI_ITEMS_MAX]


def derived(indicators: list[dict], india_10y: Optional[float]) -> dict:
    """What the prints imply for bonds. real_rate = repo - CPI (the policy rate after inflation); spread_10y_repo = the
    India 10Y yield above the repo rate (how much term premium the bond market is asking). None when an input is missing."""
    by = {i["key"]: i for i in indicators if i["ok"]}
    repo, cpi = by.get("repo"), by.get("cpi")
    return {
        "real_rate": round(repo["value"] - cpi["value"], 2) if repo and cpi else None,
        "spread_10y_repo": round(india_10y - repo["value"], 2) if repo and india_10y is not None else None,
        "india_10y": india_10y,
    }


def fetch_macro(india_10y: Optional[float] = None) -> dict:
    """The whole backdrop. Never raises."""
    indicators = fetch_indicators()
    return {"indicators": indicators, "derived": derived(indicators, india_10y), "rbi": fetch_rbi()}
