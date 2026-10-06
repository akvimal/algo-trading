"""Price alerts: a level on a symbol that is pushed to the owner's own Telegram chat when price crosses it, even with every tab
closed (app/domain/price_alerts.py).

Every route needs a signed-in user: an alert spends the platform's market-data quota and sends a message through the platform's
bot, so an anonymous caller must not be able to create one, and one person's alerts must never land in another's (or the
operator's) chat. Each user sets their own Telegram chat id once (PUT /price-alerts/channel); the bot is the platform's. The
operator-only routes (force a pass) are admin-gated. Alerts created before they were tied to an account (user_id NULL) are visible
to, and removable by, admins only."""

import logging
import re
import threading
import time
import uuid
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.adapters.db.models import AlertChannel, PriceAlert
from app.adapters.db.session import get_db
from app.auth import User, require_admin, require_user
from app.domain.models import PriceAlertCreate, PriceAlertOut
from app.domain.notify import bot_configured, send_telegram
from app.domain.price_alerts import EXCHANGES, MAX_ACTIVE_ALERTS_PER_USER, _side, current_ltp, dispatch_due

logger = logging.getLogger(__name__)
router = APIRouter()

_CHAT_ID_RE = re.compile(r"^-?\d{3,20}$")  # a user's id is a number; a group's is a negative one
_TEST_MIN_GAP_SECONDS = 20
_test_lock = threading.Lock()
_last_test: dict[UUID, float] = {}


class ChannelIn(BaseModel):
    telegram_chat_id: str


class ChannelOut(BaseModel):
    bot_configured: bool
    chat_set: bool
    chat_id_hint: Optional[str] = None  # the last four digits, enough to recognise it


def _visible(q, user: User):
    """The caller's own alerts; an admin also sees the old unowned ones, so they can clear them."""
    if user.is_admin:
        return q.filter(or_(PriceAlert.user_id == user.user_id, PriceAlert.user_id.is_(None)))
    return q.filter(PriceAlert.user_id == user.user_id)


def get_channel(db: Session, user_id: UUID) -> Optional[str]:
    row = db.get(AlertChannel, user_id)
    return row.telegram_chat_id if row else None


def active_count(db: Session, user_id: UUID) -> int:
    return db.query(func.count(PriceAlert.id)).filter(PriceAlert.user_id == user_id, PriceAlert.active.is_(True)).scalar() or 0


def _channel_out(chat: Optional[str]) -> ChannelOut:
    return ChannelOut(bot_configured=bot_configured(), chat_set=bool(chat), chat_id_hint=f"…{chat[-4:]}" if chat else None)


@router.get("/price-alerts", response_model=list[PriceAlertOut])
def list_price_alerts(include_inactive: bool = True, user: User = Depends(require_user), db: Session = Depends(get_db)):
    q = _visible(db.query(PriceAlert), user)
    if not include_inactive:
        q = q.filter(PriceAlert.active.is_(True))
    return q.order_by(PriceAlert.active.desc(), PriceAlert.created_at.desc()).all()


@router.get("/price-alerts/telegram-status")
def telegram_status(user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Whether this user can receive alerts: the bot exists and they have set their chat. `configured` is the old single flag
    (the classic app reads it); `bot_configured` / `chat_set` say which half is missing."""
    out = _channel_out(get_channel(db, user.user_id))
    return {"configured": out.bot_configured and out.chat_set, **out.model_dump()}


@router.get("/price-alerts/channel", response_model=ChannelOut)
def get_alert_channel(user: User = Depends(require_user), db: Session = Depends(get_db)):
    return _channel_out(get_channel(db, user.user_id))


@router.put("/price-alerts/channel", response_model=ChannelOut)
def set_alert_channel(payload: ChannelIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Set (or, with an empty id, clear) the Telegram chat this user's alerts go to. Open the platform's bot in Telegram and press
    Start first, or the bot cannot message you; the number is your chat id (a group's is negative)."""
    chat = payload.telegram_chat_id.strip()
    row = db.get(AlertChannel, user.user_id)
    if not chat:
        if row is not None:
            db.delete(row)
            db.commit()
        return _channel_out(None)
    if not _CHAT_ID_RE.match(chat):
        raise HTTPException(status_code=422, detail="A Telegram chat id is a number, for example 123456789 (a group's starts with a minus sign).")
    if row is None:
        db.add(AlertChannel(user_id=user.user_id, telegram_chat_id=chat))
    else:
        row.telegram_chat_id = chat
    db.commit()
    return _channel_out(chat)


@router.post("/price-alerts", response_model=PriceAlertOut, status_code=201)
def create_price_alert(payload: PriceAlertCreate, user: User = Depends(require_user), db: Session = Depends(get_db)):
    exchange, symbol = payload.exchange.strip().upper(), payload.symbol.strip().upper()
    if exchange not in EXCHANGES:
        raise HTTPException(status_code=422, detail=f"Unknown market '{payload.exchange}'. Use one of: {', '.join(EXCHANGES)}.")
    if not get_channel(db, user.user_id):
        raise HTTPException(status_code=400, detail="Set your Telegram chat first (Alerts > Telegram), so there is somewhere to send the alert.")
    if active_count(db, user.user_id) >= MAX_ACTIVE_ALERTS_PER_USER:
        raise HTTPException(status_code=400, detail=f"You already have {MAX_ACTIVE_ALERTS_PER_USER} active alerts. Remove one first.")
    # A real price now both proves the symbol exists (a typo would otherwise sit armed and never be evaluated) and records which
    # side of the level it is on, so the alert is live from the first minute.
    ltp = current_ltp(exchange, symbol)
    if ltp is None:
        raise HTTPException(status_code=422, detail=f"Could not get a price for {exchange}:{symbol}. Check the symbol, or try again in a moment.")
    row = PriceAlert(
        user_id=user.user_id,
        exchange=exchange,
        symbol=symbol,
        target_price=payload.target_price,
        direction=payload.direction,
        note=payload.note,
        repeat=payload.repeat,
        last_side=_side(ltp, payload.target_price),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    row.current_price = ltp  # not a column: carried on the object so the response can say where the price is right now
    return row


@router.delete("/price-alerts/{alert_id}", status_code=204)
def delete_price_alert(alert_id: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    try:
        parsed = uuid.UUID(alert_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="alert not found")
    row = _visible(db.query(PriceAlert), user).filter(PriceAlert.id == parsed).first()
    if row is None:
        raise HTTPException(status_code=404, detail="alert not found")
    db.delete(row)
    db.commit()


@router.post("/price-alerts/check")
def run_check_now(db: Session = Depends(get_db), _admin: UUID = Depends(require_admin)):
    """Force one evaluation pass (what the scheduler does every minute) - operator only, for testing without waiting."""
    return {"fired": dispatch_due(db)}


@router.post("/price-alerts/test-telegram")
def test_telegram(user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Send a test message to the CALLER's own chat (never anyone else's), at most once every few seconds."""
    chat = get_channel(db, user.user_id)
    if not chat:
        raise HTTPException(status_code=400, detail="Set your Telegram chat first.")
    with _test_lock:
        wait = _TEST_MIN_GAP_SECONDS - (time.monotonic() - _last_test.get(user.user_id, 0.0))
        if wait > 0:
            raise HTTPException(status_code=429, detail=f"Just sent one - try again in {int(wait) + 1}s.")
        _last_test[user.user_id] = time.monotonic()
    error = send_telegram("Test alert from your trading app - your price alerts are wired up.", chat)
    if error:
        raise HTTPException(status_code=503, detail=f"Could not send: {error}.")
    return {"sent": True}
