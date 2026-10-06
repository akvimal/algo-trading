"""The thoughts-and-plans panel under a chart: POST/GET/DELETE /study-notes, and the note's chart snapshot at
GET /study-notes/{id}/snapshot. See app/domain/study_notes.py. Private to the caller on every route."""

import uuid
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.adapters.db.session import get_db
from app.auth import User, get_current_user
from app.domain.models import StudyNoteCreate, StudyNoteInstrumentOut, StudyNoteOut
from app.domain.study_notes import StudyNoteError, create_note, delete_note, get_snapshot, list_instruments, list_notes

router = APIRouter()


def _note_id(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise HTTPException(status_code=404, detail="note not found")


@router.post("/study-notes", response_model=StudyNoteOut, status_code=201)
def add_note(payload: StudyNoteCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        return create_note(db, user.id, payload)
    except StudyNoteError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.get("/study-notes", response_model=list[StudyNoteOut])
def get_notes(
    segment: Optional[str] = Query(default=None, pattern="^(NSE|MCX|CRYPTO)$"),
    symbol: Optional[str] = Query(default=None, min_length=1, max_length=64),
    day: Optional[date] = Query(default=None, description="One calendar day (trading timezone); omit for the latest notes"),
    tag: Optional[str] = Query(default=None, pattern="^(plan|observation|mistake|review)$"),
    q: Optional[str] = Query(default=None, max_length=200, description="Only notes whose text contains this"),
    newest_first: bool = Query(default=False),
    offset: int = Query(default=0, ge=0, le=100000),
    limit: int = Query(default=200, ge=1, le=500),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The caller's notes. Narrow by instrument (segment + symbol), tag, day or text; `newest_first` with `offset` pages
    back through the whole history, which is what the notes history page does."""
    return list_notes(db, user.id, segment, symbol, day, limit, tag=tag, q=q, newest_first=newest_first, offset=offset)


@router.get("/study-notes/instruments", response_model=list[StudyNoteInstrumentOut])
def get_note_instruments(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every instrument the caller has notes on, most recently written first, with a count."""
    return list_instruments(db, user.id)


@router.get("/study-notes/{note_id}/snapshot")
def note_snapshot(
    note_id: str,
    variant: str = Query(default="full", pattern="^(full|clean)$", description="full = the composed picture; clean = the chart with only a header"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    data = get_snapshot(db, user.id, _note_id(note_id), clean=(variant == "clean"))
    if data is None:
        raise HTTPException(status_code=404, detail="no snapshot for this note")
    return Response(content=data, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@router.delete("/study-notes/{note_id}", status_code=204)
def remove_note(note_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not delete_note(db, user.id, _note_id(note_id)):
        raise HTTPException(status_code=404, detail="note not found")
    return Response(status_code=204)
