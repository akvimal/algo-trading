import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import requests

from app.config import settings
from app.domain.models import NewsArticle

logger = logging.getLogger(__name__)

MARKETAUX_URL = "https://api.marketaux.com/v1/news/all"

# marketaux's crypto entities use a clean "CC:<TICKER>" symbol - one
# symbols= call covers all three underlyings at once.
_CRYPTO_SYMBOLS = {"BTCUSD": "CC:BTC", "ETHUSD": "CC:ETH", "SOLUSD": "CC:SOL"}

# NIFTY/BANKNIFTY (indices) and GOLDM/CRUDEOILM (MCX minis) have no clean
# marketaux entity - it covers global equities/crypto/forex, not Indian
# indices or commodity futures - so these go through its keyword `search`
# instead of `symbols=`, one call per underlying (looser relevance, but
# the only option marketaux offers for them).
_SEARCH_TERMS = {
    "NIFTY": "Nifty 50",
    "BANKNIFTY": "Bank Nifty",
    "GOLDM": "gold price",
    "CRUDEOILM": "crude oil price",
}

SUPPORTED_UNDERLYINGS = set(_CRYPTO_SYMBOLS) | set(_SEARCH_TERMS)

# marketaux's free tier is a hard 100 requests/day, account-wide - not a
# per-second rate limit like Dhan/Delta, so there's nothing to self-throttle
# here, just a daily budget to stay under. Crypto refreshes as ONE call
# covering all 3 symbols (worst case 48/day at this TTL); the 4 NSE/MCX
# searches can't be combined the same way (no confirmed multi-keyword OR),
# so that bucket refreshes 4x less often - both sized together to keep the
# combined worst case (~96/day) under quota with headroom.
_CRYPTO_TTL_SECONDS = 30 * 60
_SEARCH_TTL_SECONDS = 4 * _CRYPTO_TTL_SECONDS

_cache_lock = threading.Lock()
_cache: dict[str, tuple[list[NewsArticle], float]] = {}
# One refresh-in-flight lock per bucket, so several symbol tabs opening
# their News tab around the same moment on a cold cache trigger exactly
# one upstream call for that bucket, not one per underlying.
_crypto_refresh_lock = threading.Lock()
_search_refresh_lock = threading.Lock()


def _cache_get(underlying: str, ttl: float) -> Optional[list[NewsArticle]]:
    with _cache_lock:
        entry = _cache.get(underlying)
    if entry is None:
        return None
    articles, fetched_at = entry
    if (time.monotonic() - fetched_at) >= ttl:
        return None
    return articles


def _cache_stale(underlying: str) -> Optional[list[NewsArticle]]:
    """Whatever's cached for `underlying`, ignoring TTL - a fallback to
    show something rather than an error when a refresh fails."""
    with _cache_lock:
        entry = _cache.get(underlying)
    return entry[0] if entry else None


def _cache_set(underlying: str, articles: list[NewsArticle]) -> None:
    with _cache_lock:
        _cache[underlying] = (articles, time.monotonic())


def _fetch(params: dict) -> list[dict]:
    if not settings.marketaux_api_key:
        raise RuntimeError("Marketaux API key not configured - set MARKETAUX_API_KEY")
    resp = requests.get(
        MARKETAUX_URL,
        params={**params, "api_token": settings.marketaux_api_key, "language": "en"},
        timeout=15,
    )
    resp.raise_for_status()
    body = resp.json()
    if "error" in body:
        raise RuntimeError(f"marketaux error: {body['error'].get('message', body['error'])}")
    return body.get("data") or []


def _to_article(row: dict, entity_symbol: Optional[str]) -> NewsArticle:
    sentiment = None
    if entity_symbol:
        for ent in row.get("entities") or []:
            if ent.get("symbol") == entity_symbol:
                sentiment = ent.get("sentiment_score")
                break
    return NewsArticle(
        title=row.get("title") or "",
        url=row.get("url") or "",
        source=row.get("source") or "",
        published_at=row.get("published_at") or "",
        image_url=row.get("image_url"),
        sentiment_score=sentiment,
    )


def _refresh_crypto_bucket() -> None:
    with _crypto_refresh_lock:
        if _cache_get("BTCUSD", _CRYPTO_TTL_SECONDS) is not None:
            return  # someone else refreshed it while we waited for the lock
        try:
            rows = _fetch({"symbols": ",".join(_CRYPTO_SYMBOLS.values()), "sort": "published_desc", "limit": 50})
        except Exception as exc:
            logger.warning("marketaux crypto news refresh failed: %s", exc)
            return
        for underlying, entity_symbol in _CRYPTO_SYMBOLS.items():
            matched = [
                _to_article(row, entity_symbol)
                for row in rows
                if any(e.get("symbol") == entity_symbol for e in row.get("entities") or [])
            ]
            _cache_set(underlying, matched)


def _refresh_search_underlying(underlying: str) -> None:
    with _search_refresh_lock:
        if _cache_get(underlying, _SEARCH_TTL_SECONDS) is not None:
            return
        try:
            # A bare keyword search (no entity to match) otherwise skews
            # toward old high-relevance articles rather than recent ones -
            # confirmed live for "Nifty 50" (top hits were from 2021) even
            # with sort=published_desc. published_after biases the index
            # toward the last week instead.
            published_after = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M")
            rows = _fetch(
                {
                    "search": _SEARCH_TERMS[underlying],
                    "sort": "published_desc",
                    "published_after": published_after,
                    "limit": 20,
                }
            )
        except Exception as exc:
            logger.warning("marketaux news refresh failed for %s: %s", underlying, exc)
            return
        _cache_set(underlying, [_to_article(row, None) for row in rows])


def get_news(underlying: str) -> list[NewsArticle]:
    """Cached headline feed for one chart underlying - see the module
    docstring-equivalent comments above for the quota-driven bucketing.
    Falls back to a stale cached copy (if any) rather than raising when a
    refresh fails, so a transient marketaux hiccup doesn't blank the News
    tab; raises only when there's truly nothing to show yet."""
    if underlying not in SUPPORTED_UNDERLYINGS:
        raise ValueError(f"no news source configured for '{underlying}'")

    if underlying in _CRYPTO_SYMBOLS:
        cached = _cache_get(underlying, _CRYPTO_TTL_SECONDS)
        if cached is not None:
            return cached
        _refresh_crypto_bucket()
    else:
        cached = _cache_get(underlying, _SEARCH_TTL_SECONDS)
        if cached is not None:
            return cached
        _refresh_search_underlying(underlying)

    fresh = _cache_get(underlying, _CRYPTO_TTL_SECONDS if underlying in _CRYPTO_SYMBOLS else _SEARCH_TTL_SECONDS)
    if fresh is not None:
        return fresh
    stale = _cache_stale(underlying)
    if stale is not None:
        return stale
    raise RuntimeError("marketaux news is temporarily unavailable - try again shortly")
