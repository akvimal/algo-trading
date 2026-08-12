import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.domain.models import IndicatorCreate, IndicatorOut, IndicatorUpdate, validate_indicator_params

router = APIRouter()


def _to_out(row: db_models.Indicator) -> IndicatorOut:
    return IndicatorOut(
        id=str(row.id),
        name=row.name,
        type=row.type,
        params=row.params,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.post("/indicators", response_model=IndicatorOut, status_code=201)
def create_indicator(payload: IndicatorCreate, db: Session = Depends(get_db)):
    row = db_models.Indicator(name=payload.name, type=payload.type, params=payload.params)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.get("/indicators", response_model=list[IndicatorOut])
def list_indicators(db: Session = Depends(get_db)):
    rows = db.query(db_models.Indicator).order_by(db_models.Indicator.created_at.desc()).all()
    return [_to_out(r) for r in rows]


@router.get("/indicators/{indicator_id}", response_model=IndicatorOut)
def get_indicator(indicator_id: str, db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(indicator_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="indicator not found")

    row = db.get(db_models.Indicator, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="indicator not found")
    return _to_out(row)


@router.patch("/indicators/{indicator_id}", response_model=IndicatorOut)
def update_indicator(indicator_id: str, payload: IndicatorUpdate, db: Session = Depends(get_db)):
    """`type` isn't editable after creation (same pattern as
    Strategy.source_type/exchange) - delete and recreate if it needs to
    change."""
    try:
        parsed_id = uuid.UUID(indicator_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="indicator not found")

    row = db.get(db_models.Indicator, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="indicator not found")

    if payload.name is not None:
        row.name = payload.name
    if payload.params is not None:
        try:
            validate_indicator_params(row.type, payload.params)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        row.params = payload.params

    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.delete("/indicators/{indicator_id}", status_code=204)
def delete_indicator(indicator_id: str, db: Session = Depends(get_db)):
    """Hard delete, unprotected - matches Strategy's own delete, which
    also isn't guarded against being referenced elsewhere. A strategy
    still referencing this indicator gets a defensive skip on its next
    engine tick (app/domain/engine.py), not a crash."""
    try:
        parsed_id = uuid.UUID(indicator_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="indicator not found")

    row = db.get(db_models.Indicator, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="indicator not found")

    db.delete(row)
    db.commit()
