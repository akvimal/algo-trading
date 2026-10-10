"""Chart snapshots kept with a trade: the plan at the moment of entry, and pictures taken later after the chart, the stop or the target was changed.

A snapshot is a PNG of the chart as the person saw it (their drawings, their indicators, the planned or live entry / stop / target lines), composed in
the browser, stored in execution.trade_images against a position or an option spread. Each carries what the trade looked like when it was taken
(entry, stop, target), a kind (entry / update / upload) and an optional caption, so a trade's pictures read as its story.

This module is the one place that writes them: the upload routes, a waiting order that fills (its plan picture comes with it) and a trade opened from a
plan note (the note's own picture comes with it) all go through `add_image`."""

import logging
import uuid
from typing import Optional

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models

logger = logging.getLogger(__name__)

KINDS = ("upload", "entry", "update")
CAPTION_MAX = 500
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # a chart picture, not a photo library


def add_image(
    db: Session,
    *,
    data: bytes,
    content_type: str = "image/png",
    position_id: Optional[uuid.UUID] = None,
    option_group_id: Optional[uuid.UUID] = None,
    kind: str = "upload",
    caption: Optional[str] = None,
    entry: Optional[float] = None,
    stop: Optional[float] = None,
    target: Optional[float] = None,
) -> db_models.TradeImage:
    """Stores one picture against a position or a spread (exactly one of them). Does not commit past its own: the caller has already checked who owns the trade."""
    if (position_id is None) == (option_group_id is None):
        raise ValueError("a snapshot belongs to exactly one position or option spread")
    if kind not in KINDS:
        raise ValueError(f"unknown snapshot kind {kind!r}")
    row = db_models.TradeImage(
        position_id=position_id, option_group_id=option_group_id, content_type=content_type, image_data=data, kind=kind,
        caption=(caption or "").strip()[:CAPTION_MAX] or None, entry_price=entry, stop_price=stop, target_price=target,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _f(v) -> Optional[float]:
    return float(v) if v is not None else None


def attach_plan_snapshot(db: Session, order, position_id: Optional[uuid.UUID] = None, option_group_id: Optional[uuid.UUID] = None) -> bool:
    """A waiting order that has just filled hands its plan picture to the position (or spread) it opened: the chart as planned, with the levels it was
    armed at. Never fails the fill: a trade that opened is more important than its picture. True when a picture was attached."""
    try:
        data = getattr(order, "plan_snapshot", None)
        if not data:
            return False
        add_image(
            db, data=bytes(data), position_id=position_id, option_group_id=option_group_id, kind="entry",
            caption="The plan when the order was placed", entry=_f(order.trigger_price), stop=_f(order.stop_loss_price), target=_f(order.target_price),
        )
        return True
    except Exception:
        logger.exception("could not attach the plan picture of pending order %s", getattr(order, "id", "?"))
        db.rollback()
        return False


def copy_note_snapshot(db: Session, note, position_id: uuid.UUID) -> bool:
    """A trade opened from a plan note keeps the note's own picture (the chart as it was when the plan was written, drawings and indicators included)
    as its plan at entry, with the levels the position actually opened with. Never fails the trade."""
    try:
        data = getattr(note, "snapshot_png", None)
        if not data:
            return False
        pos = db.get(db_models.Position, position_id)
        add_image(
            db, data=bytes(data), position_id=position_id, kind="entry", caption="From your plan note",
            entry=_f(getattr(pos, "entry_price", None)), stop=_f(getattr(pos, "stop_loss_price", None)), target=_f(getattr(pos, "target_price", None)),
        )
        return True
    except Exception:
        logger.exception("could not copy the plan note's picture to position %s", position_id)
        db.rollback()
        return False
