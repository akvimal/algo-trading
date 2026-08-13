from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.domain.models import AccountUpdate

router = APIRouter()

_SEGMENTS = ("NSE", "MCX", "CRYPTO")


def _to_out(row: db_models.Account) -> dict:
    return {
        "segment": row.segment,
        "starting_balance": float(row.starting_balance),
        "current_balance": float(row.current_balance),
        "capital_per_trade": float(row.capital_per_trade),
        "risk_per_trade_pct": float(row.risk_per_trade_pct),
        "leverage": float(row.leverage),
        "square_off_time": row.square_off_time.isoformat() if row.square_off_time is not None else None,
        "updated_at": row.updated_at.isoformat(),
    }


@router.get("/accounts")
def list_accounts(db: Session = Depends(get_db)):
    """One row per segment - always exactly NSE/MCX/CRYPTO, seeded on
    first container start. Returned in a stable order for the frontend."""
    rows = {r.segment: r for r in db.query(db_models.Account).all()}
    return [_to_out(rows[s]) for s in _SEGMENTS if s in rows]


@router.put("/accounts/{segment}")
def update_account(segment: str, update: AccountUpdate, db: Session = Depends(get_db)):
    """capital_per_trade/risk_per_trade_pct/leverage/square_off_time are
    editable here - use POST /accounts/{segment}/reset to touch
    current_balance, a deliberately separate action so it's never a side
    effect of a sizing tweak. square_off_time is the one field where
    `null` is itself a meaningful value (never force-close, e.g. CRYPTO),
    not just "leave unchanged" - model_fields_set distinguishes an
    explicit {"square_off_time": null} from the key being omitted
    entirely, same pattern signal-generation's update_strategy uses for
    option_fixed_lots."""
    row = db.get(db_models.Account, segment.upper())
    if row is None:
        raise HTTPException(status_code=404, detail=f"no account for segment {segment}")
    if update.capital_per_trade is not None:
        row.capital_per_trade = update.capital_per_trade
    if update.risk_per_trade_pct is not None:
        row.risk_per_trade_pct = update.risk_per_trade_pct
    if update.leverage is not None:
        row.leverage = update.leverage
    if "square_off_time" in update.model_fields_set:
        row.square_off_time = update.square_off_time
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.post("/accounts/{segment}/reset")
def reset_account(segment: str, db: Session = Depends(get_db)):
    """Resets current_balance back to starting_balance - does not touch
    capital_per_trade/risk_per_trade_pct or any positions. A manual reset
    for testing, same spirit as DELETE /positions but decoupled from it."""
    row = db.get(db_models.Account, segment.upper())
    if row is None:
        raise HTTPException(status_code=404, detail=f"no account for segment {segment}")
    row.current_balance = row.starting_balance
    db.commit()
    db.refresh(row)
    return _to_out(row)
