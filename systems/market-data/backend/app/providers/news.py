import json
import logging
import re
import threading
import time
from email.utils import parsedate_to_datetime
from typing import Optional
from xml.etree import ElementTree

import requests

from app.adapters.db.models import NewsHistory
from app.adapters.db.session import SessionLocal
from app.config import settings
from app.domain.models import NewsArticle, NewsDigest

logger = logging.getLogger(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# Plain publisher RSS feeds - free, no key, no rate limit, and each is
# already updated within minutes-to-hours (confirmed live 2026-09-12).
# Deliberately NOT Google News' RSS search: its own feed states it's
# "made available solely for... personal, non-commercial use... any other
# use is expressly prohibited" - out of scope for an automated backend
# feature regardless of cost. marketaux/CryptoPanic were considered too
# (see docs/architecture.md's news-tab writeup) but these need no signup
# and no per-day quota to manage at all.
_CRYPTO_FEEDS = {
    "https://www.coindesk.com/arc/outboundfeeds/rss/": "CoinDesk",
    "https://cointelegraph.com/rss": "Cointelegraph",
}
_NSE_MCX_FEEDS = {
    "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms": "The Economic Times",
    "https://www.livemint.com/rss/markets": "Mint",
}

# Each feed set above is general ("markets", "crypto") rather than
# per-instrument, so a keyword match against title+description is what
# narrows it to one underlying - case-insensitive substring match. Full
# names only (not bare tickers like "ETH"/"SOL") to avoid matching
# unrelated words ("method", "sole", ...) - mainstream coverage names the
# asset by name anyway.
_KEYWORDS: dict[str, list[str]] = {
    "BTCUSD": ["bitcoin"],
    "ETHUSD": ["ethereum"],
    "SOLUSD": ["solana"],
    "NIFTY": ["nifty 50", "nifty50"],
    "BANKNIFTY": ["bank nifty", "banknifty"],
    "GOLDM": ["gold"],
    "CRUDEOILM": ["crude oil", "crude prices", "oil price"],
}
_CRYPTO_UNDERLYINGS = ["BTCUSD", "ETHUSD", "SOLUSD"]
_NSE_MCX_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "GOLDM", "CRUDEOILM"]

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

SUPPORTED_UNDERLYINGS = set(_KEYWORDS)

# No external quota to manage (unlike marketaux) - this TTL exists purely
# to avoid re-polling the RSS feeds and re-running the OpenRouter analysis
# on every page view. One combined fetch per bucket (2 feeds each) covers
# every underlying sharing that bucket; the AI call still runs once per
# underlying per refresh, so cost is ~7 OpenRouter calls per full cycle
# (worst case ~336/day at this TTL - still well under a dollar/day at
# Haiku pricing, see app/config.py's openrouter_model).
_NEWS_TTL_SECONDS = 30 * 60

# How many of the freshest matched articles to actually hand to the AI -
# caps prompt size/cost regardless of how many the feeds turned up.
_MAX_ARTICLES_FOR_AI = 20
_MAX_ARTICLES_IN_DIGEST = 8

# Strips any stray HTML markup a feed's <description> might carry (RSS
# descriptions are meant to be plain text/CDATA, but some publishers embed
# <img>/<a> tags) - only used for the AI prompt's summary field, never
# for the title/url/source shown to the user.
_HTML_TAG_RE = re.compile(r"<[^>]+>")

_cache_lock = threading.Lock()
_cache: dict[str, tuple[NewsDigest, float]] = {}
# One refresh-in-flight lock per bucket, so several symbol tabs opening
# their News tab around the same moment on a cold cache trigger exactly
# one round of feed fetches for that bucket, not one per underlying.
_crypto_refresh_lock = threading.Lock()
_nse_mcx_refresh_lock = threading.Lock()

# The set of article urls that matched an underlying on its last refresh -
# an unchanged set means no new article arrived since the last AI call, so
# _refresh_bucket skips re-analyzing (and re-persisting) rather than
# spending an OpenRouter call on input it's already digested. A missing
# key never equals a real (possibly empty) frozenset, so the first-ever
# refresh always runs analysis.
_last_fingerprint: dict[str, frozenset] = {}

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


def _parse_pubdate(raw: Optional[str]) -> str:
    """RSS pubDate is RFC-822 ("Sat, 12 Sep 2026 13:24:36 +0530") - normalize
    to ISO-8601 so plain string comparison (used for sorting) stays a valid
    chronological sort regardless of which feed an article came from."""
    if not raw:
        return ""
    try:
        return parsedate_to_datetime(raw).isoformat()
    except (TypeError, ValueError):
        return raw


def _fetch_rss(url: str, source_label: str) -> list[dict]:
    resp = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0 (compatible; algo-trading-news/1.0)"})
    resp.raise_for_status()
    root = ElementTree.fromstring(resp.content)
    rows = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        if not title or not link:
            continue
        rows.append(
            {
                "title": title,
                "url": link,
                "description": (item.findtext("description") or "").strip(),
                "published_at": _parse_pubdate(item.findtext("pubDate")),
                "source": source_label,
            }
        )
    return rows


def _fetch_bucket(feeds: dict[str, str]) -> list[dict]:
    """Fetches every feed in one bucket, tolerating individual feed
    failures (a Livemint hiccup shouldn't blank ET's articles too) - only
    raises if every feed in the bucket failed."""
    rows: list[dict] = []
    errors: list[str] = []
    for url, label in feeds.items():
        try:
            rows.extend(_fetch_rss(url, label))
        except Exception as exc:
            errors.append(f"{label}: {exc}")
    if not rows and errors:
        raise RuntimeError("; ".join(errors))
    if errors:
        logger.warning("some news feeds failed: %s", "; ".join(errors))
    return rows


def _matches(row: dict, keywords: list[str]) -> bool:
    """Word-boundary match (not a bare substring) - matters most for the
    generic per-stock path below, where the "keyword" is just a bare NSE
    ticker (e.g. "ABB", "ITC"): a plain substring test would false-positive
    inside unrelated words. The curated multi-word keywords ("nifty 50",
    "bitcoin") are unaffected either way."""
    haystack = f"{row.get('title', '')} {row.get('description', '')}".lower()
    return any(re.search(rf"\b{re.escape(kw)}\b", haystack) for kw in keywords)


def _fingerprint(rows: list[dict]) -> frozenset:
    """Identifies the article set matched for one underlying - an
    unchanged fingerprint across refreshes means no new article arrived,
    see _last_fingerprint."""
    return frozenset(row["url"] for row in rows if row.get("url"))


def _to_article(row: dict) -> NewsArticle:
    return NewsArticle(
        title=row.get("title") or "",
        url=row.get("url") or "",
        source=row.get("source") or "",
        published_at=row.get("published_at") or "",
    )


def _fallback_digest(rows: list[dict], reason: str) -> NewsDigest:
    """No AI analysis available (key unset or the call failed) - the raw,
    unfiltered, unscored headlines are still useful on their own."""
    articles = [_to_article(row) for row in rows[:_MAX_ARTICLES_IN_DIGEST]]
    articles.sort(key=lambda a: a.published_at, reverse=True)
    return NewsDigest(bias="neutral", bias_reason=reason, digest=reason, articles=articles)


def _analyze_via_ai(underlying: str, rows: list[dict]) -> NewsDigest:
    """Runs the raw RSS headlines matched for one underlying through
    OpenRouter (see app/config.py's openrouter_model, default a cheap/fast
    Haiku) to get a trend-relevance digest: an overall bullish/bearish/
    neutral read plus the individual articles filtered down to the ones
    that actually matter, each scored 0-100 with a one-line reason. Runs
    once per cache refresh (not per request) - see _NEWS_TTL_SECONDS.
    Degrades to the plain unscored headline list (never raises) so a
    missing key or a flaky OpenRouter call doesn't blank the News tab."""
    if not rows:
        return _fallback_digest(rows, "No recent news found.")
    if not settings.openrouter_api_key:
        return _fallback_digest(rows, "AI analysis not configured - set OPENROUTER_API_KEY.")

    candidates = rows[:_MAX_ARTICLES_FOR_AI]
    by_url = {row.get("url"): row for row in candidates if row.get("url")}
    articles_payload = [
        {
            "url": row.get("url"),
            "title": row.get("title"),
            "summary": _HTML_TAG_RE.sub("", row.get("description") or ""),
            "source": row.get("source"),
            "published_at": row.get("published_at"),
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
            article = _to_article(row)
            article.relevance_score = entry.get("relevance_score")
            article.why = entry.get("why")
            scored_articles.append(article)
        # The AI picks which articles matter but its own list order isn't
        # meaningful (confirmed live - not chronological); newest-first is
        # what the tab should actually show.
        scored_articles.sort(key=lambda a: a.published_at, reverse=True)

        return NewsDigest(
            bias=parsed["bias"],
            bias_reason=parsed["bias_reason"],
            digest=parsed["digest"],
            articles=scored_articles,
        )
    except Exception as exc:
        logger.warning("OpenRouter news analysis failed for %s: %s", underlying, exc)
        return _fallback_digest(rows, "AI analysis temporarily unavailable - showing raw headlines.")


def _persist_digest(underlying: str, digest: NewsDigest) -> None:
    """Logs one market_data.news_history row so this digest's bias/articles
    can later be checked against what price actually did (see that table's
    own comment in infra/postgres/init/05-market-data.sql). Best-effort -
    a DB hiccup here shouldn't take down the News tab itself."""
    db = SessionLocal()
    try:
        db.add(
            NewsHistory(
                underlying=underlying,
                bias=digest.bias,
                bias_reason=digest.bias_reason,
                digest=digest.digest,
                articles=[a.model_dump() for a in digest.articles],
            )
        )
        db.commit()
    except Exception:
        logger.exception("failed to persist news_history row for %s", underlying)
        db.rollback()
    finally:
        db.close()


def _refresh_bucket(feeds: dict[str, str], lock: threading.Lock, underlyings: list[str]) -> None:
    """Fetches every feed in a bucket ONCE, then filters each underlying's
    matches out of that same fetch - e.g. one round of (CoinDesk,
    Cointelegraph) fetches covers BTCUSD/ETHUSD/SOLUSD without re-fetching
    per symbol. Re-analyzing via AI (and logging a news_history row) only
    happens when that underlying's matched article set actually changed
    since last time (see _last_fingerprint) - an unchanged RSS feed just
    extends the existing digest's freshness instead of spending another
    OpenRouter call on input it's already digested."""
    with lock:
        if _cache_get(underlyings[0], _NEWS_TTL_SECONDS) is not None:
            return  # someone else refreshed it while we waited for the lock
        try:
            rows = _fetch_bucket(feeds)
        except Exception as exc:
            logger.warning("news feed refresh failed for %s: %s", underlyings, exc)
            return
        rows.sort(key=lambda r: r.get("published_at") or "", reverse=True)
        for underlying in underlyings:
            matched = [row for row in rows if _matches(row, _KEYWORDS[underlying])]
            fingerprint = _fingerprint(matched)
            existing = _cache_stale(underlying)
            if existing is not None and fingerprint == _last_fingerprint.get(underlying):
                _cache_set(underlying, existing)  # no new articles - just extend freshness
                continue
            digest = _analyze_via_ai(underlying, matched)
            _cache_set(underlying, digest)
            _persist_digest(underlying, digest)
            _last_fingerprint[underlying] = fingerprint


def _generic_stock_news(symbol: str) -> NewsDigest:
    """News for an arbitrary NSE stock NOT in the curated desk (e.g. any
    weekly_advisor F&O symbol opened via manual-trading's "Open chart") -
    same ET+Mint markets feeds as the curated NSE/MCX bucket (no new
    source, no new ToS exposure), just keyword-matched on the bare ticker
    instead of a hand-curated phrase. Deliberately its own cache/fetch
    path rather than folding into _refresh_bucket/_NSE_MCX_UNDERLYINGS -
    that list is fixed at import time, but an arbitrary stock symbol isn't
    known in advance. Costs one extra RSS fetch of the same 2 feeds when a
    stock's news is checked around the same time as the curated bucket's
    own refresh - an accepted duplication, not worth a shared-cache
    refactor for what's normally an occasional, one-off lookup."""
    cached = _cache_get(symbol, _NEWS_TTL_SECONDS)
    if cached is not None:
        return cached

    try:
        rows = _fetch_bucket(_NSE_MCX_FEEDS)
    except Exception as exc:
        stale = _cache_stale(symbol)
        if stale is not None:
            return stale
        raise RuntimeError(f"news feed fetch failed: {exc}") from exc

    rows.sort(key=lambda r: r.get("published_at") or "", reverse=True)
    matched = [row for row in rows if _matches(row, [symbol.lower()])]
    fingerprint = _fingerprint(matched)
    existing = _cache_stale(symbol)
    if existing is not None and fingerprint == _last_fingerprint.get(symbol):
        _cache_set(symbol, existing)  # no new articles - just extend freshness
        return existing

    digest = _analyze_via_ai(symbol, matched)
    _cache_set(symbol, digest)
    _persist_digest(symbol, digest)
    _last_fingerprint[symbol] = fingerprint
    return digest


def get_news(underlying: str, segment: Optional[str] = None) -> NewsDigest:
    """Cached AI trend-relevance digest for one chart underlying - see the
    module-level comments above for the RSS sourcing/bucketing and the
    OpenRouter analysis layered on top. Falls back to a stale cached copy
    (if any) rather than raising when a refresh fails, so a transient
    hiccup doesn't blank the News tab; raises only when there's truly
    nothing to show yet.

    An underlying outside the curated desk (SUPPORTED_UNDERLYINGS) is
    treated as a generic NSE stock ticker - see _generic_stock_news - only
    when the caller says `segment="NSE"`; otherwise (unknown/MCX/CRYPTO
    symbol) it's rejected same as before. `segment` exists purely to tell
    those apart - it's never itself part of the keyword match."""
    if underlying not in SUPPORTED_UNDERLYINGS:
        if segment == "NSE":
            return _generic_stock_news(underlying)
        raise ValueError(f"no news source configured for '{underlying}'")

    cached = _cache_get(underlying, _NEWS_TTL_SECONDS)
    if cached is not None:
        return cached

    if underlying in _CRYPTO_UNDERLYINGS:
        _refresh_bucket(_CRYPTO_FEEDS, _crypto_refresh_lock, _CRYPTO_UNDERLYINGS)
    else:
        _refresh_bucket(_NSE_MCX_FEEDS, _nse_mcx_refresh_lock, _NSE_MCX_UNDERLYINGS)

    fresh = _cache_get(underlying, _NEWS_TTL_SECONDS)
    if fresh is not None:
        return fresh
    stale = _cache_stale(underlying)
    if stale is not None:
        return stale
    raise RuntimeError("news is temporarily unavailable - try again shortly")
