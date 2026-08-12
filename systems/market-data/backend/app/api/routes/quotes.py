from fastapi import APIRouter, HTTPException

from app.domain.models import BatchQuoteRequest, BatchQuoteResponse, Quote
from app.providers.router import get_provider

router = APIRouter()


@router.get("/quotes/ltp", response_model=Quote)
def get_ltp(exchange: str, symbol: str):
    try:
        provider = get_provider(exchange)
        price = provider.get_ltp(symbol)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return Quote(exchange=exchange, symbol=symbol, ltp=price, provider=provider.name)


@router.post("/quotes/ltp/batch", response_model=BatchQuoteResponse)
def get_ltp_batch(payload: BatchQuoteRequest):
    """Fetches all requested symbols in as few provider calls as possible
    (one, for Dhan - it supports up to 1000 instruments per request).
    Prefer this over repeated GET /quotes/ltp when you need more than a
    couple of symbols - see docs/architecture.md for why that matters."""
    try:
        provider = get_provider(payload.exchange)
        prices = provider.get_ltp_batch(payload.symbols)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return BatchQuoteResponse(exchange=payload.exchange, provider=provider.name, prices=prices)
