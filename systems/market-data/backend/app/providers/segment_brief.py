"""Raw overnight/24-hour inputs for the MCX and crypto market briefs (app/domain/segment_brief.py) - the equivalents of
app/providers/premarket.py's NSE inputs. Same RawInput shape and the same Yahoo public chart endpoint, so one source
failing costs that input (`ok=False` with a reason), never the whole brief.

NSE here is the in-session pulse (the morning report is app/providers/premarket.py). MCX is read through its global drivers (COMEX gold/silver/copper, Brent/WTI, Henry Hub gas, the dollar index, USD/INR,
the US 10Y): MCX prices follow them, and a weaker rupee lifts the rupee price on top. Crypto trades 24/7, so "the move"
is today's bar against yesterday's close, with US equity futures, the dollar index, VIX and the Fear & Greed index for
the risk backdrop. Unofficial public endpoints, like the NSE inputs - fine for an on-demand read cached for half an
hour, worth a licensed feed before this is a paid feature.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import requests

from app.providers.premarket import RawInput, YAHOO_CHART_URL, _HEADERS, _TIMEOUT, _fetch_yahoo

logger = logging.getLogger(__name__)

FEAR_GREED_URL = "https://api.alternative.me/fng/"

# key, label, group, Yahoo symbol
MCX_INPUTS = [
    ("gold", "Gold (COMEX)", "metals", "GC=F"),
    ("silver", "Silver (COMEX)", "metals", "SI=F"),
    ("copper", "Copper (COMEX)", "metals", "HG=F"),
    ("brent", "Brent crude", "energy", "BZ=F"),
    ("wti", "WTI crude", "energy", "CL=F"),
    ("natgas", "Natural gas (Henry Hub)", "energy", "NG=F"),
    ("dxy", "US dollar index", "macro", "DX-Y.NYB"),
    ("usdinr", "USD/INR", "macro", "INR=X"),
    ("us10y", "US 10Y yield", "macro", "^TNX"),
]

CRYPTO_INPUTS = [
    ("btc", "Bitcoin", "crypto", "BTC-USD"),
    ("eth", "Ether", "crypto", "ETH-USD"),
    ("sol", "Solana", "crypto", "SOL-USD"),
    ("nasdaq_fut", "Nasdaq futures", "risk", "NQ=F"),
    ("sp500", "S&P 500", "risk", "^GSPC"),
    ("vix", "VIX", "risk", "^VIX"),
    ("dxy", "US dollar index", "macro", "DX-Y.NYB"),
    ("us10y", "US 10Y yield", "macro", "^TNX"),
]

# The in-session NSE "market pulse": how the indices and sectors are moving against the previous close, and India VIX.
# Read from Yahoo's quote metadata (live price vs previous close): sector indices have no daily-bar history there.
NSE_PULSE_INPUTS = [
    ("nifty", "Nifty 50", "index", "^NSEI"),
    ("banknifty", "Bank Nifty", "index", "^NSEBANK"),
    ("indiavix", "India VIX", "risk", "^INDIAVIX"),
    ("sec_it", "Nifty IT", "sector", "^CNXIT"),
    ("sec_fin", "Nifty Financial Services", "sector", "^CNXFIN"),
    ("sec_auto", "Nifty Auto", "sector", "^CNXAUTO"),
    ("sec_fmcg", "Nifty FMCG", "sector", "^CNXFMCG"),
    ("sec_metal", "Nifty Metal", "sector", "^CNXMETAL"),
    ("sec_pharma", "Nifty Pharma", "sector", "^CNXPHARMA"),
    ("sec_energy", "Nifty Energy", "sector", "^CNXENERGY"),
]

_INPUTS = {"MCX": MCX_INPUTS, "CRYPTO": CRYPTO_INPUTS, "NSE": NSE_PULSE_INPUTS}


def _fetch_yahoo_quote(key: str, label: str, group: str, symbol: str) -> RawInput:
    """The live price against the previous close, from the chart response's own metadata. Daily-bar history is empty for
    most NSE sector indices on Yahoo, but every index carries these two fields."""
    out = RawInput(key=key, label=label, group=group, source="yahoo")
    try:
        resp = requests.get(YAHOO_CHART_URL.format(symbol=symbol), params={"range": "1d", "interval": "5m"}, headers=_HEADERS, timeout=_TIMEOUT)
        resp.raise_for_status()
        result = (resp.json().get("chart") or {}).get("result")
        if not result:
            raise ValueError("no data")
        meta = result[0].get("meta") or {}
        price, prev = meta.get("regularMarketPrice"), meta.get("previousClose") or meta.get("chartPreviousClose")
        if not price or not prev:
            raise ValueError("no live price or previous close")
        out.value = round(price, 4)
        out.change = round((price / prev - 1) * 100, 3)
        out.ok = True
    except Exception as exc:
        out.error = f"{type(exc).__name__}: {exc}"[:200]
        logger.warning("segment brief: yahoo %s failed: %s", symbol, exc)
    return out


def _fetch_fear_greed() -> RawInput:
    out = RawInput(key="fear_greed", label="Crypto Fear & Greed", group="risk", source="alternative.me", unit="pt")
    try:
        resp = requests.get(FEAR_GREED_URL, params={"limit": 2}, headers=_HEADERS, timeout=_TIMEOUT)
        resp.raise_for_status()
        rows = resp.json().get("data") or []
        if len(rows) < 2:
            raise ValueError("fewer than two readings")
        today, yesterday = float(rows[0]["value"]), float(rows[1]["value"])
        out.value, out.change, out.ok = today, round(today - yesterday, 1), True
    except Exception as exc:
        out.error = f"{type(exc).__name__}: {exc}"[:200]
        logger.warning("segment brief: fear & greed failed: %s", exc)
    return out


def fetch_inputs(segment: str) -> list[RawInput]:
    """Every input for the segment, fetched in parallel. Never raises; a failed input comes back with `ok=False`."""
    specs = _INPUTS[segment]
    with ThreadPoolExecutor(max_workers=8) as pool:
        fetch = _fetch_yahoo_quote if segment == "NSE" else _fetch_yahoo
        futs = [pool.submit(fetch, *spec) for spec in specs]
        fg: Optional[object] = pool.submit(_fetch_fear_greed) if segment == "CRYPTO" else None
        inputs = [f.result() for f in futs]
        if fg is not None:
            inputs.append(fg.result())
    return inputs
