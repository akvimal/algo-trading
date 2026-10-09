"""The thoughts-and-plans panel under a chart: private free-text notes, each with the market context at the time and
an optional chart snapshot (see infra/postgres/migrations/031-study-notes.sql).

Every query is scoped to the caller's user_id; a note that is not theirs is simply not found. Nothing here reads
the notes back into any model - they are a record for the person's own study, and for a later, explicit
"include my plan" step in the AI read."""

import base64
import binascii
import json
import uuid
from datetime import date, datetime, time, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.config import settings
from app.domain.models import StudyNoteCreate, StudyNoteInstrumentOut, StudyNoteOut

MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024  # a composed chart image, not a photo
MAX_CONTEXT_BYTES = 16 * 1024
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


class StudyNoteError(Exception):
    """A request the caller can fix; carries the HTTP status the route should use."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def decode_snapshot(raw: Optional[str]) -> Optional[bytes]:
    """The PNG bytes of a data URL or bare base64 string, or None for nothing sent. Refuses anything that is not a
    PNG, or is too large, so the column can only ever hold a chart image of a sensible size."""
    if raw is None or not raw.strip():
        return None
    body = raw.strip()
    if body.startswith("data:"):
        head, _, body = body.partition(",")
        if "image/png" not in head:
            raise StudyNoteError(422, "the snapshot must be a PNG image")
    try:
        data = base64.b64decode(body, validate=True)
    except (binascii.Error, ValueError):
        raise StudyNoteError(422, "the snapshot is not valid base64")
    if not data.startswith(_PNG_MAGIC):
        raise StudyNoteError(422, "the snapshot must be a PNG image")
    if len(data) > MAX_SNAPSHOT_BYTES:
        raise StudyNoteError(422, f"the snapshot is too large (max {MAX_SNAPSHOT_BYTES // (1024 * 1024)}MB)")
    return data


def _uuid_or_none(value: Optional[str], what: str) -> Optional[uuid.UUID]:
    if value is None or not value.strip():
        return None
    try:
        return uuid.UUID(value.strip())
    except ValueError:
        raise StudyNoteError(422, f"{what} is not a valid id")


def to_out(row: db_models.StudyNote, has_snapshot: bool, has_clean_snapshot: bool = False) -> StudyNoteOut:
    return StudyNoteOut(
        id=str(row.id), segment=row.segment, symbol=row.symbol, interval=row.interval, text=row.text, tag=row.tag,
        context=row.context, position_id=str(row.position_id) if row.position_id is not None else None,
        option_group_id=str(row.option_group_id) if row.option_group_id is not None else None,
        has_snapshot=has_snapshot, has_clean_snapshot=has_clean_snapshot, created_at=row.created_at,
    )


def create_note(db: Session, user_id: uuid.UUID, payload: StudyNoteCreate) -> StudyNoteOut:
    text = payload.text.strip()
    if not text:
        raise StudyNoteError(422, "write something first")
    if payload.context is not None and len(json.dumps(payload.context, default=str)) > MAX_CONTEXT_BYTES:
        raise StudyNoteError(422, "the market context attached to this note is too large")
    png = decode_snapshot(payload.snapshot_png_base64)
    clean = decode_snapshot(payload.clean_png_base64)
    row = db_models.StudyNote(
        user_id=user_id, segment=payload.segment, symbol=payload.symbol.strip().upper(), interval=payload.interval,
        text=text, tag=payload.tag, context=payload.context, snapshot_png=png, snapshot_clean_png=clean,
        position_id=_uuid_or_none(payload.position_id, "position_id"), option_group_id=_uuid_or_none(payload.option_group_id, "option_group_id"),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return to_out(row, png is not None, clean is not None)


def _day_bounds(day: date) -> tuple[datetime, datetime]:
    tz = ZoneInfo(settings.equity_history_timezone)
    start = datetime.combine(day, time.min, tzinfo=tz)
    return start, start + timedelta(days=1)


def _like_pattern(text: str) -> str:
    """`text` as a substring pattern with the LIKE wildcards in it taken literally."""
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def list_notes(
    db: Session,
    user_id: uuid.UUID,
    segment: Optional[str] = None,
    symbol: Optional[str] = None,
    day: Optional[date] = None,
    limit: int = 200,
    *,
    tag: Optional[str] = None,
    q: Optional[str] = None,
    newest_first: bool = False,
    offset: int = 0,
) -> list[StudyNoteOut]:
    """The person's notes, optionally narrowed to one instrument, a tag, a day (the platform's trading timezone) or text
    they contain. Default order is oldest first within the latest `limit` (a conversation reads top-down); with
    `newest_first` it is newest first and `offset` pages back through the history."""
    N = db_models.StudyNote
    query = db.query(N).filter(N.user_id == user_id)
    if segment:
        query = query.filter(N.segment == segment)
    if symbol:
        query = query.filter(N.symbol == symbol.strip().upper())
    if tag:
        query = query.filter(N.tag == tag)
    if q and q.strip():
        query = query.filter(N.text.ilike(_like_pattern(q.strip()), escape="\\"))
    if day is not None:
        start, end = _day_bounds(day)
        query = query.filter(N.created_at >= start, N.created_at < end)
    rows = query.order_by(N.created_at.desc()).offset(max(0, offset)).limit(limit).all()
    ids_with_image = _ids_with_snapshot(db, user_id, [r.id for r in rows])
    ids_with_clean = _ids_with_snapshot(db, user_id, [r.id for r in rows], clean=True)
    ordered = rows if newest_first else list(reversed(rows))
    return [to_out(r, r.id in ids_with_image, r.id in ids_with_clean) for r in ordered]


def list_instruments(db: Session, user_id: uuid.UUID) -> list[StudyNoteInstrumentOut]:
    """Every instrument the person has notes on, most recently written first, with how many."""
    N = db_models.StudyNote
    rows = (
        db.query(N.segment, N.symbol, func.count(N.id), func.max(N.created_at))
        .filter(N.user_id == user_id)
        .group_by(N.segment, N.symbol)
        .order_by(func.max(N.created_at).desc())
        .all()
    )
    return [StudyNoteInstrumentOut(segment=r[0], symbol=r[1], count=int(r[2]), last_at=r[3]) for r in rows]


def _ids_with_snapshot(db: Session, user_id: uuid.UUID, ids: list[uuid.UUID], clean: bool = False) -> set[uuid.UUID]:
    if not ids:
        return set()
    N = db_models.StudyNote
    column = N.snapshot_clean_png if clean else N.snapshot_png
    rows = db.query(N.id).filter(N.user_id == user_id, N.id.in_(ids), column.isnot(None)).all()
    return {r[0] for r in rows}


def get_snapshot(db: Session, user_id: uuid.UUID, note_id: uuid.UUID, clean: bool = False) -> Optional[bytes]:
    """The note's picture: the composed one (with the note text and any AI line), or with `clean` the chart-and-header-only one."""
    row = db.get(db_models.StudyNote, note_id)
    if row is None or row.user_id != user_id:
        return None
    data = row.snapshot_clean_png if clean else row.snapshot_png
    return bytes(data) if data is not None else None


def delete_note(db: Session, user_id: uuid.UUID, note_id: uuid.UUID) -> bool:
    N = db_models.StudyNote
    deleted = db.query(N).filter(N.id == note_id, N.user_id == user_id).delete(synchronize_session=False)
    db.commit()
    return deleted == 1
