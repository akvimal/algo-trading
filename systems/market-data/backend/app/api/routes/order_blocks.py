from datetime import date
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app.adapters.accounts_client import get_user_dhan_credentials
from app.api.routes.candles import fetch_candle_history_cached
from app.auth import get_optional_user_id
from app.domain.models import ChartStructure
from app.domain.order_blocks import detect_fvgs, detect_order_blocks
from app.providers.router import get_provider

router = APIRouter()


@router.get("/order-blocks", response_model=ChartStructure)
def get_order_blocks(
    exchange: str,
    symbol: str,
    interval: str,
    from_: Optional[date] = Query(default=None, alias="from"),
    to: Optional[date] = None,
    lookback: int = 20,
    zone_mode: str = "wick",
    mitigation: str = "wick",
    require_fvg: bool = False,
    breakers: bool = False,
    fvg: bool = False,
    max_zones: int = 8,
    user_id: Optional[UUID] = Depends(get_optional_user_id),
):
    """SMC structure primitives - order blocks (+ breakers, when
    `breakers=true`) and fair value gaps (when `fvg=true`) - detected on
    one (exchange, symbol, interval) candle series. Backs the Live Chart's
    multi-timeframe overlays, where the *detection* interval is chosen
    independently of what the chart is displaying (e.g. draw 15min zones
    while viewing the 5min chart). One call per detection timeframe.

    Candles come from the same cached fetch behind GET /candles/history
    (same defaulting: `from` 7 days back, `to` today) - so enabling a few
    detection timeframes mostly serves from cache between bar closes. See
    app/domain/order_blocks.py for the detection and its tunables (all
    optional query params here); `zone_mode`/`mitigation` fall back to
    "wick" on any unrecognised value."""
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    to_date = to or date.today()
    from_date = from_ or date.fromordinal(to_date.toordinal() - 7)

    try:
        credentials = get_user_dhan_credentials(user_id) if user_id else None
        candles = fetch_candle_history_cached(provider, exchange, symbol, interval, from_date, to_date, credentials)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    mode = zone_mode if zone_mode in ("wick", "body") else "wick"
    mit = mitigation if mitigation in ("wick", "close") else "wick"
    return ChartStructure(
        order_blocks=detect_order_blocks(
            candles,
            lookback=lookback,
            zone_mode=mode,
            mitigation=mit,
            require_fvg=require_fvg,
            keep_breakers=breakers,
            max_zones=max_zones,
        ),
        fvgs=detect_fvgs(candles, mitigation=mit) if fvg else [],
    )
