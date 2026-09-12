from fastapi import APIRouter, HTTPException

from app.domain.models import NewsDigest
from app.providers.news import get_news

router = APIRouter()


@router.get("/news", response_model=NewsDigest)
def get_news_route(underlying: str):
    """AI trend-relevance digest for the Live Chart's News tab - see
    app/providers/news.py for the marketaux-backed fetch/cache/bucketing
    and the OpenRouter analysis layered on top. `underlying` is one of the
    desk's fixed chart symbols (NIFTY, BANKNIFTY, GOLDM, CRUDEOILM,
    BTCUSD, ETHUSD, SOLUSD)."""
    try:
        return get_news(underlying.strip().upper())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
