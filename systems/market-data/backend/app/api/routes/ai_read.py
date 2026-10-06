import logging
import threading
import time
from datetime import date, datetime
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.adapters import accounts_client
from app.api.routes.candles import fetch_candle_history_cached
from app.api.routes.options import get_expiries, get_oi_summary
from app.auth import Caller, get_caller
from app.config import settings
from app.data_access import data_credentials
from app.domain import ai_models
from app.domain.ai_read import build_context, events_context, news_context, run_ai_read, vix_context
from app.domain.models import ChartStructure
from app.domain.order_blocks import detect_order_blocks, structure_state
from app.domain.regime import assess_regime
from app.providers.calendar import SUPPORTED_UNDERLYINGS as CALENDAR_UNDERLYINGS, get_events
from app.providers.news import get_news
from app.providers.router import get_provider

logger = logging.getLogger(__name__)
router = APIRouter()

# A repeat click inside this window returns the previous read instead of paying
# for another model call - the underlying OI data only refreshes every few
# seconds anyway, and each call costs the caller's own OpenRouter credit.
_CACHE_TTL_SECONDS = 45
_cache_lock = threading.Lock()
_cache: dict[tuple, tuple[float, "AiRead"]] = {}


class AiRead(BaseModel):
    underlying: str
    expiry: str
    model: str
    generated_at: str
    bias: Literal["bullish", "bearish", "neutral"]
    confidence: int
    one_liner: str
    reasoning: list[str]
    support: list[float]
    resistance: list[float]
    risks: list[str]
    wait_for: str
    data_gaps: list[str]


def _nearest_expiry(exchange: str, symbol: str, caller: Caller) -> str:
    expiries = get_expiries(exchange, symbol, caller).get("expiries") or []
    upcoming = sorted(e for e in expiries if e >= date.today().isoformat())
    if not upcoming:
        raise HTTPException(status_code=404, detail=f"no upcoming expiry for '{symbol}'")
    return upcoming[0]


def _optional(label: str, fetch):
    """Extra context must never fail the read itself - a missing piece is just
    reported to the model as not provided."""
    try:
        return fetch()
    except Exception as exc:
        logger.info("AI read: %s context unavailable: %s", label, exc)
        return None


def _vix_candles(exchange: str, interval: str, credentials):
    to_date = date.today()
    return fetch_candle_history_cached(
        get_provider(exchange), exchange, "INDIA VIX", interval, date.fromordinal(to_date.toordinal() - 7), to_date, credentials
    )


@router.get("/ai-read", response_model=AiRead)
def get_ai_read(
    exchange: str,
    symbol: str,
    interval: str = "5min",
    expiry: Optional[str] = None,
    caller: Caller = Depends(get_caller),
):
    """On-demand AI read of the OI strip's own data plus price/regime/structure
    context - see app/domain/ai_read.py. Needs a BYO OpenRouter key (or the
    platform OPENROUTER_API_KEY); the model is OPENROUTER_READ_MODEL."""
    user_id: Optional[UUID] = caller.on_behalf_of if caller.trusted_service else caller.user_id
    key = (accounts_client.get_user_openrouter_key(user_id) if user_id else None) or settings.openrouter_api_key
    if not key:
        raise HTTPException(status_code=400, detail="No OpenRouter key - add yours in Settings to use the AI read.")

    expiry = expiry or _nearest_expiry(exchange, symbol, caller)
    model = ai_models.model_for("ai_read")
    cache_key = (user_id, exchange, symbol, interval, expiry, model)
    with _cache_lock:
        hit = _cache.get(cache_key)
    if hit and time.monotonic() - hit[0] < _CACHE_TTL_SECONDS:
        return hit[1]

    summary = get_oi_summary(exchange, symbol, expiry, caller)

    try:
        provider = get_provider(exchange)
        credentials = data_credentials(caller, exchange)
        to_date = date.today()
        candles = fetch_candle_history_cached(
            provider, exchange, symbol, interval, date.fromordinal(to_date.toordinal() - 7), to_date, credentials
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    trend, events, trend_changes = structure_state(candles)
    structure = ChartStructure(
        order_blocks=detect_order_blocks(candles, trend=trend), fvgs=[], trend=trend, events=events, trend_changes=trend_changes
    )
    # The chart/option-chain symbol of an MCX instrument is its futures contract (GOLDM-05Oct2026-FUT); news and the
    # macro calendar are keyed by the bare underlying (GOLDM).
    base = symbol.split("-")[0].upper() if exchange == "MCX" else symbol.upper()
    context = build_context(
        base,
        summary,
        candles,
        assess_regime(candles),
        structure,
        vix=_optional("VIX", lambda: vix_context(_vix_candles(exchange, interval, credentials))) if exchange == "NSE" else None,
        news=_optional("news", lambda: news_context(get_news(base, segment=exchange, openrouter_api_key=key))),
        events=_optional("calendar", lambda: events_context(get_events(base))),
        segment=exchange,
        contract=symbol,
        events_apply=base in CALENDAR_UNDERLYINGS,
    )

    try:
        parsed = run_ai_read(context, key, model)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    result = AiRead(
        underlying=symbol,
        expiry=expiry,
        model=model,
        generated_at=datetime.now().astimezone().isoformat(timespec="seconds"),
        bias=parsed["bias"],
        confidence=max(0, min(100, int(parsed.get("confidence") or 0))),
        one_liner=parsed.get("one_liner", ""),
        reasoning=parsed.get("reasoning") or [],
        support=parsed.get("support") or [],
        resistance=parsed.get("resistance") or [],
        risks=parsed.get("risks") or [],
        wait_for=parsed.get("wait_for", ""),
        data_gaps=context["not_provided"],
    )
    with _cache_lock:
        _cache[cache_key] = (time.monotonic(), result)
    return result
