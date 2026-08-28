from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.adapters.db.session import get_db
from app.domain.processing.intake.core import archive_raw_payload
from app.domain.processing.models import RawIngest

router = APIRouter()


@router.post("/ingest/raw", status_code=202)
def ingest_raw(payload: RawIngest, db: Session = Depends(get_db)):
    """Archive a provider's raw payload before normalization, so a future
    format change can be debugged/replayed against real history."""
    row = archive_raw_payload(db, payload.provider, payload.raw_payload)
    return {"status": "archived", "id": row.id}
