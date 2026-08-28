"""Option chain data - Phase 4a of the options trading module (see
docs/architecture.md). Dhan-specific (DhanProvider.get_expiry_list/
get_option_chain) - duck-typed via getattr rather than assumed, so a
future non-Dhan provider (e.g. Delta Exchange) that doesn't support this
gets a clean 404 instead of an AttributeError, same reasoning as
app/providers/dhan_feed.py's _resolve_target."""

from datetime import date
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.accounts_client import get_user_dhan_credentials
from app.adapters.db.models import SentimentHistory
from app.adapters.db.session import get_db
from app.auth import get_optional_user_id
from app.domain.models import MarketSentiment, OptionChain, OptionLegCandle, OptionOiSummary, SentimentHistoryPoint
from app.domain.oi_summary import build_oi_summary
from app.domain.sentiment import SENTIMENT_UNDERLYINGS, aggregate_exchange
from app.domain.sentiment_fetch import fetch_underlying_sentiment
from app.providers.router import get_provider

router = APIRouter()


@router.get("/options/expiries")
def get_expiries(exchange: str, symbol: str, user_id: Optional[UUID] = Depends(get_optional_user_id)):
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    resolver = getattr(provider, "get_expiry_list", None)
    if resolver is None:
        raise HTTPException(status_code=404, detail=f"exchange '{exchange}' has no option-chain support")

    try:
        credentials = get_user_dhan_credentials(user_id) if user_id else None
        expiries = resolver(symbol, credentials=credentials)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if expiries is None:
        raise HTTPException(status_code=404, detail=f"unknown symbol '{symbol}' on exchange '{exchange}'")
    return {"expiries": expiries}


@router.get("/options/chain", response_model=OptionChain)
def get_chain(exchange: str, symbol: str, expiry: str, user_id: Optional[UUID] = Depends(get_optional_user_id)):
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    resolver = getattr(provider, "get_option_chain", None)
    if resolver is None:
        raise HTTPException(status_code=404, detail=f"exchange '{exchange}' has no option-chain support")

    try:
        credentials = get_user_dhan_credentials(user_id) if user_id else None
        chain = resolver(symbol, expiry, credentials=credentials)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if chain is None:
        raise HTTPException(status_code=404, detail=f"unknown symbol '{symbol}' on exchange '{exchange}'")
    return chain


@router.get("/options/oi-summary", response_model=OptionOiSummary)
def get_oi_summary(exchange: str, symbol: str, expiry: str, user_id: Optional[UUID] = Depends(get_optional_user_id)):
    """PCR + chain-wide OI-change totals (5m/15m) + per-strike OI/IV
    breakdown for one (exchange, symbol, expiry) - the OI Summary page,
    not used in the resolve/order-placement path. Reuses the same
    DhanProvider.get_option_chain fetch/cache/throttle as GET
    /options/chain above (now BYO-credential-aware the same way, see
    that route - originally left out of Phase 3's scope since the OI
    Summary page wasn't itself Bearer-authenticated yet at the time),
    then layers get_oi_changes's in-memory history on top - see
    build_oi_summary for the aggregation itself."""
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
        credentials = get_user_dhan_credentials(user_id) if user_id else None
        chain = resolver(symbol, expiry, credentials=credentials)
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


@router.get("/options/sentiment", response_model=MarketSentiment)
def get_sentiment(user_id: Optional[UUID] = Depends(get_optional_user_id)):
    """NSE/MCX bullish-bearish read for the manual-trading SaaS header -
    see app/domain/sentiment.py. BYO-credential-aware the same way GET
    /options/chain etc. already are: a logged-in user with their own
    saved Dhan credentials uses their own token/rate budget for this too,
    not the platform default. A fixed watchlist per exchange, fetched
    fresh each call (this route has no cache of its own beyond
    DhanProvider's own OPTION_CHAIN_CACHE_TTL_SECONDS), so the frontend's
    own 5-minute poll interval is what keeps this from hammering Dhan,
    not anything here. One underlying's fetch failing (e.g. a bad/expired
    token) degrades just that underlying (see UnderlyingSentiment.error)
    rather than 502ing the whole response - a header badge should never
    go blank because one of four symbols had a transient Dhan error."""
    credentials = get_user_dhan_credentials(user_id) if user_id else None
    exchanges = {}
    for exchange, symbols in SENTIMENT_UNDERLYINGS.items():
        underlyings = [fetch_underlying_sentiment(exchange, symbol, credentials)[0] for symbol in symbols]
        exchanges[exchange] = aggregate_exchange(underlyings)
    return MarketSentiment(exchanges=exchanges)


@router.get("/options/sentiment-history", response_model=list[SentimentHistoryPoint])
def get_sentiment_history(symbol: str, limit: int = Query(200, ge=1, le=2000), db: Session = Depends(get_db)):
    """market_data.sentiment_history for one SENTIMENT_UNDERLYINGS symbol -
    each row's own direction/strength/score alongside the underlying's spot
    price at that same moment (app/scheduler.py's _record_sentiment_history
    writes one row per symbol every 5 minutes), so a past OI-based read can
    be checked against what price actually did afterward. Oldest-first
    (chart-friendly reading order), capped to the most recent `limit` rows
    rather than the whole table."""
    rows = (
        db.query(SentimentHistory)
        .filter(SentimentHistory.symbol == symbol)
        .order_by(SentimentHistory.recorded_at.desc())
        .limit(limit)
        .all()
    )
    return list(reversed(rows))


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
