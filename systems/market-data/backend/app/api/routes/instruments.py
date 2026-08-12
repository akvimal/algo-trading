from fastapi import APIRouter, HTTPException

from app.domain.models import ProviderStatus, ResolvedUnderlying
from app.providers import nse_indices
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
    DhanProvider.resolve_underlying. Used by signal-generation's engine
    and signal-processing's option-strategy resolution; execution instead
    uses GET /instruments/resolve-by-security-id below (it already deals
    in already-resolved option legs' security_id, not a logical
    underlying name)."""
    try:
        provider = get_provider(segment)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    resolved = provider.resolve_underlying(underlying)
    if resolved is None:
        raise HTTPException(status_code=404, detail=f"could not resolve underlying '{underlying}' on segment '{segment}'")
    return resolved


@router.get("/instruments/resolve-by-security-id")
def resolve_symbol_by_security_id(exchange: str, security_id: str):
    """Given a raw Dhan security ID (e.g. an option leg's own security_id
    from Phase 4a's option-chain response), the trading symbol it belongs
    to - Phase 4d of the options trading module (see docs/architecture.md).
    Used by execution once, at position-open time, to translate a leg's
    security_id into a symbol it can then quote/size via the ordinary
    symbol-keyed GET /quotes/ltp(/batch) and GET /instruments/lot-size."""
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    symbol = provider.resolve_symbol_by_security_id(security_id)
    if symbol is None:
        raise HTTPException(status_code=404, detail=f"unknown security_id '{security_id}' on exchange '{exchange}'")
    return {"symbol": symbol}


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


@router.get("/instruments/universes")
def list_universes():
    """Available NSE index-constituent universe keys (e.g. "NIFTYBANK") -
    used by signal-generation's frontend to populate a universe picker
    when scoping a Strategy to a whole index instead of one symbol."""
    return {"universes": nse_indices.list_universes()}


@router.get("/instruments/universe/constituents")
def universe_constituents(key: str):
    """The symbol list for one universe key - used by signal-generation's
    in-house engine to expand a universe-scoped Strategy into its member
    symbols each tick."""
    constituents = nse_indices.get_constituents(key)
    if constituents is None:
        raise HTTPException(status_code=404, detail=f"unknown universe '{key}'")
    return {"key": key.upper(), "constituents": constituents}
