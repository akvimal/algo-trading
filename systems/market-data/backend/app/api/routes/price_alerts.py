import uuid
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.adapters.db.models import PriceAlert
from app.adapters.db.session import get_db
from app.auth import get_optional_user_id
from app.domain.models import PriceAlertCreate, PriceAlertOut
from app.domain.notify import notify_telegram, telegram_configured
from app.domain.price_alerts import dispatch_due

router = APIRouter()


def _visible(q, user_id: Optional[UUID]):
    """A caller sees their own alerts plus any anonymous (user_id IS NULL)
    ones - a personal tool, one Telegram chat, so this is generous by
    design rather than strict tenant isolation."""
    if user_id is None:
        return q.filter(PriceAlert.user_id.is_(None))
    return q.filter(or_(PriceAlert.user_id == user_id, PriceAlert.user_id.is_(None)))


@router.get("/price-alerts", response_model=list[PriceAlertOut])
def list_price_alerts(
    include_inactive: bool = True,
    user_id: Optional[UUID] = Depends(get_optional_user_id),
    db: Session = Depends(get_db),
):
    q = _visible(db.query(PriceAlert), user_id)
    if not include_inactive:
        q = q.filter(PriceAlert.active.is_(True))
    return q.order_by(PriceAlert.active.desc(), PriceAlert.created_at.desc()).all()


@router.get("/price-alerts/telegram-status")
def telegram_status():
    """Whether a bot + chat are configured - the frontend shows a hint to
    set them up in .env when not."""
    return {"configured": telegram_configured()}


@router.post("/price-alerts", response_model=PriceAlertOut, status_code=201)
def create_price_alert(
    payload: PriceAlertCreate,
    user_id: Optional[UUID] = Depends(get_optional_user_id),
    db: Session = Depends(get_db),
):
    row = PriceAlert(
        user_id=user_id,
        exchange=payload.exchange.upper(),
        symbol=payload.symbol.upper(),
        target_price=payload.target_price,
        direction=payload.direction,
        note=payload.note,
        repeat=payload.repeat,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/price-alerts/{alert_id}", status_code=204)
def delete_price_alert(
    alert_id: str,
    user_id: Optional[UUID] = Depends(get_optional_user_id),
    db: Session = Depends(get_db),
):
    try:
        parsed = uuid.UUID(alert_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="alert not found")
    row = _visible(db.query(PriceAlert), user_id).filter(PriceAlert.id == parsed).first()
    if row is None:
        raise HTTPException(status_code=404, detail="alert not found")
    db.delete(row)
    db.commit()


@router.post("/price-alerts/check")
def run_check_now(db: Session = Depends(get_db)):
    """Force one evaluation pass (what the scheduler does every minute) -
    for testing without waiting for the timer."""
    return {"fired": dispatch_due(db)}


@router.post("/price-alerts/test-telegram")
def test_telegram():
    ok = notify_telegram("Test alert from market-data - your price alerts are wired up.")
    if not ok:
        raise HTTPException(status_code=503, detail="Telegram not configured or the send failed - check the logs / .env")
    return {"sent": True}
