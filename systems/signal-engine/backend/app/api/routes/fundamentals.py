"""GET /fundamentals/{symbol}: one stock's fundamentals read by AI, on demand (the Scan page's "Fundamentals" button).

It is the same capture-and-read the Weekly Advisor uses (app/domain/weekly_advisor/screener_fetch.py) and shares its cache: a
screener.in page screenshot plus the AI's read of it, kept for weeks, so most requests are instant and only the first one for a
symbol opens a browser and spends model credit. The model is paid for with the caller's own OpenRouter key when they have saved one
(falling back to the platform key); with neither, a symbol that is not cached yet is refused with a clear code rather than captured
for nothing."""

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.adapters import accounts_client
from app.auth import Caller, get_caller
from app.config import settings
from app.domain.weekly_advisor import screener_fetch

logger = logging.getLogger(__name__)

router = APIRouter()

_SYMBOL = re.compile(r"^[A-Z0-9&_-]{1,30}$")
# A refresh opens a browser and spends model credit, so a read younger than this is never re-captured on request.
REFRESH_AFTER = timedelta(hours=24)


class FundamentalsOut(BaseModel):
    symbol: str
    bias: str  # bullish | bearish | neutral
    confidence: Optional[float] = None
    summary: Optional[str] = None
    pros: list[str] = []
    cons: list[str] = []
    reasons: list[str] = []
    fetched_at: Optional[datetime] = None
    # True only when a fresh capture was made because `refresh` was asked for; a read younger than a day is returned as it is.
    refreshed: bool = False


def _to_out(a: screener_fetch.FundamentalAnalysis, refreshed: bool) -> FundamentalsOut:
    return FundamentalsOut(
        symbol=a.symbol, bias=a.bias or "neutral", confidence=a.confidence, summary=a.summary, pros=a.pros, cons=a.cons,
        reasons=a.reasons, fetched_at=a.fetched_at, refreshed=refreshed,
    )


def _key_required() -> HTTPException:
    return HTTPException(
        status_code=409,
        detail="Fundamentals are read by AI and need an OpenRouter key: add yours in Settings.",
        headers={"X-Error-Code": "openrouter_key_required"},
    )


@router.get("/fundamentals/{symbol}", response_model=FundamentalsOut)
def get_stock_fundamentals(symbol: str, refresh: bool = Query(default=False), caller: Caller = Depends(get_caller)):
    sym = symbol.strip().upper()
    if not _SYMBOL.match(sym):
        raise HTTPException(status_code=422, detail="not a valid NSE symbol")
    key = (accounts_client.get_user_openrouter_key(caller.user_id) if caller.user_id else None) or settings.openrouter_api_key or None
    cached = screener_fetch.has_cached(sym)
    if not key and not cached:
        raise _key_required()  # nothing to read from yet, and nothing to read it with: do not open a browser for nothing

    analysis = screener_fetch.get_fundamentals(sym, key)
    if analysis is None:
        raise HTTPException(status_code=503, detail=f"Could not read screener.in for {sym}. It may not be listed there, or the site is unavailable right now.")
    refreshed = False
    if analysis.bias is None:
        # A stored page whose first read failed (no key then, or a model hiccup): read the same page again, without a new capture.
        if not key:
            raise _key_required()
        analysis = screener_fetch.reanalyze_cached(sym, key) or analysis
        if analysis.bias is None:
            raise HTTPException(status_code=502, detail="The AI could not read this company's page right now. Try again in a minute.")
    elif refresh and key and analysis.fetched_at is not None and datetime.now(timezone.utc) - analysis.fetched_at >= REFRESH_AFTER:
        fresh = screener_fetch.get_fundamentals(sym, key, force=True)
        if fresh is not None and fresh.bias is not None:
            analysis, refreshed = fresh, True
    return _to_out(analysis, refreshed)
