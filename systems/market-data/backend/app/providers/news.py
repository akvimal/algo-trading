import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import requests

from app.config import settings
from app.domain.models import NewsArticle, NewsDigest

logger = logging.getLogger(__name__)

MARKETAUX_URL = "https://api.marketaux.com/v1/news/all"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

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

# Plain-English instrument description for the AI prompt - the bare
# underlying code ("GOLDM") means nothing to a model with no other context.
_INSTRUMENT_LABELS = {
    "BTCUSD": "Bitcoin (BTC/USD)",
    "ETHUSD": "Ethereum (ETH/USD)",
    "SOLUSD": "Solana (SOL/USD)",
    "NIFTY": "the Nifty 50 index (Indian stock market benchmark)",
    "BANKNIFTY": "the Bank Nifty index (Indian banking-sector benchmark)",
    "GOLDM": "gold (MCX commodity futures)",
    "CRUDEOILM": "crude oil (MCX commodity futures)",
}

SUPPORTED_UNDERLYINGS = set(_CRYPTO_SYMBOLS) | set(_SEARCH_TERMS)

# marketaux's free tier is a hard 100 requests/day, account-wide - not a
# per-second rate limit like Dhan/Delta, so there's nothing to self-throttle
# here, just a daily budget to stay under. Crypto refreshes as ONE call
# covering all 3 symbols (worst case 48/day at this TTL); the 4 NSE/MCX
# searches can't be combined the same way (no confirmed multi-keyword OR),
# so that bucket refreshes 4x less often - both sized together to keep the
# combined worst case (~96/day) under quota with headroom. The OpenRouter
# analysis call rides the same cadence (one per underlying per refresh, not
# per request), so its cost stays proportional and trivial at Haiku pricing.
_CRYPTO_TTL_SECONDS = 30 * 60
_SEARCH_TTL_SECONDS = 4 * _CRYPTO_TTL_SECONDS

# How many of the freshest raw articles to actually hand to the AI - caps
# prompt size/cost regardless of how many marketaux returns.
_MAX_ARTICLES_FOR_AI = 20
_MAX_ARTICLES_IN_DIGEST = 8

_cache_lock = threading.Lock()
_cache: dict[str, tuple[NewsDigest, float]] = {}
# One refresh-in-flight lock per bucket, so several symbol tabs opening
# their News tab around the same moment on a cold cache trigger exactly
# one upstream marketaux call for that bucket, not one per underlying.
_crypto_refresh_lock = threading.Lock()
_search_refresh_lock = threading.Lock()

_DIGEST_SCHEMA = {
    "type": "object",
    "properties": {
        "bias": {"type": "string", "enum": ["bullish", "bearish", "neutral"]},
        "bias_reason": {"type": "string", "description": "One sentence justifying the bias."},
        "digest": {"type": "string", "description": "2-3 sentences on what's driving this instrument right now."},
        "articles": {
            "type": "array",
            "maxItems": _MAX_ARTICLES_IN_DIGEST,
            "description": "Only the articles genuinely relevant to this instrument's near-term trend, most relevant first.",
            "items": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Echo the article's url exactly as given."},
                    "relevance_score": {"type": "integer", "description": "0-100, likely impact on near-term trend."},
                    "why": {"type": "string", "description": "One sentence on why this matters for the trend."},
                },
                "required": ["url", "relevance_score", "why"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["bias", "bias_reason", "digest", "articles"],
    "additionalProperties": False,
}


def _cache_get(underlying: str, ttl: float) -> Optional[NewsDigest]:
    with _cache_lock:
        entry = _cache.get(underlying)
    if entry is None:
        return None
    digest, fetched_at = entry
    if (time.monotonic() - fetched_at) >= ttl:
        return None
    return digest


def _cache_stale(underlying: str) -> Optional[NewsDigest]:
    """Whatever's cached for `underlying`, ignoring TTL - a fallback to
    show something rather than an error when a refresh fails."""
    with _cache_lock:
        entry = _cache.get(underlying)
    return entry[0] if entry else None


def _cache_set(underlying: str, digest: NewsDigest) -> None:
    with _cache_lock:
        _cache[underlying] = (digest, time.monotonic())


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


def _entity_sentiment(row: dict, entity_symbol: Optional[str]) -> Optional[float]:
    if not entity_symbol:
        return None
    for ent in row.get("entities") or []:
        if ent.get("symbol") == entity_symbol:
            return ent.get("sentiment_score")
    return None


def _to_article(row: dict, entity_symbol: Optional[str]) -> NewsArticle:
    return NewsArticle(
        title=row.get("title") or "",
        url=row.get("url") or "",
        source=row.get("source") or "",
        published_at=row.get("published_at") or "",
        image_url=row.get("image_url"),
        sentiment_score=_entity_sentiment(row, entity_symbol),
    )


def _fallback_digest(rows: list[dict], entity_symbol: Optional[str], reason: str) -> NewsDigest:
    """No AI analysis available (key unset or the call failed) - the raw,
    unfiltered, unscored marketaux headlines are still useful on their own."""
    return NewsDigest(
        bias="neutral",
        bias_reason=reason,
        digest=reason,
        articles=[_to_article(row, entity_symbol) for row in rows[:_MAX_ARTICLES_IN_DIGEST]],
    )


def _analyze_via_ai(underlying: str, rows: list[dict], entity_symbol: Optional[str]) -> NewsDigest:
    """Runs the raw marketaux headlines for one underlying through
    OpenRouter (see app/config.py's openrouter_model, default a cheap/fast
    Haiku) to get a trend-relevance digest: an overall bullish/bearish/
    neutral read plus the individual articles filtered down to the ones
    that actually matter, each scored 0-100 with a one-line reason. Runs
    once per cache refresh (not per request) - see the module-level TTL
    comments for the cadence this rides on. Degrades to the plain
    unscored headline list (never raises) so a missing key or a flaky
    OpenRouter call doesn't blank the News tab."""
    if not rows:
        return _fallback_digest(rows, entity_symbol, "No recent news found.")
    if not settings.openrouter_api_key:
        return _fallback_digest(rows, entity_symbol, "AI analysis not configured - set OPENROUTER_API_KEY.")

    candidates = rows[:_MAX_ARTICLES_FOR_AI]
    by_url = {row.get("url"): row for row in candidates if row.get("url")}
    articles_payload = [
        {
            "url": row.get("url"),
            "title": row.get("title"),
            "summary": row.get("description") or row.get("snippet") or "",
            "source": row.get("source"),
            "published_at": row.get("published_at"),
            "marketaux_sentiment": _entity_sentiment(row, entity_symbol),
        }
        for row in candidates
    ]
    instrument_label = _INSTRUMENT_LABELS.get(underlying, underlying)

    try:
        resp = requests.post(
            OPENROUTER_URL,
            headers={"Authorization": f"Bearer {settings.openrouter_api_key}", "Content-Type": "application/json"},
            json={
                "model": settings.openrouter_model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are a financial news analyst. You'll be given recent headlines about one "
                            "trading instrument. Filter out anything not genuinely relevant to its near-term "
                            "price trend (unrelated topics, generic listicles, opinion pieces with no market "
                            "signal), score what's left 0-100 by likely trend impact, and give an overall "
                            "bullish/bearish/neutral bias with a one-line reason and a short digest. Base this "
                            "only on the headlines/summaries given - never invent facts, prices, or events not "
                            "present in them."
                        ),
                    },
                    {
                        "role": "user",
                        "content": f"Instrument: {instrument_label}\n\nHeadlines (JSON):\n{json.dumps(articles_payload)}",
                    },
                ],
                "response_format": {"type": "json_schema", "json_schema": {"name": "news_digest", "strict": True, "schema": _DIGEST_SCHEMA}},
            },
            timeout=30,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        parsed = content if isinstance(content, dict) else json.loads(content)

        scored_articles = []
        for entry in parsed.get("articles") or []:
            row = by_url.get(entry.get("url"))
            if row is None:
                continue  # AI referenced a url we didn't give it - skip rather than fabricate a row
            article = _to_article(row, entity_symbol)
            article.relevance_score = entry.get("relevance_score")
            article.why = entry.get("why")
            scored_articles.append(article)

        return NewsDigest(
            bias=parsed["bias"],
            bias_reason=parsed["bias_reason"],
            digest=parsed["digest"],
            articles=scored_articles,
        )
    except Exception as exc:
        logger.warning("OpenRouter news analysis failed for %s: %s", underlying, exc)
        return _fallback_digest(rows, entity_symbol, "AI analysis temporarily unavailable - showing raw headlines.")


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
            matched = [row for row in rows if any(e.get("symbol") == entity_symbol for e in row.get("entities") or [])]
            _cache_set(underlying, _analyze_via_ai(underlying, matched, entity_symbol))


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
        _cache_set(underlying, _analyze_via_ai(underlying, rows, None))


def get_news(underlying: str) -> NewsDigest:
    """Cached AI trend-relevance digest for one chart underlying - see the
    module-level comments above for the marketaux quota-driven bucketing
    and the OpenRouter analysis layered on top. Falls back to a stale
    cached copy (if any) rather than raising when a refresh fails, so a
    transient hiccup doesn't blank the News tab; raises only when there's
    truly nothing to show yet."""
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
    raise RuntimeError("news is temporarily unavailable - try again shortly")
