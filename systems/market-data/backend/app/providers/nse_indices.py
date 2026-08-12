"""NSE index-constituent lists (e.g. "which stocks are in Nifty Bank") -
used by signal-generation to scope an in-house Strategy to a whole
universe of symbols instead of one. Not a QuoteProvider - these come from
NSE's own public archive, not Dhan, and there's no quote/candle concept
here at all, just membership lists.

Same "no database, cheap to rebuild on restart" shape as DhanProvider's
instrument-master sync (sync_instruments): a module-level dict guarded by
a lock, refreshed by the daily scheduler job (app/scheduler.py) plus once
on startup. Constituents only change on periodic index rebalancing, so
this is refreshed far less often than price data - same reasoning
trading-backtester's nse_index_client.py already uses for its own cache.
"""

import csv
import io
import logging
import threading
from typing import Optional

import requests

logger = logging.getLogger(__name__)

# NSE publishes one CSV per index under a fixed naming convention.
_INDEX_CSV_MAP = {
    "NIFTY50": "ind_nifty50list.csv",
    "NIFTYNEXT50": "ind_niftynext50list.csv",
    "NIFTY100": "ind_nifty100list.csv",
    "NIFTY200": "ind_nifty200list.csv",
    "NIFTY500": "ind_nifty500list.csv",
    "NIFTYMIDCAP100": "ind_niftymidcap100list.csv",
    "NIFTYMIDCAP150": "ind_niftymidcap150list.csv",
    "NIFTYSMALLCAP100": "ind_niftysmallcap100list.csv",
    "NIFTYSMALLCAP250": "ind_niftysmallcap250list.csv",
    "NIFTYBANK": "ind_niftybanklist.csv",
    "NIFTYIT": "ind_niftyitlist.csv",
    "NIFTYFINANCE": "ind_niftyfinancelist.csv",
}
NSE_ARCHIVES_BASE_URL = "https://nsearchives.nseindia.com"
# NSE's archive host rejects requests with no browser-like User-Agent.
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}

_lock = threading.Lock()
_cache: dict[str, list[str]] = {}


def sync_universes() -> dict:
    """Fetches every known index's constituent CSV and atomically swaps
    the cache. One index's fetch failing (network hiccup, NSE renamed a
    file) is logged and skipped rather than aborting the rest - the
    cache keeps whichever indices synced successfully, same defensive
    shape as DhanProvider's per-provider try/except in the scheduler."""
    fresh: dict[str, list[str]] = {}
    for key, csv_name in _INDEX_CSV_MAP.items():
        url = f"{NSE_ARCHIVES_BASE_URL}/content/indices/{csv_name}"
        try:
            resp = requests.get(url, headers=_HEADERS, timeout=30)
            resp.raise_for_status()
            reader = csv.DictReader(io.StringIO(resp.text))
            symbols = [row["Symbol"].strip() for row in reader if row.get("Symbol")]
            if not symbols:
                raise ValueError("no Symbol column / empty CSV")
            fresh[key] = symbols
        except Exception:
            logger.warning("could not sync universe %s from %s - skipping", key, url, exc_info=True)

    with _lock:
        _cache.update(fresh)

    logger.info("synced %d/%d NSE index universes", len(fresh), len(_INDEX_CSV_MAP))
    return {"synced": len(fresh), "total": len(_INDEX_CSV_MAP)}


def list_universes() -> list[str]:
    """Available universe keys - the full known set, not just whatever's
    synced so far, so the frontend's dropdown is populated even before
    the first sync completes."""
    return sorted(_INDEX_CSV_MAP)


def get_constituents(key: str) -> Optional[list[str]]:
    """None for an unknown key. Syncs inline if nothing has been synced
    yet at all (e.g. right after a restart, before the startup sync job
    has run) - mirrors DhanProvider's "sync on first use if never
    synced" fallback for resolve_underlying/get_lot_size."""
    normalized = key.upper()
    if normalized not in _INDEX_CSV_MAP:
        return None
    with _lock:
        already_synced = bool(_cache)
    if not already_synced:
        sync_universes()
    with _lock:
        return _cache.get(normalized)
