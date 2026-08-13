from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.domain.models import ExecutionSettingsUpdate
from app.domain.position_manager import load_settings

router = APIRouter()


@router.get("/settings")
def get_settings(db: Session = Depends(get_db)):
    s = load_settings(db)
    return s.model_dump(mode="json")


@router.put("/settings")
def update_settings(update: ExecutionSettingsUpdate, db: Session = Depends(get_db)):
    row = db.get(db_models.Settings, 1)
    if update.usdinr_rate is not None:
        row.usdinr_rate = update.usdinr_rate
    db.commit()
    db.refresh(row)

    # No explicit reschedule needed - the square-off/exit-monitor jobs
    # run on a fixed interval and read current settings/position data
    # fresh each run (see app/scheduler.py).

    return load_settings(db).model_dump(mode="json")
