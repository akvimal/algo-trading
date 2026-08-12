from fastapi import APIRouter, HTTPException

from app.domain.models import ProviderStatus, ResolvedUnderlying
from app.providers.router import all_providers, get_provider

router = APIRouter()


@router.post("/instruments/sync")
def sync_all():
    return [p.sync_instruments() for p in all_providers()]


@router.get("/instruments/sync-status", response_model=list[ProviderStatus])
def sync_status():
    return [p.status() for p in all_providers()]


@router.get("/instruments/resolve", response_model=ResolvedUnderlying)
def resolve_underlying(segment: str, underlying: str):
    """Given a logical underlying (e.g. "GOLDM", "NIFTY") on a segment,
    resolve what to chart indicators on and what to actually trade - see
    DhanProvider.resolve_underlying. Used by signal-generation's engine,
    never by execution (which only ever deals in already-resolved
    trading symbols)."""
    try:
        provider = get_provider(segment)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    resolved = provider.resolve_underlying(underlying)
    if resolved is None:
        raise HTTPException(status_code=404, detail=f"could not resolve underlying '{underlying}' on segment '{segment}'")
    return resolved


@router.get("/instruments/lot-size")
def get_lot_size(exchange: str, symbol: str):
    """Lot size for an already-resolved trading symbol - 1 for
    instruments with no lot concept (e.g. NSE cash equity). Used by
    execution to size futures positions in whole lots."""
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    lot_size = provider.get_lot_size(symbol)
    if lot_size is None:
        raise HTTPException(status_code=404, detail=f"unknown symbol '{symbol}' on exchange '{exchange}'")
    return {"lot_size": lot_size}
