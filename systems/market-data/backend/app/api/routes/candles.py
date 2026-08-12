from datetime import date
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from app.domain.models import Candle
from app.providers.router import get_provider

router = APIRouter()


@router.get("/candles/previous", response_model=Candle)
def get_previous_candle(exchange: str, symbol: str, interval: str):
    """The most recently completed candle only - not a historical range,
    see app/providers/dhan.py get_previous_candle for scope/rationale.
    404 if unavailable (unknown symbol, or no completed candle yet e.g.
    just after market open) - same "not found" semantics as GET
    /quotes/ltp for an unknown symbol."""
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        candle = provider.get_previous_candle(symbol, interval)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if candle is None:
        raise HTTPException(status_code=404, detail=f"no completed candle available for '{symbol}' at '{interval}' yet")

    return candle


@router.get("/candles/history", response_model=list[Candle])
def get_candle_history(
    exchange: str,
    symbol: str,
    interval: str,
    from_: Optional[date] = Query(default=None, alias="from"),
    to: Optional[date] = None,
):
    """A general multi-bar series over [from_, to] - used to warm up
    indicator state (signal-generation's RSI/SMA engine) and for
    backtesting, unlike GET /candles/previous which only ever returns
    one value. `from_` (query param `from`) defaults to 7 days back,
    `to` defaults to today, if omitted."""
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    to_date = to or date.today()
    from_date = from_ or date.fromordinal(to_date.toordinal() - 7)

    try:
        return provider.get_candle_history(symbol, interval, from_date, to_date)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
