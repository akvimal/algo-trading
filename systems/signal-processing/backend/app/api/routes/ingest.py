from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.domain.models import RawIngest

router = APIRouter()


@router.post("/ingest/raw", status_code=202)
def ingest_raw(payload: RawIngest, db: Session = Depends(get_db)):
    """Archive a provider's raw payload before normalization, so a future
    format change can be debugged/replayed against real history."""
    row = db_models.RawSignalPayload(provider=payload.provider, raw_payload=payload.raw_payload)
    db.add(row)
    db.commit()
    return {"status": "archived", "id": row.id}
