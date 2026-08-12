"""Option chain data - Phase 4a of the options trading module (see
docs/architecture.md). Dhan-specific (DhanProvider.get_expiry_list/
get_option_chain) - duck-typed via getattr rather than assumed, so a
future non-Dhan provider (e.g. Delta Exchange) that doesn't support this
gets a clean 404 instead of an AttributeError, same reasoning as
app/providers/dhan_feed.py's _resolve_target."""

from fastapi import APIRouter, HTTPException

from app.domain.models import OptionChain
from app.providers.router import get_provider

router = APIRouter()


@router.get("/options/expiries")
def get_expiries(exchange: str, symbol: str):
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    resolver = getattr(provider, "get_expiry_list", None)
    if resolver is None:
        raise HTTPException(status_code=404, detail=f"exchange '{exchange}' has no option-chain support")

    try:
        expiries = resolver(symbol)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if expiries is None:
        raise HTTPException(status_code=404, detail=f"unknown symbol '{symbol}' on exchange '{exchange}'")
    return {"expiries": expiries}


@router.get("/options/chain", response_model=OptionChain)
def get_chain(exchange: str, symbol: str, expiry: str):
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    resolver = getattr(provider, "get_option_chain", None)
    if resolver is None:
        raise HTTPException(status_code=404, detail=f"exchange '{exchange}' has no option-chain support")

    try:
        chain = resolver(symbol, expiry)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if chain is None:
        raise HTTPException(status_code=404, detail=f"unknown symbol '{symbol}' on exchange '{exchange}'")
    return chain
