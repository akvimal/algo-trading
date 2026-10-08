from fastapi import APIRouter, HTTPException, Query

from app.domain.market_calendar import UpcomingCalendar, upcoming
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


@router.get("/calendar/upcoming", response_model=UpcomingCalendar)
def get_upcoming_calendar(segment: str, days: int = Query(7, ge=1, le=14)):
    """What is scheduled for one market (NSE / MCX / CRYPTO) over the next few days: global macro releases, India's RBI
    decision, MoSPI releases and exchange holidays, NSE F&O expiry days and crypto options expiries, merged into one list
    - see app/domain/market_calendar.py for each layer's source."""
    try:
        return upcoming(segment.strip().upper(), days=days)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
