"""Screener.in fundamentals: a long-lived (default 90d, see app/config.py's
weekly_advisor_fundamentals_cache_days) cache of one symbol's company-page
screenshot plus an AI-extracted fundamentals read, consumed by
regime_engine.py's assess_regime (see _fundamental_vote) as an additional
vote alongside the existing technical/OI/order-block ones.

Captured with a real headless browser (Playwright) rather than a plain
HTTP GET - screener.in's ratios/results/shareholding sections render
client-side, so a bare requests.get would only ever see the empty shell.
Read via an OpenRouter vision model (same provider/account and JSON-schema
pattern as market-data's news.py's _analyze_via_ai) rather than structured
HTML scraping - a screenshot read degrades gracefully (same "eyeball the
page" read a human would give) instead of silently breaking the moment
screener.in renames a CSS class, and needs no maintenance when their table
markup changes.

Runs from inside pipeline.py's run_symbol() (itself called from a
ThreadPoolExecutor worker, see weekly_advisor.py's route), not a FastAPI
route handler - so this module opens its own SessionLocal() rather than
taking a Depends(get_db) session, same convention news.py uses for its own
background-refresh path.
"""
from __future__ import annotations

import base64
import json
import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

import requests

from app.adapters.db import models as db_models
from app.adapters.db.session import SessionLocal
from app.config import settings

logger = logging.getLogger(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
SCREENER_URL = "https://www.screener.in/company/{symbol}/"

# Bounds how many headless Chromium instances can be launched at once. A
# cache miss is rare in steady state (90-day TTL) but a first-ever run
# over a big symbol list (e.g. the full F&O universe) can miss on every
# symbol at once - weekly_advisor.py's own _BATCH_CONCURRENCY (5) would
# otherwise try to launch 5 full browsers simultaneously alongside the
# normal market-data calls. Deliberately its own, smaller limit rather
# than reusing that constant.
_screenshot_semaphore = threading.Semaphore(2)

_FUNDAMENTALS_SCHEMA = {
    "type": "object",
    "properties": {
        "bias": {"type": "string", "enum": ["bullish", "bearish", "neutral"]},
        "confidence": {
            "type": "number",
            "description": (
                "0-1, calibrated against how one-sided AND well-evidenced the picture is - not a vibe, and not a "
                "default number. Use this rubric: 0.5-0.6 for a genuinely mixed or thinly-evidenced picture (pros "
                "and cons roughly balanced, or only 1-2 bullets either way); 0.65-0.75 for a picture that leans "
                "clearly one way but with real offsetting concerns; 0.8-0.95 only when the evidence is strongly "
                "and consistently one-sided (e.g. sustained multi-year profit/revenue growth with no material Cons "
                "red flag, or the reverse - persistent losses/debt stress with no offsetting Pro). This must vary "
                "genuinely from company to company based on what's actually visible in the image."
            ),
        },
        "summary": {"type": "string", "description": "2-3 sentences on the overall fundamental picture."},
        "pros": {"type": "array", "items": {"type": "string"}, "description": "Screener.in's own 'Pros' bullets, verbatim or lightly trimmed."},
        "cons": {"type": "array", "items": {"type": "string"}, "description": "Screener.in's own 'Cons' bullets, verbatim or lightly trimmed."},
        "reasons": {
            "type": "array",
            "items": {"type": "string"},
            "description": "1-4 short reasons behind the bias, e.g. profit/revenue trend, promoter holding change, debt trend.",
        },
    },
    "required": ["bias", "confidence", "summary", "pros", "cons", "reasons"],
    "additionalProperties": False,
}


@dataclass
class FundamentalAnalysis:
    symbol: str
    bias: Optional[str]
    confidence: Optional[float]
    summary: Optional[str]
    pros: list[str] = field(default_factory=list)
    cons: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    fetched_at: Optional[datetime] = None


def _capture_screenshot(symbol: str) -> bytes:
    """Renders screener.in's public company page and takes a full-page PNG
    screenshot. No login - the free page already shows the ratios/pros-
    cons/quarterly-results/shareholding sections this module reads;
    premium-only exports (Excel, DCF) aren't needed or used here."""
    from playwright.sync_api import sync_playwright  # lazy import - keeps this heavy dependency off every other module's import path

    url = SCREENER_URL.format(symbol=symbol)
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        try:
            page = browser.new_page(
                viewport={"width": 1280, "height": 1600},
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
                ),
            )
            # "load", not "networkidle" - confirmed live that screener.in
            # keeps some background network activity going indefinitely
            # (analytics/ads), so networkidle never fires and just burns
            # the full timeout on every single capture. "load" plus the
            # scroll-driven waits below is what actually gives the lazy-
            # rendered sections time to mount.
            page.goto(url, wait_until="load", timeout=30_000)
            page.wait_for_timeout(1500)
            # The ratios/ownership sections lazy-render as you scroll
            # (intersection-observer-driven charts) - a plain goto+screenshot
            # would capture them blank. Walk down in steps so each section
            # has time to mount before the final full-page capture.
            height = page.evaluate("document.body.scrollHeight")
            for y in range(0, height, 1200):
                page.evaluate(f"window.scrollTo(0, {y})")
                page.wait_for_timeout(300)
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(300)
            return page.screenshot(full_page=True, type="png")
        finally:
            browser.close()


def _analyze_via_ai(symbol: str, screenshot: bytes, api_key: Optional[str] = None) -> Optional[dict]:
    """OpenRouter vision call. Returns None (never raises) on a missing key
    or any failure - the screenshot is still cached by the caller even
    when this fails, so the next request past the TTL just retries the AI
    read against a fresh screenshot rather than losing the capture too.

    `api_key`: the requesting user's own BYO OpenRouter key (2026-09-16,
    see app/adapters/accounts_client.get_user_openrouter_key) when one was
    resolved; falls back to the platform-wide OPENROUTER_API_KEY env var
    otherwise, same as before this feature."""
    key = api_key or settings.openrouter_api_key
    if not key:
        logger.info("weekly-advisor fundamentals: AI analysis not configured - set OPENROUTER_API_KEY")
        return None

    b64 = base64.b64encode(screenshot).decode("ascii")
    try:
        resp = requests.post(
            OPENROUTER_URL,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "model": settings.openrouter_vision_model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are an equity fundamentals analyst. You'll be shown a screenshot of one "
                            "NSE-listed company's screener.in page (ratios, pros/cons, quarterly results, "
                            "shareholding pattern, peer comparison). Read only what's visible in the image - "
                            "never invent numbers you can't actually see. Give an overall fundamental "
                            "bullish/bearish/neutral bias (weigh profit/revenue trend, debt trend, promoter "
                            "holding trend, and the page's own Pros/Cons bullets), a short summary, and list "
                            "the Pros/Cons bullets you can read. For confidence, follow the rubric in the "
                            "schema exactly and genuinely re-derive it per company from the Pros/Cons balance "
                            "and evidence strength you actually see - never fall back to a fixed or 'typical' "
                            "number regardless of what the image shows."
                        ),
                    },
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": f"NSE symbol: {symbol}"},
                            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                        ],
                    },
                ],
                "response_format": {"type": "json_schema", "json_schema": {"name": "fundamentals", "strict": True, "schema": _FUNDAMENTALS_SCHEMA}},
                # See news.py's own copy of this comment - without a cap,
                # OpenRouter reserves against the model's max output (64000)
                # and 402s any account whose remaining balance can't cover
                # that worst case, even though the actual reply is small.
                "max_tokens": 2000,
            },
            timeout=60,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        return content if isinstance(content, dict) else json.loads(content)
    except Exception as exc:
        logger.warning("weekly-advisor fundamentals: OpenRouter analysis failed for %s: %s", symbol, exc)
        return None


def _row_to_analysis(row: db_models.WeeklyAdvisorFundamentals) -> FundamentalAnalysis:
    return FundamentalAnalysis(
        symbol=row.symbol,
        bias=row.bias,
        confidence=float(row.confidence) if row.confidence is not None else None,
        summary=row.summary,
        pros=row.pros or [],
        cons=row.cons or [],
        reasons=row.reasons or [],
        fetched_at=row.fetched_at,
    )


def get_fundamentals(symbol: str, openrouter_api_key: Optional[str] = None) -> Optional[FundamentalAnalysis]:
    """Cache-first: a row fetched within the last
    weekly_advisor_fundamentals_cache_days is returned as-is - no
    Playwright, no OpenRouter call. Past that TTL (or "first time", no row
    yet), captures a fresh screenshot, re-analyzes, and upserts. Never
    raises - a Playwright/OpenRouter/DB hiccup degrades to "no fundamental
    vote this cycle" (None), same graceful-degradation convention
    pipeline.py already uses for OI/order-blocks, rather than failing the
    whole recommendation over an optional input. A screenshot-capture
    failure with an existing (stale) row still returns that stale read
    rather than nothing - better than silently dropping the vote just
    because today's re-scrape happened to fail."""
    db = SessionLocal()
    try:
        row = db.get(db_models.WeeklyAdvisorFundamentals, symbol)
        ttl = timedelta(days=settings.weekly_advisor_fundamentals_cache_days)
        if row is not None and datetime.now(timezone.utc) - row.fetched_at < ttl:
            return _row_to_analysis(row)

        try:
            with _screenshot_semaphore:
                screenshot = _capture_screenshot(symbol)
        except Exception as exc:
            logger.warning("weekly-advisor fundamentals: screenshot capture failed for %s: %s", symbol, exc)
            return _row_to_analysis(row) if row is not None else None

        analysis = _analyze_via_ai(symbol, screenshot, openrouter_api_key)
        now = datetime.now(timezone.utc)
        if row is None:
            row = db_models.WeeklyAdvisorFundamentals(symbol=symbol, screenshot=screenshot)
            db.add(row)
        row.screenshot = screenshot
        row.fetched_at = now
        if analysis is not None:
            row.bias = analysis.get("bias")
            row.confidence = analysis.get("confidence")
            row.summary = analysis.get("summary")
            row.pros = analysis.get("pros")
            row.cons = analysis.get("cons")
            row.reasons = analysis.get("reasons")
            row.ai_model = settings.openrouter_vision_model
            row.analyzed_at = now
        db.commit()
        db.refresh(row)
        return _row_to_analysis(row)
    except Exception:
        logger.exception("weekly-advisor fundamentals: get_fundamentals failed for %s", symbol)
        db.rollback()
        return None
    finally:
        db.close()


def get_cached_screenshot(symbol: str) -> Optional[bytes]:
    """Raw PNG bytes for GET /weekly-advisor/fundamentals/{symbol}/screenshot
    - lets the frontend show exactly what the AI read. Never triggers a
    fetch itself, only serves whatever's already cached."""
    db = SessionLocal()
    try:
        row = db.get(db_models.WeeklyAdvisorFundamentals, symbol)
        return bytes(row.screenshot) if row is not None else None
    finally:
        db.close()
