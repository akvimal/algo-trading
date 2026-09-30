"""Server-side pending (limit) orders: POST/GET/DELETE /pending-orders.
See app/domain/pending_orders.py for the semantics (paper only, fires on the
underlying's first crossing, at-most-once, expires)."""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.auth import User, get_current_user
from app.domain.models import PendingOrderCreate, PendingOrderOut
from app.domain.pending_orders import PendingOrderError, cancel_pending_order, create_pending_order, default_deps, list_pending_orders
from app.domain.position_manager import load_account

router = APIRouter()

_STATUSES = ("pending", "triggered", "rejected", "failed", "cancelled", "expired")


def _f(v) -> Optional[float]:
    return float(v) if v is not None else None


def _to_out(row) -> PendingOrderOut:
    return PendingOrderOut(
        id=str(row.id), segment=row.segment, symbol=row.symbol, action=row.action, strategy=row.strategy, moneyness=row.moneyness,
        trigger_price=float(row.trigger_price), started_above=bool(row.started_above), stop_loss_price=_f(row.stop_loss_price),
        target_price=_f(row.target_price), quantity=_f(row.quantity), trend_followed=bool(row.trend_followed),
        risk_managed=bool(row.risk_managed), setup_tag=row.setup_tag, confidence=row.confidence, entry_interval=row.entry_interval,
        status=row.status, status_reason=row.status_reason, expires_at=row.expires_at, created_at=row.created_at,
        triggered_at=row.triggered_at, last_price=_f(row.last_price), last_checked_at=row.last_checked_at,
        position_id=str(row.position_id) if row.position_id is not None else None,
        option_group_id=str(row.option_group_id) if row.option_group_id is not None else None,
    )


@router.post("/pending-orders", response_model=PendingOrderOut, status_code=201)
def arm_pending_order(payload: PendingOrderCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Arms a limit order the SERVER watches. Refused on a live account (paper only)."""
    account = load_account(db, user.id, payload.segment)
    is_live = bool(account is not None and account.live_trading_enabled)
    try:
        row = create_pending_order(db, user.id, payload, default_deps(), is_live, token=user.token)
    except PendingOrderError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    return _to_out(row)


@router.get("/pending-orders", response_model=list[PendingOrderOut])
def list_orders(
    status: Optional[str] = Query(default=None), limit: int = Query(default=100, ge=1, le=500),
    user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    if status is not None and status not in _STATUSES:
        raise HTTPException(status_code=422, detail=f"status must be one of {', '.join(_STATUSES)}")
    return [_to_out(r) for r in list_pending_orders(db, user.id, status, limit)]


@router.delete("/pending-orders/{order_id}", response_model=PendingOrderOut)
def cancel_order(order_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        parsed = uuid.UUID(order_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="pending order not found")
    try:
        row = cancel_pending_order(db, user.id, parsed)
    except PendingOrderError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    if row is None:
        raise HTTPException(status_code=404, detail="pending order not found")  # also for someone else's order
    return _to_out(row)
