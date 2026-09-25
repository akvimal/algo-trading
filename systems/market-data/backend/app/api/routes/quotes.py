from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from app.data_access import data_credentials
from app.auth import Caller, get_caller
from app.domain.models import BatchQuoteRequest, BatchQuoteResponse, Quote
from app.providers.router import get_provider

router = APIRouter()


@router.get("/quotes/ltp", response_model=Quote)
def get_ltp(exchange: str, symbol: str, caller: Caller = Depends(get_caller)):
    try:
        provider = get_provider(exchange)
        credentials = data_credentials(caller, exchange)
        price = provider.get_ltp(symbol, credentials=credentials)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return Quote(exchange=exchange, symbol=symbol, ltp=price, provider=provider.name)


@router.post("/quotes/ltp/batch", response_model=BatchQuoteResponse)
def get_ltp_batch(payload: BatchQuoteRequest, caller: Caller = Depends(get_caller)):
    """Fetches all requested symbols in as few provider calls as possible
    (one, for Dhan - it supports up to 1000 instruments per request).
    Prefer this over repeated GET /quotes/ltp when you need more than a
    couple of symbols - see docs/architecture.md for why that matters.
    A valid bearer token (Phase 3 - BYO Dhan credentials) uses that
    user's own Dhan account/rate budget instead of the platform default;
    omitted/invalid falls through to the platform default exactly as
    before this phase - see app/auth.py's own docstring."""
    try:
        provider = get_provider(payload.exchange)
        credentials = data_credentials(caller, payload.exchange)
        prices = provider.get_ltp_batch(payload.symbols, credentials=credentials)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return BatchQuoteResponse(exchange=payload.exchange, provider=provider.name, prices=prices)
