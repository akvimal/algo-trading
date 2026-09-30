"""The custom equity screener - saved, per-user screens (CRUD, require_
user_id: never anonymous, decided with the user - unlike PriceAlert's
generous own+anonymous visibility) plus running one (saved, by id, or an
ad-hoc preview before saving) against the latest EOD universe. See
app/domain/screener_expr.py for the expression grammar and
app/domain/custom_screens.py for the pure evaluation core this route
feeds - the actual DB reads (the base-universe filter against
equity_screener_snapshot's latest date, the batch equity_daily_bar fetch)
live here, same "pure core, thin route" split every other domain module
in this service uses."""

import uuid
from datetime import date
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.adapters.db.models import CustomScreen, EquityDailyBar, EquityScreenerSnapshot
from app.adapters.db.session import get_db
from app.auth import require_user_id
from app.domain.custom_screens import ScreenCandidate, matches_universe_filters, run_custom_screen
from app.domain.models import Candle, CustomScreenCreate, CustomScreenMatchOut, CustomScreenOut, CustomScreenRunResult
from app.domain.screener_expr import ExpressionError, parse_expression

router = APIRouter()


@router.get("/custom-screens", response_model=list[CustomScreenOut])
def list_custom_screens(user_id: UUID = Depends(require_user_id), db: Session = Depends(get_db)):
    return db.query(CustomScreen).filter(CustomScreen.user_id == user_id).order_by(CustomScreen.created_at.desc()).all()


@router.post("/custom-screens", response_model=CustomScreenOut, status_code=201)
def create_custom_screen(payload: CustomScreenCreate, user_id: UUID = Depends(require_user_id), db: Session = Depends(get_db)):
    _validate_expression(payload.expression)
    row = CustomScreen(user_id=user_id, **payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/custom-screens/{screen_id}", response_model=CustomScreenOut)
def update_custom_screen(screen_id: str, payload: CustomScreenCreate, user_id: UUID = Depends(require_user_id), db: Session = Depends(get_db)):
    _validate_expression(payload.expression)
    row = _owned_or_404(db, screen_id, user_id)
    for field, value in payload.model_dump().items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/custom-screens/{screen_id}", status_code=204)
def delete_custom_screen(screen_id: str, user_id: UUID = Depends(require_user_id), db: Session = Depends(get_db)):
    row = _owned_or_404(db, screen_id, user_id)
    db.delete(row)
    db.commit()


@router.get("/custom-screens/{screen_id}/run", response_model=CustomScreenRunResult)
def run_saved_screen(screen_id: str, user_id: UUID = Depends(require_user_id), db: Session = Depends(get_db)):
    row = _owned_or_404(db, screen_id, user_id)
    return _run(db, row.expression, row.is_fno, row.index_membership, row.min_price, row.max_price)


@router.post("/custom-screens/preview", response_model=CustomScreenRunResult)
def preview_custom_screen(payload: CustomScreenCreate, db: Session = Depends(get_db)):
    """Runs `payload` without saving it - for trying a condition out before
    committing to it. No auth dependency: unlike the saved-screen CRUD
    above, there is nothing here that belongs to anyone yet."""
    _validate_expression(payload.expression)
    return _run(db, payload.expression, payload.is_fno, payload.index_membership, payload.min_price, payload.max_price)


def _validate_expression(expression: str) -> None:
    try:
        parse_expression(expression)
    except ExpressionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _owned_or_404(db: Session, screen_id: str, user_id: UUID) -> CustomScreen:
    try:
        parsed = uuid.UUID(screen_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="screen not found")
    row = db.query(CustomScreen).filter(CustomScreen.id == parsed, CustomScreen.user_id == user_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="screen not found")
    return row


def _run(
    db: Session, expression: str, is_fno: Optional[bool], index_membership: Optional[str], min_price: Optional[float], max_price: Optional[float],
) -> CustomScreenRunResult:
    latest_date: Optional[date] = db.query(func.max(EquityScreenerSnapshot.snapshot_date)).scalar()
    if latest_date is None:
        return CustomScreenRunResult(snapshot_date=None, candidates=0, matches=[])

    snapshot_rows = db.query(EquityScreenerSnapshot).filter(EquityScreenerSnapshot.snapshot_date == latest_date).all()
    candidate_rows = [
        r for r in snapshot_rows
        if matches_universe_filters(r.is_fno, r.index_memberships, r.close, is_fno, index_membership, min_price, max_price)
    ]
    if not candidate_rows:
        return CustomScreenRunResult(snapshot_date=latest_date, candidates=0, matches=[])

    symbols = [r.symbol for r in candidate_rows]
    bar_rows = (
        db.query(EquityDailyBar)
        .filter(EquityDailyBar.symbol.in_(symbols))
        .order_by(EquityDailyBar.symbol.asc(), EquityDailyBar.bar_date.asc())
        .all()
    )
    bars_by_symbol: dict[str, list[Candle]] = {}
    for b in bar_rows:
        bars_by_symbol.setdefault(b.symbol, []).append(
            Candle(exchange=b.exchange, symbol=b.symbol, interval="daily", open=b.open, high=b.high, low=b.low, close=b.close, volume=b.volume, timestamp=f"{b.bar_date.isoformat()}T00:00:00", provider="cache")
        )

    candidates = [
        ScreenCandidate(symbol=r.symbol, exchange=r.exchange, close=r.close, bars=bars_by_symbol.get(r.symbol, []))
        for r in candidate_rows
    ]
    try:
        matches = run_custom_screen(expression, candidates)
    except ExpressionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return CustomScreenRunResult(
        snapshot_date=latest_date, candidates=len(candidates),
        matches=[CustomScreenMatchOut(symbol=m.symbol, exchange=m.exchange, close=m.close) for m in matches],
    )
