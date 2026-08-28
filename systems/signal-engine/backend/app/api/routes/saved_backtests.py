"""CRUD for saved backtest snapshots (signal_generation.saved_backtests) -
see infra/postgres/init/03-signal-generation.sql and
app/domain/rule.py's SavedBacktest* models for the full design (why
request+result are stored verbatim, why there's no update endpoint)."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.domain.generation.rule import SavedBacktestCreate, SavedBacktestOut, SavedBacktestSummary

router = APIRouter()


def _to_out(row: db_models.SavedBacktest) -> SavedBacktestOut:
    return SavedBacktestOut(
        id=str(row.id),
        rule_id=str(row.rule_id),
        name=row.name,
        from_date=row.from_date,
        to_date=row.to_date,
        request=row.request,
        result=row.result,
        created_at=row.created_at,
    )


def _to_summary(row: db_models.SavedBacktest) -> SavedBacktestSummary:
    return SavedBacktestSummary(
        id=str(row.id),
        name=row.name,
        from_date=row.from_date,
        to_date=row.to_date,
        trade_count=row.result.get("trade_count"),
        hypothetical_pnl=row.result.get("hypothetical_pnl"),
        win_rate=row.result.get("win_rate"),
        max_drawdown=row.result.get("max_drawdown"),
        created_at=row.created_at,
    )


@router.get("/rules/{rule_id}/saved-backtests", response_model=list[SavedBacktestSummary])
def list_saved_backtests(rule_id: str, db: Session = Depends(get_db)):
    try:
        parsed_rule_id = uuid.UUID(rule_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="rule not found")

    rows = (
        db.query(db_models.SavedBacktest)
        .filter(db_models.SavedBacktest.rule_id == parsed_rule_id)
        .order_by(db_models.SavedBacktest.created_at.desc())
        .all()
    )
    return [_to_summary(r) for r in rows]


@router.post("/rules/{rule_id}/saved-backtests", response_model=SavedBacktestOut, status_code=201)
def create_saved_backtest(rule_id: str, payload: SavedBacktestCreate, db: Session = Depends(get_db)):
    try:
        parsed_rule_id = uuid.UUID(rule_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="rule not found")

    if db.get(db_models.Rule, parsed_rule_id) is None:
        raise HTTPException(status_code=404, detail="rule not found")

    row = db_models.SavedBacktest(
        rule_id=parsed_rule_id,
        name=payload.name,
        from_date=payload.from_date,
        to_date=payload.to_date,
        request=payload.request,
        result=payload.result,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.get("/saved-backtests/{saved_backtest_id}", response_model=SavedBacktestOut)
def get_saved_backtest(saved_backtest_id: str, db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(saved_backtest_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="saved backtest not found")

    row = db.get(db_models.SavedBacktest, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="saved backtest not found")
    return _to_out(row)


@router.delete("/saved-backtests/{saved_backtest_id}", status_code=204)
def delete_saved_backtest(saved_backtest_id: str, db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(saved_backtest_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="saved backtest not found")

    row = db.get(db_models.SavedBacktest, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="saved backtest not found")

    db.delete(row)
    db.commit()
