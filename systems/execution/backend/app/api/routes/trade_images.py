"""Screenshots/chart snapshots attached to a closed manual trade for future
review (Manual tab only) - see infra/postgres/init/02-execution.sql's own
comment on execution.trade_images for the full design. Upload isn't
restricted to CLOSED trades server-side (nothing here reads status at all)
- ManualTab.tsx only ever surfaces the upload control in a trade's own
history row, which is closed-trades-only by construction, so that scoping
lives entirely on the frontend rather than as a server-side rule."""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db

router = APIRouter()

_ALLOWED_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
_MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8MB - a chart screenshot, not a photo library


def _image_to_out(row: db_models.TradeImage) -> dict:
    return {
        "id": str(row.id),
        "content_type": row.content_type,
        "uploaded_at": row.uploaded_at.isoformat() if row.uploaded_at is not None else None,
    }


async def _save_image(
    db: Session, file: UploadFile, *, position_id: Optional[uuid.UUID] = None, option_group_id: Optional[uuid.UUID] = None
) -> db_models.TradeImage:
    if file.content_type not in _ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=422, detail=f"unsupported image type {file.content_type!r} - use PNG/JPEG/WEBP/GIF")
    data = await file.read()
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=422, detail=f"image too large - max {_MAX_IMAGE_BYTES // (1024 * 1024)}MB")
    row = db_models.TradeImage(
        position_id=position_id,
        option_group_id=option_group_id,
        content_type=file.content_type,
        image_data=data,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.post("/positions/{position_id}/images")
async def upload_position_image(position_id: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(position_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="position not found")
    if db.get(db_models.Position, parsed_id) is None:
        raise HTTPException(status_code=404, detail="position not found")
    row = await _save_image(db, file, position_id=parsed_id)
    return _image_to_out(row)


@router.get("/positions/{position_id}/images")
def list_position_images(position_id: str, db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(position_id)
    except ValueError:
        return []
    rows = db.query(db_models.TradeImage).filter_by(position_id=parsed_id).order_by(db_models.TradeImage.uploaded_at).all()
    return [_image_to_out(r) for r in rows]


@router.post("/option-groups/{group_id}/images")
async def upload_option_group_image(group_id: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")
    if db.get(db_models.OptionPositionGroup, parsed_id) is None:
        raise HTTPException(status_code=404, detail="option group not found")
    row = await _save_image(db, file, option_group_id=parsed_id)
    return _image_to_out(row)


@router.get("/option-groups/{group_id}/images")
def list_option_group_images(group_id: str, db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        return []
    rows = db.query(db_models.TradeImage).filter_by(option_group_id=parsed_id).order_by(db_models.TradeImage.uploaded_at).all()
    return [_image_to_out(r) for r in rows]


@router.get("/images/{image_id}")
def get_image(image_id: str, db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(image_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="image not found")
    row = db.get(db_models.TradeImage, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="image not found")
    # Cached aggressively client-side - an uploaded image is immutable
    # (no PUT/replace route, only upload-new/delete), so there's never a
    # staleness concern.
    return Response(content=row.image_data, media_type=row.content_type, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.delete("/images/{image_id}")
def delete_image(image_id: str, db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(image_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="image not found")
    row = db.get(db_models.TradeImage, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="image not found")
    db.delete(row)
    db.commit()
    return {"deleted": True}
