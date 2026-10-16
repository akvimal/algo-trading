"""The in-app inbox (app/domain/inbox.py): GET /inbox, GET /inbox/unread-count, POST /inbox/{id}/read, POST /inbox/{id}/unread,
POST /inbox/read-all, DELETE /inbox/{id}. Private to the caller on every route."""

import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.adapters.db.session import get_db
from app.auth import User, get_current_user
from app.domain import inbox

router = APIRouter()


class InboxItemOut(BaseModel):
    id: str
    kind: str
    category: str
    severity: str
    title: str
    body: Optional[str]
    link: Optional[str]
    created_at: datetime
    read: bool


class InboxOut(BaseModel):
    unread: int
    items: list[InboxItemOut]
    categories: list[dict]


def _out(r) -> InboxItemOut:
    return InboxItemOut(id=str(r.id), kind=r.kind, category=r.category, severity=r.severity, title=r.title, body=r.body, link=r.link, created_at=r.created_at, read=r.read_at is not None)


def _item_id(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise HTTPException(status_code=404, detail="item not found")


@router.get("/inbox", response_model=InboxOut)
def get_inbox(unread_only: bool = False, category: Optional[str] = None, limit: int = Query(50, ge=1, le=inbox.MAX_LIST), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Newest first, open to-dos on top. Brings the self-clearing to-dos up to date first."""
    inbox.refresh_todos(db, user.id)
    return InboxOut(
        unread=inbox.unread_count(db, user.id),
        items=[_out(r) for r in inbox.list_items(db, user.id, unread_only, category, limit)],
        categories=inbox.categories(db, user.id),
    )


@router.get("/inbox/unread-count")
def unread_count(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """What the bell shows. Refreshes the to-dos too, so the count is true without opening the list."""
    inbox.refresh_todos(db, user.id)
    return {"unread": inbox.unread_count(db, user.id)}


@router.post("/inbox/read-all")
def read_all(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"marked": inbox.mark_all_read(db, user.id)}


@router.post("/inbox/{item_id}/read")
def read(item_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not inbox.mark_read(db, user.id, _item_id(item_id), True):
        raise HTTPException(status_code=404, detail="item not found")
    return {"ok": True}


@router.post("/inbox/{item_id}/unread")
def unread(item_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not inbox.mark_read(db, user.id, _item_id(item_id), False):
        raise HTTPException(status_code=404, detail="item not found")
    return {"ok": True}


@router.delete("/inbox/{item_id}")
def dismiss(item_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not inbox.dismiss(db, user.id, _item_id(item_id)):
        raise HTTPException(status_code=404, detail="item not found")
    return {"ok": True}
