from datetime import date
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app.adapters.accounts_client import get_user_dhan_credentials
from app.api.routes.candles import fetch_candle_history_cached
from app.auth import get_optional_user_id
from app.domain.models import MarketRegime
from app.domain.regime import assess_regime
from app.providers.router import get_provider

router = APIRouter()


@router.get("/regime", response_model=MarketRegime)
def get_regime(
    exchange: str,
    symbol: str,
    interval: str,
    from_: Optional[date] = Query(default=None, alias="from"),
    to: Optional[date] = None,
    user_id: Optional[UUID] = Depends(get_optional_user_id),
):
    """Coarse trend-vs-chop read for one candle series - the Live Chart's
    regime badge. Wilder ADX (strength) + the BOS/CHoCH structure trend
    (direction) + an ATR percentile (volatility), bucketed into
    trending_up / trending_down / ranging / transitional with one line of
    advice. Same candle source + defaulting as GET /order-blocks."""
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    to_date = to or date.today()
    from_date = from_ or date.fromordinal(to_date.toordinal() - 14)

    try:
        credentials = get_user_dhan_credentials(user_id) if user_id else None
        candles = fetch_candle_history_cached(provider, exchange, symbol, interval, from_date, to_date, credentials)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return assess_regime(candles)
