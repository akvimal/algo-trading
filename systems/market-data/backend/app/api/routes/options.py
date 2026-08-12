"""Option chain data - Phase 4a of the options trading module (see
docs/architecture.md). Dhan-specific (DhanProvider.get_expiry_list/
get_option_chain) - duck-typed via getattr rather than assumed, so a
future non-Dhan provider (e.g. Delta Exchange) that doesn't support this
gets a clean 404 instead of an AttributeError, same reasoning as
app/providers/dhan_feed.py's _resolve_target."""

from datetime import date

from fastapi import APIRouter, HTTPException, Query

from app.domain.models import OptionChain, OptionLegCandle
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


@router.get("/options/leg-history", response_model=list[OptionLegCandle])
def get_leg_history(
    exchange: str,
    symbol: str,
    option_type: str,
    strike: str,
    expiry_flag: str,
    expiry_code: int,
    interval: str,
    from_: date = Query(alias="from"),
    to: date = date.today(),
):
    """Historical premium for one option leg, tracked relative to spot
    (e.g. always the ATM strike) via Dhan's rolling-option endpoint -
    Phase 4c's backtesting data source (see docs/architecture.md), not
    Phase 4a/4b's live chain snapshot above."""
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    resolver = getattr(provider, "get_option_leg_history", None)
    if resolver is None:
        raise HTTPException(status_code=404, detail=f"exchange '{exchange}' has no option-history support")

    try:
        candles = resolver(symbol, option_type, strike, expiry_flag, expiry_code, interval, from_, to)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if candles is None:
        raise HTTPException(status_code=404, detail=f"unknown symbol '{symbol}' on exchange '{exchange}'")
    return candles
