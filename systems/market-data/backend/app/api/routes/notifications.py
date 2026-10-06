"""Subscribing to Telegram notifications (app/domain/notifications.py): which categories a person has on, their settings, a delivery
history, and "send me the latest now" to check a category works without waiting for its schedule.

Every route needs a signed-in user, and a person only ever sees and changes their own subscriptions. The operator category is
admin-only. Messages go to the person's own chat (the one their price alerts use); every category starts off."""

import threading
import time
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.adapters.db.models import AlertChannel, JobRun, NotificationLog, NotificationSubscription
from app.adapters.db.session import get_db
from app.auth import User, require_user
from app.domain import notification_jobs, notifications as n
from app.domain.premarket_report import get_report

router = APIRouter()

_SEND_NOW_MIN_GAP_SECONDS = 20
_lock = threading.Lock()
_last_send: dict[tuple[UUID, str], float] = {}


class SubscriptionIn(BaseModel):
    enabled: bool
    params: Optional[dict] = None


class CategoryOut(BaseModel):
    key: str
    label: str
    description: str
    schedule: str
    admin_only: bool
    enabled: bool
    params: dict


class NotificationsOut(BaseModel):
    chat_ready: bool  # the person has set a Telegram chat; without one nothing can be sent
    categories: list[CategoryOut]


class DeliveryOut(BaseModel):
    category: str
    label: str
    manual: bool  # sent by "send me the latest now", not on schedule
    created_at: datetime
    sent_at: Optional[datetime] = None
    status: str  # "sent" | "retrying" | "gave_up"
    attempts: int
    last_error: Optional[str] = None
    first_line: str


def _fail(e: n.NotificationError) -> HTTPException:
    return HTTPException(status_code=e.status, detail=e.detail)


def _has_chat(db: Session, user_id: UUID) -> bool:
    return db.get(AlertChannel, user_id) is not None


def _visible(user: User) -> list[n.Category]:
    return [c for c in n.CATEGORIES.values() if user.is_admin or not c.admin_only]


def _state(db: Session, user: User) -> NotificationsOut:
    subs = {s.category: s for s in db.query(NotificationSubscription).filter(NotificationSubscription.user_id == user.user_id).all()}
    cats = []
    for c in _visible(user):
        s = subs.get(c.key)
        cats.append(CategoryOut(key=c.key, label=c.label, description=c.description, schedule=c.schedule, admin_only=c.admin_only, enabled=bool(s and s.enabled), params={**c.defaults, **((s.params if s else None) or {})}))
    return NotificationsOut(chat_ready=_has_chat(db, user.user_id), categories=cats)


def _category(user: User, key: str) -> n.Category:
    cat = n.CATEGORIES.get(key)
    if cat is None:
        raise HTTPException(status_code=404, detail=f"unknown notification '{key}'")
    if cat.admin_only and not user.is_admin:
        raise HTTPException(status_code=403, detail="admin access required")
    return cat


@router.get("/notifications", response_model=NotificationsOut)
def get_notifications(user: User = Depends(require_user), db: Session = Depends(get_db)):
    return _state(db, user)


@router.put("/notifications/{category}", response_model=NotificationsOut)
def set_notification(category: str, payload: SubscriptionIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    cat = _category(user, category)
    try:
        params = n.clean_params(cat.key, payload.params)
    except n.NotificationError as e:
        raise _fail(e)
    row = db.get(NotificationSubscription, (user.user_id, cat.key))
    if row is None:
        db.add(NotificationSubscription(user_id=user.user_id, category=cat.key, enabled=payload.enabled, params=params))
    else:
        row.enabled, row.params, row.updated_at = payload.enabled, params, datetime.now(timezone.utc)
    db.commit()
    return _state(db, user)


def _status(row: NotificationLog) -> str:
    if row.sent_at is not None:
        return "sent"
    return "gave_up" if (row.attempts or 0) >= n.MAX_ATTEMPTS else "retrying"


@router.get("/notifications/history", response_model=list[DeliveryOut])
def history(limit: int = 30, user: User = Depends(require_user), db: Session = Depends(get_db)):
    rows = db.query(NotificationLog).filter(NotificationLog.user_id == user.user_id).order_by(NotificationLog.created_at.desc()).limit(max(1, min(limit, 100))).all()
    return [
        DeliveryOut(
            category=r.category, label=n.CATEGORIES[r.category].label if r.category in n.CATEGORIES else r.category, manual=r.dedupe_key.startswith("manual:"),
            created_at=r.created_at, sent_at=r.sent_at, status=_status(r), attempts=r.attempts or 0, last_error=r.last_error, first_line=r.text.split("\n", 1)[0][:120],
        )
        for r in rows
    ]


def _latest_text(db: Session, user: User, cat: n.Category) -> str:
    """The message a category would send right now, from the latest data, with this person's settings."""
    if cat.key == "premarket":
        row = get_report(db)
        if row is None:
            raise HTTPException(status_code=404, detail="There is no pre-market report yet.")
        return n.premarket_message({"inputs": row.inputs, "rules": row.rules, "ai": row.ai}, row.day)
    if cat.key == "oi_buildup":
        rows, snapshot_date = notification_jobs.latest_oi_rows(db)
        sub = db.get(NotificationSubscription, (user.user_id, cat.key))
        text = n.oi_digest_message(rows, snapshot_date, {**cat.defaults, **((sub.params if sub else None) or {})}["top_n"]) if snapshot_date else None
        if not text:
            raise HTTPException(status_code=404, detail="No stock moved enough in price and open interest in the latest scan." if snapshot_date else "There is no OI scan yet.")
        return text
    if cat.key in ("session_nse", "session_mcx", "session_crypto"):
        return _session_text(db, user, {"session_nse": "NSE", "session_mcx": "MCX"}.get(cat.key, "CRYPTO"))
    return notification_jobs.ops_status_text(db, datetime.now(timezone.utc))


def _latest_message(db: Session, user: User, cat: n.Category):
    """(text, picture, caption) for a category's latest message; only the session summaries have a picture."""
    if cat.key in ("session_nse", "session_mcx", "session_crypto"):
        return _session_parts(db, user, {"session_nse": "NSE", "session_mcx": "MCX"}.get(cat.key, "CRYPTO"))
    if cat.key == "premarket":
        row = get_report(db)
        text = _latest_text(db, user, cat)
        image, caption = notification_jobs.premarket_card_for({"inputs": row.inputs, "rules": row.rules, "ai": row.ai}, row.day)
        return text, image, caption
    text = _latest_text(db, user, cat)
    if cat.key == "oi_buildup":
        rows, snapshot_date = notification_jobs.latest_oi_rows(db)
        sub = db.get(NotificationSubscription, (user.user_id, cat.key))
        top_n = {**cat.defaults, **((sub.params if sub else None) or {})}["top_n"]
        image, caption = notification_jobs.oi_card_for(rows, snapshot_date, top_n)
        return text, image, caption
    return text, None, None


def _session_text(db: Session, user: User, segment: str) -> str:
    return _session_parts(db, user, segment)[0]


def _session_parts(db: Session, user: User, segment: str):
    """The latest post-session summary for this person (the latest NSE session, or the last 24 hours of crypto), for a manual send."""
    from app.adapters import execution_client
    from app.providers import session_market

    try:
        market = {"NSE": session_market.fetch_nse, "MCX": session_market.fetch_mcx}.get(segment, session_market.fetch_crypto)()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"The market data could not be read: {exc}")
    trader = execution_client.trader_day(user.user_id, segment, market["day"])
    report = get_report(db, market["day"]) if segment == "NSE" else None
    bias = (((report.ai or {}).get("bias")) or (report.rules or {}).get("bias")) if report is not None else None
    zones = notification_jobs.zone_recap_for(db, user.user_id, segment, market["day"])
    text = n.session_message(segment, market["day"], market, trader, bias, trader_known=trader is not None, zones=zones)
    image, caption = notification_jobs.session_card_for(segment, market["day"], market, trader, bias, zones)
    return text, image, caption


@router.post("/notifications/{category}/send-now")
def send_now(category: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Send the latest message of a category to the caller's own chat right now (at most once every 20 s per category), to check it works.
    It is recorded in the delivery history as a manual send and is never retried."""
    cat = _category(user, category)
    chat = db.get(AlertChannel, user.user_id)
    if chat is None:
        raise HTTPException(status_code=400, detail="Set your Telegram chat first.")
    with _lock:
        wait = _SEND_NOW_MIN_GAP_SECONDS - (time.monotonic() - _last_send.get((user.user_id, cat.key), 0.0))
        if wait > 0:
            raise HTTPException(status_code=429, detail=f"Just sent one - try again in {int(wait) + 1}s.")
        _last_send[(user.user_id, cat.key)] = time.monotonic()
    text, image, caption = _latest_message(db, user, cat)
    now = datetime.now(timezone.utc)
    key = f"manual:{now.isoformat()}"
    outcome = n.deliver(db, user.user_id, chat.telegram_chat_id, cat.key, key, text, now, image=image, caption=caption)
    if outcome != "sent":
        row = db.get(NotificationLog, (user.user_id, cat.key, key))
        reason = row.last_error if row else "unknown"
        if row is not None:
            row.attempts = n.MAX_ATTEMPTS  # a manual send is not retried in the background: the person is looking at it
            db.commit()
        raise HTTPException(status_code=502, detail=f"Could not send: {reason}.")
    return {"sent": True}
