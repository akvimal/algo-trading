from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.auth import User, get_current_user
from app.domain.models import ExecutionSettingsUpdate
from app.domain.position_manager import load_settings

router = APIRouter()


@router.get("/settings")
def get_settings(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    s = load_settings(db, user.id)
    return s.model_dump(mode="json")


@router.put("/settings")
def update_settings(update: ExecutionSettingsUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    load_settings(db, user.id)  # ensures a row exists (lazy-create) before mutating it below
    row = db.query(db_models.Settings).filter_by(user_id=user.id).one()
    if update.usdinr_rate is not None:
        row.usdinr_rate = update.usdinr_rate
    db.commit()
    db.refresh(row)

    # No explicit reschedule needed - the square-off/exit-monitor jobs
    # run on a fixed interval and read current settings/position data
    # fresh each run (see app/scheduler.py).

    return load_settings(db, user.id).model_dump(mode="json")
