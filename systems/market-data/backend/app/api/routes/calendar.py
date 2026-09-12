from fastapi import APIRouter, HTTPException

from app.domain.models import EconomicEvent
from app.providers.calendar import get_events

router = APIRouter()


@router.get("/calendar", response_model=list[EconomicEvent])
def get_calendar_route(underlying: str):
    """Medium/high-impact economic calendar events for the Live Chart's
    Events tab - see app/providers/calendar.py for the Forex Factory feed
    and currency-to-underlying mapping. `underlying` is one of the desk's
    fixed chart symbols (NIFTY, BANKNIFTY, GOLDM, CRUDEOILM, BTCUSD,
    ETHUSD, SOLUSD)."""
    try:
        return get_events(underlying.strip().upper())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
