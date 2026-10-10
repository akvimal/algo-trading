"""GET /analysis/{symbol}: one stock's combined read, on demand (the Scan page's "AI analysis" button): what its chart says, what its business
says (the AI's read of its screener.in page), and one verdict that puts the two side by side. See app/domain/stock_analysis.py.

The chart half needs no key and no model call, so it is always returned when the stock has enough history. The business half is the
shared cached AI read (app/api/routes/fundamentals.py): when it cannot be had (no OpenRouter key yet, the page could not be read) the
analysis still comes back, chart only, with the reason where the business half would be."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.routes.fundamentals import FundamentalsProblem, caller_key, read_fundamentals, valid_symbol
from app.auth import Caller, get_caller
from app.domain.stock_analysis import NotEnoughHistory, StockAnalysis, analyze_stock

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/analysis/{symbol}", response_model=StockAnalysis)
def get_stock_analysis(symbol: str, refresh: bool = Query(default=False), caller: Caller = Depends(get_caller)):
    sym = valid_symbol(symbol)
    fundamentals = None
    note: Optional[str] = None
    needs_key = False
    try:
        fundamentals, _ = read_fundamentals(sym, caller_key(caller), refresh)
    except FundamentalsProblem as p:
        note, needs_key = p.detail, p.code is not None
    try:
        return analyze_stock(sym, fundamentals, note, needs_key=needs_key)
    except NotEnoughHistory as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.warning("analysis: could not read %s's price history: %s", sym, exc)
        raise HTTPException(status_code=502, detail=f"Could not load {sym}'s price history right now. Try again in a moment.")
