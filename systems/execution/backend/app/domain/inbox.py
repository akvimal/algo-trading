"""The in-app inbox: warnings, alerts and to-dos for one person, unread until opened (migration 066).

Two kinds of line. An *event* is a one-off (a loss limit hit, an OI shift, a bot entry); posting the same dedupe key again is ignored, so a
check that runs every five minutes does not fill the inbox. A *to-do* is a live condition (trades still owing a review): it is created while
the condition holds, updated in place as it changes, and marked resolved the moment it no longer holds, so it never goes stale.

Other services post events over the internal route (app/api/routes/internal.py); this service posts its own directly."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models

KINDS = ("event", "todo")
SEVERITIES = ("info", "warn", "alert")
MAX_LIST = 100
KEEP_DAYS = 30  # an event older than this is not listed; a read or dismissed one earlier than that stays gone
REVIEW_TODO_KEY = "todo:review"
REVIEW_WINDOW_DAYS = 30

I = db_models.InboxItem


class InboxError(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def post(db: Session, user_id: UUID, category: str, title: str, body: Optional[str] = None, link: Optional[str] = None, severity: str = "info",
         dedupe_key: Optional[str] = None, kind: str = "event") -> Optional[db_models.InboxItem]:
    """Add one line. Returns it, or None when the same dedupe key is already there (an event is posted once). Never raises on a duplicate."""
    if kind not in KINDS:
        raise InboxError(f"unknown kind '{kind}'")
    if severity not in SEVERITIES:
        raise InboxError(f"unknown severity '{severity}'")
    if not category.strip() or not title.strip():
        raise InboxError("a category and a title are required")
    if dedupe_key is not None and db.query(I.id).filter(I.user_id == user_id, I.dedupe_key == dedupe_key).first() is not None:
        return None
    item = I(user_id=user_id, kind=kind, category=category.strip()[:40], severity=severity, title=title.strip()[:200],
             body=(body or None) and body[:4000], link=(link or None) and link[:300], dedupe_key=dedupe_key)
    db.add(item)
    try:
        db.commit()
    except IntegrityError:  # two posters raced on the same key
        db.rollback()
        return None
    return item


def sync_todo(db: Session, user_id: UUID, key: str, category: str, active: bool, title: str = "", body: Optional[str] = None, link: Optional[str] = None,
              severity: str = "warn") -> None:
    """Keep a to-do in step with the condition it stands for. While `active` it exists (title/body updated in place, and it comes back unread
    if it had been resolved or if it changed); when not, it is marked resolved."""
    row = db.query(I).filter(I.user_id == user_id, I.dedupe_key == key).first()
    if not active:
        if row is not None and row.resolved_at is None:
            row.resolved_at = _now()
            db.commit()
        return
    if row is None:
        post(db, user_id, category, title, body, link, severity, dedupe_key=key, kind="todo")
        return
    changed = row.title != title or row.resolved_at is not None
    row.title, row.body, row.link, row.severity, row.category, row.kind = title, body, link, severity, category, "todo"
    if changed:
        row.read_at, row.dismissed_at, row.resolved_at, row.created_at = None, None, None, _now()
    db.commit()


def unreviewed_total(db: Session, user_id: UUID, now: Optional[datetime] = None) -> int:
    """Closed manual trades of the last month, any segment, with no 'what went wrong' review yet."""
    since = (now or _now()) - timedelta(days=REVIEW_WINDOW_DAYS)
    P, G = db_models.Position, db_models.OptionPositionGroup
    singles = db.query(P.id).filter(
        P.user_id == user_id, P.strategy_id.is_(None), P.status == "CLOSED", P.option_group_id.is_(None), P.horizon != "positional",
        P.exit_time >= since, P.root_cause.is_(None), P.auto_traded.isnot(True),
    ).all()
    groups = db.query(G.id).filter(
        G.user_id == user_id, G.strategy_id.is_(None), G.status == "CLOSED", G.exit_time >= since, G.root_cause.is_(None), G.auto_traded.isnot(True),
    ).all()
    owed = {str(r[0]) for r in singles + groups}
    if not owed:
        return 0
    # a trade that went to plan needs no review, so it is not owed
    from app.domain.on_plan import on_plan_for_user  # local: the scoring pulls in more than the inbox otherwise needs

    return len(owed - on_plan_for_user(db, user_id, since.date()))


def refresh_todos(db: Session, user_id: UUID) -> None:
    """Bring the self-clearing to-dos up to date. Cheap; run when the inbox is opened or counted."""
    n = unreviewed_total(db, user_id)
    sync_todo(
        db, user_id, REVIEW_TODO_KEY, "review", n > 0,
        title=f"{n} closed trade{'s' if n != 1 else ''} not reviewed yet",
        body="Tag what went wrong (study, plan or execution), or mark the trade clean. It takes a tap per trade.",
        link="/portfolio?tab=review",
    )


def _visible(db: Session, user_id: UUID):
    cutoff = _now() - timedelta(days=KEEP_DAYS)
    return db.query(I).filter(I.user_id == user_id, I.dismissed_at.is_(None), I.resolved_at.is_(None), I.created_at >= cutoff)


def unread_count(db: Session, user_id: UUID) -> int:
    return _visible(db, user_id).filter(I.read_at.is_(None)).count()


def list_items(db: Session, user_id: UUID, unread_only: bool = False, category: Optional[str] = None, limit: int = 50) -> list[db_models.InboxItem]:
    q = _visible(db, user_id)
    if unread_only:
        q = q.filter(I.read_at.is_(None))
    if category:
        q = q.filter(I.category == category)
    # open to-dos first (they are the things to do), then newest first
    return q.order_by((I.kind == "todo").desc(), I.created_at.desc()).limit(max(1, min(limit, MAX_LIST))).all()


def categories(db: Session, user_id: UUID) -> list[dict]:
    rows = _visible(db, user_id).with_entities(I.category, func.count(I.id), func.count(I.id).filter(I.read_at.is_(None))).group_by(I.category).all()
    return [{"category": c, "count": n, "unread": u} for c, n, u in sorted(rows)]


def _own(db: Session, user_id: UUID, item_id: UUID) -> Optional[db_models.InboxItem]:
    row = db.get(I, item_id)
    return row if row is not None and row.user_id == user_id else None


def mark_read(db: Session, user_id: UUID, item_id: UUID, read: bool = True) -> bool:
    row = _own(db, user_id, item_id)
    if row is None:
        return False
    row.read_at = (row.read_at or _now()) if read else None
    db.commit()
    return True


def mark_all_read(db: Session, user_id: UUID) -> int:
    now = _now()
    n = _visible(db, user_id).filter(I.read_at.is_(None)).update({I.read_at: now}, synchronize_session=False)
    db.commit()
    return n


def dismiss(db: Session, user_id: UUID, item_id: UUID) -> bool:
    """Hide a line. A dismissed to-do stays gone until its condition clears and comes back (sync_todo re-opens it as new)."""
    row = _own(db, user_id, item_id)
    if row is None:
        return False
    row.dismissed_at = _now()
    row.read_at = row.read_at or row.dismissed_at
    db.commit()
    return True
