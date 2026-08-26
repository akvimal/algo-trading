"""Option chain data - Phase 4a of the options trading module (see
docs/architecture.md). Dhan-specific (DhanProvider.get_expiry_list/
get_option_chain) - duck-typed via getattr rather than assumed, so a
future non-Dhan provider (e.g. Delta Exchange) that doesn't support this
gets a clean 404 instead of an AttributeError, same reasoning as
app/providers/dhan_feed.py's _resolve_target."""

from datetime import date

from fastapi import APIRouter, HTTPException, Query

from app.domain.models import OptionChain, OptionLegCandle, OptionOiSummary
from app.domain.oi_summary import build_oi_summary
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


@router.get("/options/oi-summary", response_model=OptionOiSummary)
def get_oi_summary(exchange: str, symbol: str, expiry: str):
    """PCR + chain-wide OI-change totals (5m/15m) + per-strike OI/IV
    breakdown for one (exchange, symbol, expiry) - signal-generation's OI
    Summary page, not used in the resolve/order-placement path. Reuses
    the same DhanProvider.get_option_chain fetch/cache/throttle as
    GET /options/chain above, then layers get_oi_changes's in-memory
    history on top - see build_oi_summary for the aggregation itself."""
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    resolver = getattr(provider, "get_option_chain", None)
    changer = getattr(provider, "get_oi_changes", None)
    price_changer = getattr(provider, "get_price_changes", None)
    if resolver is None or changer is None:
        raise HTTPException(status_code=404, detail=f"exchange '{exchange}' has no option-chain support")

    try:
        chain = resolver(symbol, expiry)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if chain is None:
        raise HTTPException(status_code=404, detail=f"unknown symbol '{symbol}' on exchange '{exchange}'")

    def oi_changes(strike: float, option_type: str, current_oi: int):
        return changer(symbol, expiry, strike, option_type, current_oi)

    price_changes = None
    if price_changer is not None:

        def price_changes(strike: float, option_type: str, current_price: float):
            return price_changer(symbol, expiry, strike, option_type, current_price)

    return build_oi_summary(chain, oi_changes, price_changes)


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
