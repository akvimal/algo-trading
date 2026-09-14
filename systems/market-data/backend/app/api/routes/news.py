from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.db.models import NewsHistory
from app.adapters.db.session import get_db
from app.config import settings
from app.domain.models import NewsDigest, NewsHistoryPoint
from app.providers.news import SUPPORTED_UNDERLYINGS, get_news

router = APIRouter()


@router.get("/news", response_model=NewsDigest)
def get_news_route(underlying: str, segment: Optional[str] = None):
    """AI trend-relevance digest for the Live Chart's News tab - see
    app/providers/news.py for the RSS fetch/cache/bucketing and the
    OpenRouter analysis layered on top. `underlying` is either one of the
    desk's fixed chart symbols (NIFTY, BANKNIFTY, GOLDM, CRUDEOILM,
    BTCUSD, ETHUSD, SOLUSD) or, when `segment="NSE"`, any other NSE stock
    ticker (see get_news's generic-stock fallback) - `segment` is what
    tells the fallback apart from an unmapped MCX/CRYPTO symbol, which
    still 404s."""
    try:
        return get_news(underlying.strip().upper(), segment=(segment or "").strip().upper() or None)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/news/history", response_model=list[NewsHistoryPoint])
def get_news_history(underlying: str, day: Optional[date] = Query(None), db: Session = Depends(get_db)):
    """market_data.news_history for one underlying, scoped to one calendar
    day (default today, in settings.timezone) - every digest that was
    actually produced for it that day (one per cache refresh, not per
    request), newest first, so a past AI bias call can be checked against
    what price did afterward. See app/providers/news.py's _persist_digest."""
    underlying = underlying.strip().upper()
    if underlying not in SUPPORTED_UNDERLYINGS:
        raise HTTPException(status_code=404, detail=f"no news source configured for '{underlying}'")

    tz = ZoneInfo(settings.timezone)
    the_day = day or datetime.now(tz).date()
    day_start = datetime.combine(the_day, datetime.min.time(), tzinfo=tz)
    day_end = day_start + timedelta(days=1)

    rows = (
        db.query(NewsHistory)
        .filter(
            NewsHistory.underlying == underlying,
            NewsHistory.recorded_at >= day_start,
            NewsHistory.recorded_at < day_end,
        )
        .order_by(NewsHistory.recorded_at.desc())
        .all()
    )
    return [NewsHistoryPoint.model_validate(row) for row in rows]
