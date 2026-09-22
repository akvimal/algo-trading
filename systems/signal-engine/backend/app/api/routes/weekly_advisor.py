import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.adapters import accounts_client
from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.adapters.market_data import client as market_data_client
from app.auth import get_optional_user_id
from app.config import settings
from app.domain.weekly_advisor.contracts import WeeklyRecommendation
from app.domain.weekly_advisor.journal import (
    DecisionSet,
    MarginCheckRequest,
    MarginCheckResponse,
    PerformanceSummary,
    SavedRecommendationOut,
    SaveRecommendationRequest,
    TradeClose,
    TradeCreate,
    TradeEntryUpdate,
    TradeLeg,
    TradeOut,
    compute_performance_summary,
)
from app.domain.weekly_advisor.pipeline import run_symbol
from app.domain.weekly_advisor.screener_fetch import get_cached_screenshot

logger = logging.getLogger(__name__)

router = APIRouter()

DEFAULT_SYMBOLS = ["RELIANCE", "TCS", "HDFCBANK", "ABB", "TATASTEEL"]

# Bounds how many symbols run_symbol() calls are in flight at once for a
# single request. Each one makes ~4 blocking HTTP calls to market-data
# (weekly + daily OHLCV, expiry list, option chain), so this is the real
# lever on wall-clock time for a big batch (e.g. the ~200-symbol F&O
# universe: ~10 minutes fully sequential vs. ~2 minutes at this width).
# Kept modest on purpose - market-data's yahoo.py has no rate-limit lock
# of its own (unlike dhan.py/delta.py), and Yahoo Finance itself can
# temporarily block an IP under heavy concurrent load; a wide pool here
# would also degrade the Live Chart's own history feature, which shares
# the same provider. Frontend callers should still chunk a large symbol
# list across multiple requests (see WeeklyAdvisorPage.tsx) rather than
# relying on this alone - that's what gives the user a progress bar.
_BATCH_CONCURRENCY = 5


@router.get("/weekly-advisor/recommendations")
def get_weekly_recommendations(
    symbols: Optional[str] = Query(None, description="comma-separated NSE symbols; defaults to a small starter list"),
    as_of: Optional[date] = None,
    user_id: Optional[uuid.UUID] = Depends(get_optional_user_id),
):
    """On-demand, stateless: builds each symbol's recommendation fresh off
    live NSE OHLCV (via market-data's source=yahoo) - no AI memo yet (see
    app/domain/weekly_advisor/pipeline.py's docstring). One symbol's
    pipeline failure (missing history, unresolvable expiry) is skipped, not
    fatal to the rest of the batch - callers get a partial `recommendations`
    list plus a `skipped` list with reasons, in the requested symbol order
    regardless of which finished first. Persistence is a separate, explicit
    step (POST .../recommendations/save below) - a preview run here is
    never saved on its own.

    BYO OpenRouter key (2026-09-16): the fundamentals vote's AI read, when
    this batch hits a stale/missing per-symbol cache, is paid for with the
    calling user's own key (accounts_client.get_user_openrouter_key) - see
    screener_fetch.py's own module docstring for why the resulting
    fundamentals read is still cached/shared per-symbol across every user
    regardless of whose key produced it."""
    symbol_list = [s.strip().upper() for s in symbols.split(",") if s.strip()] if symbols else DEFAULT_SYMBOLS
    openrouter_api_key = accounts_client.get_user_openrouter_key(user_id) if user_id else None

    def _run(symbol: str):
        try:
            return symbol, run_symbol(symbol, as_of=as_of, openrouter_api_key=openrouter_api_key), None
        except Exception as exc:
            logger.warning("weekly-advisor: skipping %s (%s: %s)", symbol, exc.__class__.__name__, exc)
            return symbol, None, str(exc)

    with ThreadPoolExecutor(max_workers=_BATCH_CONCURRENCY) as pool:
        results = list(pool.map(_run, symbol_list))

    recommendations: list[WeeklyRecommendation] = [rec for _, rec, _ in results if rec is not None]
    skipped: list[dict] = [{"symbol": s, "reason": reason} for s, rec, reason in results if rec is None]

    return {"recommendations": recommendations, "skipped": skipped}


@router.get("/weekly-advisor/fundamentals/{symbol}/screenshot")
def get_fundamentals_screenshot(symbol: str):
    """Raw PNG of the cached screener.in screenshot the AI fundamentals
    read (WeeklyRecommendation.fundamentals, see screener_fetch.py) was
    produced from - lets the user visually verify what the AI actually
    saw. 404s when nothing's been captured for this symbol yet (no
    recommendation run has touched it, or capture failed every time so
    far); never triggers a fetch itself - that only happens as a side
    effect of run_symbol() above."""
    screenshot = get_cached_screenshot(symbol.strip().upper())
    if screenshot is None:
        raise HTTPException(status_code=404, detail="no cached screener.in screenshot for this symbol yet")
    return Response(content=screenshot, media_type="image/png")


@router.post("/weekly-advisor/margin", response_model=MarginCheckResponse)
def check_margin(payload: MarginCheckRequest):
    """Real Dhan margin for a set of legs + a quantity - the decision
    form's "Check margin" action (WeeklyAdvisorPage.tsx), not part of
    creating/logging a trade itself (journal.py's own "not execution
    integration" still holds - this is a read-only lookup, nothing is
    placed or saved by this call). `productType="MARGIN"`, not
    "INTRADAY" - weekly_advisor's positions are meant to be held across
    days until expiry, not squared off same-day, and Dhan's margin
    calculator returns different (INTRADAY is typically cheaper/leveraged)
    figures for the two - see market-data's DhanProvider.get_combo_margin
    docstring for the confirmed request/response shapes."""
    legs = [
        {
            "security_id": leg.security_id,
            "exchange_segment": "NSE_FNO",
            "transaction_type": "SELL" if leg.side == "sell" else "BUY",
            "quantity": int(payload.quantity),
            "product_type": "MARGIN",
            "price": leg.price,
        }
        for leg in payload.legs
    ]
    try:
        raw = market_data_client.get_combo_margin(legs)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"could not get a margin estimate: {exc}") from exc
    return MarginCheckResponse(raw=raw)


def _parse_uuid(value: str, what: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"{what} not found")


def _to_saved_out(row: db_models.WeeklyAdvisorRecommendation) -> SavedRecommendationOut:
    return SavedRecommendationOut(
        id=str(row.id), symbol=row.symbol, as_of=row.as_of, action=row.action,
        saved_at=row.saved_at, payload=WeeklyRecommendation.model_validate(row.payload),
        decision=row.decision, confidence=row.confidence,
        decision_comments=row.decision_comments, decided_at=row.decided_at,
    )


def _to_trade_out(row: db_models.WeeklyAdvisorTrade, rec: db_models.WeeklyAdvisorRecommendation) -> TradeOut:
    return TradeOut(
        id=str(row.id), recommendation_id=str(row.recommendation_id), symbol=rec.symbol, action=rec.action,
        status=row.status, quantity=row.quantity, entry_credit=row.entry_credit, entry_notes=row.entry_notes,
        taken_at=row.taken_at, exit_debit=row.exit_debit, realized_pnl=row.realized_pnl,
        exit_notes=row.exit_notes, closed_at=row.closed_at,
        funds_needed=row.funds_needed, margin_needed=row.margin_needed, pop=row.pop,
        max_profit=row.max_profit, max_loss=row.max_loss, days_to_expiry_at_entry=row.days_to_expiry_at_entry,
        actual_bias=row.actual_bias, actual_strategy=row.actual_strategy,
        legs=[TradeLeg.model_validate(leg) for leg in row.legs] if row.legs else None,
        target_pct_of_max_profit=row.target_pct_of_max_profit, stop_loss_pct_of_max_loss=row.stop_loss_pct_of_max_loss,
    )


def _default_legs(rec: db_models.WeeklyAdvisorRecommendation, quantity: Optional[float]) -> Optional[list[TradeLeg]]:
    """Pre-fills legs from the recommendation's own strategy.legs (no
    quantity/entry_price of its own - see TradeLeg's docstring) so the
    trader isn't retyping strikes the system already produced. entry_price
    starts unset - true at creation time regardless of whether this is
    logged before or during the session, since even a same-day fill price
    isn't known until the broker actually confirms it."""
    legs = rec.payload.get("strategy", {}).get("legs") or []
    if not legs:
        return None
    return [TradeLeg(option_type=leg["option_type"], strike=leg["strike"], side=leg["side"], quantity=quantity) for leg in legs]


def _default_target_pct(rec: db_models.WeeklyAdvisorRecommendation) -> Optional[float]:
    pct = rec.payload.get("strategy", {}).get("exit_rule", {}).get("target_pct_of_max_profit")
    return round(pct * 100, 1) if pct is not None else None


@router.post("/weekly-advisor/recommendations/save", response_model=SavedRecommendationOut, status_code=201)
def save_recommendation(payload: SaveRecommendationRequest, db: Session = Depends(get_db)):
    """Always recomputes via run_symbol server-side rather than trusting a
    client-supplied payload - a saved recommendation is a record that a
    real, reproducible pipeline run produced these numbers, not whatever
    JSON a caller happened to send."""
    symbol = payload.symbol.strip().upper()
    try:
        rec = run_symbol(symbol, as_of=payload.as_of)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"could not build a recommendation for '{symbol}': {exc}")

    row = db_models.WeeklyAdvisorRecommendation(
        symbol=rec.symbol, as_of=rec.as_of.date(), action=rec.strategy.action,
        payload=rec.model_dump(mode="json"),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_saved_out(row)


@router.get("/weekly-advisor/recommendations/history", response_model=list[SavedRecommendationOut])
def list_saved_recommendations(
    symbol: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    query = db.query(db_models.WeeklyAdvisorRecommendation)
    if symbol:
        query = query.filter(db_models.WeeklyAdvisorRecommendation.symbol == symbol.strip().upper())
    rows = query.order_by(db_models.WeeklyAdvisorRecommendation.saved_at.desc()).limit(limit).all()
    return [_to_saved_out(r) for r in rows]


@router.get("/weekly-advisor/recommendations/{recommendation_id}", response_model=SavedRecommendationOut)
def get_saved_recommendation(recommendation_id: str, db: Session = Depends(get_db)):
    row = db.get(db_models.WeeklyAdvisorRecommendation, _parse_uuid(recommendation_id, "recommendation"))
    if row is None:
        raise HTTPException(status_code=404, detail="recommendation not found")
    return _to_saved_out(row)


@router.put("/weekly-advisor/recommendations/{recommendation_id}/decision", response_model=SavedRecommendationOut)
def set_recommendation_decision(recommendation_id: str, payload: DecisionSet, db: Session = Depends(get_db)):
    """A lightweight "did you act on this" note - independent of whether a
    trade is ever journaled below. Overwrites any prior decision on this
    recommendation (a working note, not an audit trail - see the table's
    own comment in infra/postgres/init/03-signal-generation.sql)."""
    row = db.get(db_models.WeeklyAdvisorRecommendation, _parse_uuid(recommendation_id, "recommendation"))
    if row is None:
        raise HTTPException(status_code=404, detail="recommendation not found")

    row.decision = payload.decision
    row.confidence = payload.confidence
    row.decision_comments = payload.comments
    row.decided_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return _to_saved_out(row)


def _days_to_expiry_at_entry(rec: db_models.WeeklyAdvisorRecommendation) -> Optional[int]:
    """Derived, not user-entered - the recommendation's own expiry (its
    strategy.entry_window.latest) minus today, computed fresh at
    journal-create time (which may be well after the recommendation was
    saved)."""
    try:
        expiry = date.fromisoformat(rec.payload["strategy"]["entry_window"]["latest"])
        return (expiry - date.today()).days
    except (KeyError, TypeError, ValueError):
        return None


@router.post("/weekly-advisor/recommendations/{recommendation_id}/trades", response_model=TradeOut, status_code=201)
def create_trade(recommendation_id: str, payload: TradeCreate, db: Session = Depends(get_db)):
    """"Select/execute" a saved recommendation - see app/domain/weekly_advisor/
    journal.py's module docstring for why this is a manual journal entry,
    not a real execution-opened position."""
    rec_id = _parse_uuid(recommendation_id, "recommendation")
    rec = db.get(db_models.WeeklyAdvisorRecommendation, rec_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="recommendation not found")

    existing_open = (
        db.query(db_models.WeeklyAdvisorTrade)
        .filter(db_models.WeeklyAdvisorTrade.recommendation_id == rec_id, db_models.WeeklyAdvisorTrade.status == "open")
        .first()
    )
    if existing_open is not None:
        raise HTTPException(status_code=409, detail="this recommendation already has an open trade - close it first")

    legs = payload.legs if payload.legs is not None else _default_legs(rec, payload.quantity)
    target_pct = payload.target_pct_of_max_profit if payload.target_pct_of_max_profit is not None else _default_target_pct(rec)

    row = db_models.WeeklyAdvisorTrade(
        recommendation_id=rec_id, quantity=payload.quantity,
        entry_credit=payload.entry_credit, entry_notes=payload.entry_notes,
        funds_needed=payload.funds_needed, margin_needed=payload.margin_needed, pop=payload.pop,
        max_profit=payload.max_profit, max_loss=payload.max_loss,
        days_to_expiry_at_entry=_days_to_expiry_at_entry(rec),
        actual_bias=payload.actual_bias, actual_strategy=payload.actual_strategy,
        legs=[leg.model_dump(mode="json") for leg in legs] if legs else None,
        target_pct_of_max_profit=target_pct, stop_loss_pct_of_max_loss=payload.stop_loss_pct_of_max_loss,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_trade_out(row, rec)


@router.get("/weekly-advisor/trades", response_model=list[TradeOut])
def list_trades(
    status: Optional[str] = Query(None, pattern="^(open|closed)$"),
    symbol: Optional[str] = None,
    db: Session = Depends(get_db),
):
    query = db.query(db_models.WeeklyAdvisorTrade, db_models.WeeklyAdvisorRecommendation).join(
        db_models.WeeklyAdvisorRecommendation,
        db_models.WeeklyAdvisorTrade.recommendation_id == db_models.WeeklyAdvisorRecommendation.id,
    )
    if status:
        query = query.filter(db_models.WeeklyAdvisorTrade.status == status)
    if symbol:
        query = query.filter(db_models.WeeklyAdvisorRecommendation.symbol == symbol.strip().upper())
    rows = query.order_by(db_models.WeeklyAdvisorTrade.taken_at.desc()).all()
    return [_to_trade_out(trade, rec) for trade, rec in rows]


@router.put("/weekly-advisor/trades/{trade_id}/entry", response_model=TradeOut)
def update_trade_entry(trade_id: str, payload: TradeEntryUpdate, db: Session = Depends(get_db)):
    """Overwrite provisional entry data with the real thing once the legs
    actually fill - see TradeEntryUpdate's docstring. Merge-style: a field
    left out of the request body is untouched, so a caller can post just
    the one leg price that changed. Refused once a trade is closed - its
    entry is history at that point, and TradeClose already owns exit data."""
    row = db.get(db_models.WeeklyAdvisorTrade, _parse_uuid(trade_id, "trade"))
    if row is None:
        raise HTTPException(status_code=404, detail="trade not found")
    if row.status == "closed":
        raise HTTPException(status_code=409, detail="trade is closed - entry data can no longer be edited")

    updates = payload.model_dump(exclude_unset=True)
    if "legs" in updates:
        updates["legs"] = [leg.model_dump(mode="json") for leg in payload.legs] if payload.legs is not None else None
    for field, value in updates.items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)

    rec = db.get(db_models.WeeklyAdvisorRecommendation, row.recommendation_id)
    return _to_trade_out(row, rec)


@router.put("/weekly-advisor/trades/{trade_id}/close", response_model=TradeOut)
def close_trade(trade_id: str, payload: TradeClose, db: Session = Depends(get_db)):
    row = db.get(db_models.WeeklyAdvisorTrade, _parse_uuid(trade_id, "trade"))
    if row is None:
        raise HTTPException(status_code=404, detail="trade not found")
    if row.status == "closed":
        raise HTTPException(status_code=409, detail="trade is already closed")

    row.status = "closed"
    row.exit_debit = payload.exit_debit
    row.realized_pnl = payload.realized_pnl
    row.exit_notes = payload.exit_notes
    row.closed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)

    rec = db.get(db_models.WeeklyAdvisorRecommendation, row.recommendation_id)
    return _to_trade_out(row, rec)


@router.get("/weekly-advisor/performance/summary", response_model=PerformanceSummary)
def get_performance_summary(symbol: Optional[str] = None, db: Session = Depends(get_db)):
    query = db.query(db_models.WeeklyAdvisorTrade, db_models.WeeklyAdvisorRecommendation).join(
        db_models.WeeklyAdvisorRecommendation,
        db_models.WeeklyAdvisorTrade.recommendation_id == db_models.WeeklyAdvisorRecommendation.id,
    )
    if symbol:
        query = query.filter(db_models.WeeklyAdvisorRecommendation.symbol == symbol.strip().upper())
    rows = query.all()
    trades = [_to_trade_out(trade, rec) for trade, rec in rows]
    return compute_performance_summary(trades)


class WeeklyAdvisorSettings(BaseModel):
    # The OpenRouter model screener_fetch.py's _analyze_via_ai sends the
    # screener.in screenshot to - see app/config.py's own comment for why
    # this is a separate setting from market-data's (text-only) one.
    openrouter_vision_model: str


@router.get("/weekly-advisor/settings", response_model=WeeklyAdvisorSettings)
def get_weekly_advisor_settings():
    return WeeklyAdvisorSettings(openrouter_vision_model=settings.openrouter_vision_model)


@router.put("/weekly-advisor/settings", response_model=WeeklyAdvisorSettings)
def update_weekly_advisor_settings(payload: WeeklyAdvisorSettings):
    """In-memory only, like market-data's own PUT /settings - takes effect
    on the very next fundamentals read, no restart needed, but reverts to
    OPENROUTER_VISION_MODEL from .env on one. Only affects future reads;
    already-cached weekly_advisor_fundamentals rows (see
    weekly_advisor_fundamentals_cache_days) keep whatever model produced
    them until their own TTL expires and they're re-fetched."""
    model = payload.openrouter_vision_model.strip()
    if not model:
        raise HTTPException(status_code=422, detail="openrouter_vision_model must not be blank")
    settings.openrouter_vision_model = model
    return WeeklyAdvisorSettings(openrouter_vision_model=settings.openrouter_vision_model)
