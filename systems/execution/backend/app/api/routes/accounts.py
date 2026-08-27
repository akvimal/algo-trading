import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.auth import User, get_current_user
from app.domain.models import AccountUpdate, StrategyAccountCreate, StrategyAccountUpdate
from app.domain.position_manager import load_account

router = APIRouter()

_SEGMENTS = ("NSE", "MCX", "CRYPTO")


def _to_out(row: db_models.Account) -> dict:
    return {
        "segment": row.segment,
        "starting_balance": float(row.starting_balance),
        "current_balance": float(row.current_balance),
        "capital_per_trade": float(row.capital_per_trade),
        "risk_per_trade_pct": float(row.risk_per_trade_pct),
        "min_reward_risk_ratio": float(row.min_reward_risk_ratio),
        "enforce_risk_based_lots": row.enforce_risk_based_lots,
        "leverage": float(row.leverage),
        "square_off_time": row.square_off_time.isoformat() if row.square_off_time is not None else None,
        "updated_at": row.updated_at.isoformat(),
    }


@router.get("/accounts")
def list_accounts(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """One row per segment - always exactly NSE/MCX/CRYPTO, one per SaaS
    user (created lazily with sensible defaults - see load_account - the
    first time each is touched, so a brand-new signup always sees all 3
    immediately rather than 404ing until they've placed a trade)."""
    rows = {seg: load_account(db, user.id, seg) for seg in _SEGMENTS}
    return [_to_out(rows[s]) for s in _SEGMENTS if rows[s] is not None]


@router.put("/accounts/{segment}")
def update_account(segment: str, update: AccountUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """capital_per_trade/risk_per_trade_pct/min_reward_risk_ratio/
    enforce_risk_based_lots/leverage/square_off_time are editable here -
    use POST /accounts/{segment}/reset to touch
    current_balance, a deliberately separate action so it's never a side
    effect of a sizing tweak. square_off_time is the one field where
    `null` is itself a meaningful value (never force-close, e.g. CRYPTO),
    not just "leave unchanged" - model_fields_set distinguishes an
    explicit {"square_off_time": null} from the key being omitted
    entirely, same pattern signal-generation's update_strategy uses for
    fixed_lots."""
    row = load_account(db, user.id, segment.upper())
    if row is None:
        raise HTTPException(status_code=404, detail=f"no account for segment {segment}")
    if update.capital_per_trade is not None:
        row.capital_per_trade = update.capital_per_trade
    if update.risk_per_trade_pct is not None:
        row.risk_per_trade_pct = update.risk_per_trade_pct
    if update.min_reward_risk_ratio is not None:
        row.min_reward_risk_ratio = update.min_reward_risk_ratio
    if update.enforce_risk_based_lots is not None:
        row.enforce_risk_based_lots = update.enforce_risk_based_lots
    if update.leverage is not None:
        row.leverage = update.leverage
    if "square_off_time" in update.model_fields_set:
        row.square_off_time = update.square_off_time
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.post("/accounts/{segment}/reset")
def reset_account(segment: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Resets current_balance back to starting_balance - does not touch
    capital_per_trade/risk_per_trade_pct or any positions. A manual reset
    for testing, same spirit as DELETE /positions but decoupled from it."""
    row = load_account(db, user.id, segment.upper())
    if row is None:
        raise HTTPException(status_code=404, detail=f"no account for segment {segment}")
    row.current_balance = row.starting_balance
    db.commit()
    db.refresh(row)
    return _to_out(row)


# --- Optional per-strategy account override (execution.strategy_accounts) -
# see that table's own comment in infra/postgres/init/02-execution.sql and
# app/domain/position_manager.py's load_capital_account for the full
# design: a strategy with a row here sizes/tracks P&L against it instead of
# its segment's shared account above; every strategy without one keeps
# sharing the segment account exactly as before this existed. -----------


def _strategy_account_to_out(row: db_models.StrategyAccount) -> dict:
    return {
        "strategy_id": str(row.strategy_id),
        "segment": row.segment,
        "starting_balance": float(row.starting_balance),
        "current_balance": float(row.current_balance),
        "capital_per_trade": float(row.capital_per_trade),
        "risk_per_trade_pct": float(row.risk_per_trade_pct),
        "updated_at": row.updated_at.isoformat(),
    }


@router.get("/accounts/strategy")
def list_strategy_accounts(db: Session = Depends(get_db)):
    rows = db.query(db_models.StrategyAccount).all()
    return [_strategy_account_to_out(r) for r in rows]


@router.get("/accounts/strategy/{strategy_id}")
def get_strategy_account(strategy_id: str, db: Session = Depends(get_db)):
    row = db.get(db_models.StrategyAccount, uuid.UUID(strategy_id))
    if row is None:
        raise HTTPException(status_code=404, detail=f"no dedicated account for strategy {strategy_id}")
    return _strategy_account_to_out(row)


@router.post("/accounts/strategy/{strategy_id}")
def create_strategy_account(strategy_id: str, create: StrategyAccountCreate, db: Session = Depends(get_db)):
    """starting_balance seeds current_balance too, same as
    execution.accounts' own seed INSERT does for the segment accounts.
    409s on an existing row - PUT is how you edit one, this is create-only,
    same split GET/POST/PUT has for the segment routes above."""
    strategy_uuid = uuid.UUID(strategy_id)
    if db.get(db_models.StrategyAccount, strategy_uuid) is not None:
        raise HTTPException(status_code=409, detail=f"strategy {strategy_id} already has a dedicated account")
    row = db_models.StrategyAccount(
        strategy_id=strategy_uuid,
        segment=create.segment,
        starting_balance=create.starting_balance,
        current_balance=create.starting_balance,
        capital_per_trade=create.capital_per_trade,
        risk_per_trade_pct=create.risk_per_trade_pct,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _strategy_account_to_out(row)


@router.put("/accounts/strategy/{strategy_id}")
def update_strategy_account(strategy_id: str, update: StrategyAccountUpdate, db: Session = Depends(get_db)):
    row = db.get(db_models.StrategyAccount, uuid.UUID(strategy_id))
    if row is None:
        raise HTTPException(status_code=404, detail=f"no dedicated account for strategy {strategy_id}")
    if update.capital_per_trade is not None:
        row.capital_per_trade = update.capital_per_trade
    if update.risk_per_trade_pct is not None:
        row.risk_per_trade_pct = update.risk_per_trade_pct
    db.commit()
    db.refresh(row)
    return _strategy_account_to_out(row)


@router.delete("/accounts/strategy/{strategy_id}")
def delete_strategy_account(strategy_id: str, db: Session = Depends(get_db)):
    """Removing the override doesn't touch any already-open position/group
    - they keep resolving against whatever account they were opened
    against (load_capital_account is called fresh at open/close time, not
    stored on the position) only going forward does the strategy fall back
    to sharing its segment account again."""
    row = db.get(db_models.StrategyAccount, uuid.UUID(strategy_id))
    if row is None:
        raise HTTPException(status_code=404, detail=f"no dedicated account for strategy {strategy_id}")
    db.delete(row)
    db.commit()
    return {"status": "deleted", "strategy_id": strategy_id}


@router.post("/accounts/strategy/{strategy_id}/reset")
def reset_strategy_account(strategy_id: str, db: Session = Depends(get_db)):
    row = db.get(db_models.StrategyAccount, uuid.UUID(strategy_id))
    if row is None:
        raise HTTPException(status_code=404, detail=f"no dedicated account for strategy {strategy_id}")
    row.current_balance = row.starting_balance
    db.commit()
    db.refresh(row)
    return _strategy_account_to_out(row)
