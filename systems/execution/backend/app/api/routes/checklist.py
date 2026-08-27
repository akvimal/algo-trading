"""Trade discipline checklist (Manual tab only) - the user-editable master
list of pre-trade Plan items (GET/POST/PUT/DELETE /checklist-items) plus
the platform-wide post-trade review gate (GET /manual-trades/pending-review).
See infra/postgres/init/02-execution.sql's own comment on
execution.checklist_items and docs/architecture.md § 'Trade discipline
checklist' for the full design."""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.auth import User, get_current_user
from app.domain.models import ChecklistItemCreate, ChecklistItemUpdate, DailyChecklistSubmit
from app.domain.position_manager import (
    _today_in_tz,
    check_in_trading_session,
    check_out_trading_session,
    create_checklist_item,
    delete_checklist_item,
    find_pending_manual_review,
    get_daily_checklist,
    list_checklist_items,
    list_trading_sessions,
    load_settings,
    submit_daily_checklist,
    update_checklist_item,
)

router = APIRouter()


def _item_to_out(row: db_models.ChecklistItem) -> dict:
    return {
        "id": str(row.id),
        "label": row.label,
        "phase": row.phase,
        "segments": row.segments,
        "sort_order": row.sort_order,
        "active": row.active,
    }


def _daily_to_out(log_date, segment: str, row: Optional[db_models.DailyChecklistLog]) -> dict:
    return {
        "log_date": log_date.isoformat(),
        "segment": segment,
        "answers": row.answers if row is not None else None,
        "notes": row.notes if row is not None else None,
        "submitted_at": row.submitted_at.isoformat() if row is not None and row.submitted_at is not None else None,
    }


def _session_to_out(row: db_models.TradingSession) -> dict:
    return {
        "id": str(row.id),
        "log_date": row.log_date.isoformat(),
        "segment": row.segment,
        "checked_in_at": row.checked_in_at.isoformat(),
        "checked_out_at": row.checked_out_at.isoformat() if row.checked_out_at is not None else None,
    }


@router.get("/checklist-items")
def get_checklist_items(
    active_only: bool = False,
    phase: Optional[str] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """active_only=true is what ManualTab.tsx renders as checkboxes
    (filtered client-side by phase - 'plan' per-row, 'review' in the
    review banner, 'day' in the once-a-day panel - and, within each
    phase, further by `segments`); the unfiltered default backs the
    "manage checklist" editor, which also shows inactive items so they
    can be re-activated. `phase` narrows server-side too, for callers
    that only want one list. Returns THIS user's own editable copy of
    the checklist (cloned from the platform default template on first
    access - see list_checklist_items's own docstring)."""
    return [_item_to_out(r) for r in list_checklist_items(db, user.id, active_only=active_only, phase=phase)]


@router.post("/checklist-items")
def create_item(payload: ChecklistItemCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = create_checklist_item(db, user.id, payload.label, payload.phase, payload.segments, payload.sort_order)
    return _item_to_out(row)


@router.put("/checklist-items/{item_id}")
def update_item(
    item_id: str, payload: ChecklistItemUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    try:
        parsed_id = uuid.UUID(item_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="checklist item not found")
    row = update_checklist_item(
        db, user.id, parsed_id, payload.label, payload.phase, payload.segments, payload.sort_order, payload.active
    )
    if row is None:
        raise HTTPException(status_code=404, detail="checklist item not found")
    return _item_to_out(row)


@router.delete("/checklist-items/{item_id}")
def delete_item(item_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(item_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="checklist item not found")
    if not delete_checklist_item(db, user.id, parsed_id):
        raise HTTPException(status_code=404, detail="checklist item not found")
    return {"deleted": True}


@router.get("/manual-trades/pending-review")
def get_pending_review(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Polled by ManualTab.tsx - non-null `pending` means every row's Add
    button stays disabled until PUT /positions/{id}/review or
    PUT /option-groups/{id}/review is submitted for it. See
    find_pending_manual_review's own docstring for what "earliest" means
    across the two tables, scoped to this user's own trades only."""
    return {"pending": find_pending_manual_review(db, user.id)}


@router.get("/daily-checklist")
def get_daily(segment: str = Query(...), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Today's (server-computed date, `segment`) submission, or
    answers/submitted_at=null if nothing's been submitted yet - see
    get_daily_checklist's own docstring."""
    settings = load_settings(db, user.id)
    row = get_daily_checklist(db, user.id, settings, segment)
    return _daily_to_out(_today_in_tz(settings.timezone), segment, row)


@router.put("/daily-checklist")
def put_daily(payload: DailyChecklistSubmit, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Upserts today's (server-computed date, segment) row - see
    submit_daily_checklist's own docstring. Clears
    find_missing_daily_checklist's gate for `segment` for the rest of
    today."""
    settings = load_settings(db, user.id)
    row = submit_daily_checklist(db, user.id, settings, payload.segment, [a.model_dump() for a in payload.answers], payload.notes)
    return _daily_to_out(row.log_date, payload.segment, row)


@router.get("/trading-sessions")
def get_trading_sessions(
    segment: Optional[str] = Query(default=None), user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Whole-table listing (optionally filtered to one segment) - see
    list_trading_sessions's own docstring for why this doesn't take a
    date range. ManualTab.tsx filters to today client-side for its
    check-in/out bar; ManualStatsPage.tsx keys the rest by day."""
    return [_session_to_out(r) for r in list_trading_sessions(db, user.id, segment)]


@router.post("/trading-sessions/check-in")
def post_check_in(segment: str = Query(...), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Starts a new session for today (server-computed date, segment),
    or returns the already-open one unchanged if there is one - see
    check_in_trading_session's own docstring. ManualTab.tsx's Check In
    button is disabled whenever a session is already open, so this
    no-op path is a defensive mirror, not the normal case."""
    settings = load_settings(db, user.id)
    row = check_in_trading_session(db, user.id, settings, segment)
    return _session_to_out(row)


@router.post("/trading-sessions/check-out")
def post_check_out(segment: str = Query(...), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Closes today's currently-open session - see
    check_out_trading_session's own docstring. 409s if none is open
    (ManualTab.tsx's Check Out button is disabled in that state, so this
    is a defensive mirror, not the normal case)."""
    settings = load_settings(db, user.id)
    row = check_out_trading_session(db, user.id, settings, segment)
    if row is None:
        raise HTTPException(status_code=409, detail=f"no open trading session for {segment} today")
    return _session_to_out(row)
