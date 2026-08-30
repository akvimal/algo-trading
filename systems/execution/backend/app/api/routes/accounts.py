import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.adapters.quotes.client import get_ltp_batch
from app.auth import User, get_current_user, require_admin
from app.domain.models import AccountUpdate, StrategyAccountCreate, StrategyAccountUpdate
from app.domain.position_manager import compute_unrealized_pnl, get_live_trading_status, load_account

router = APIRouter()

_SEGMENTS = ("NSE", "MCX", "CRYPTO")


def _unrealized_pnl(db: Session, open_positions: list) -> float:
    """Live mark-to-market sum across `open_positions` (already filtered to
    status='OPEN' by the caller) - 0.0 for none, or if every quote fetch
    fails (compute_unrealized_pnl silently drops those, same convention
    the Positions grid's own with_live_pnl already uses). Includes option
    legs too (each Position row, spot/future/option alike, carries its own
    action/entry_price/quantity that compute_pnl works off generically) -
    a simplification for an account-level summary figure: it sums each
    leg's own mark-to-market independently rather than netting a spread's
    combined premium the way OptionPositionGroup's own SL/target
    monitoring does, so it can differ slightly from what a 2-leg group's
    own live P&L shows elsewhere."""
    if not open_positions:
        return 0.0
    mtm = compute_unrealized_pnl(open_positions, get_ltp_batch)
    return sum(pnl for _, pnl in mtm.values())


def _to_out(db: Session, row: db_models.Account) -> dict:
    open_positions = db.query(db_models.Position).filter_by(user_id=row.user_id, segment=row.segment, status="OPEN").all()
    return {
        "segment": row.segment,
        "starting_balance": float(row.starting_balance),
        "current_balance": float(row.current_balance),
        # Realized P&L is just current_balance vs. where it started - no
        # separate ledger, matches the delta the Dedicated strategy
        # accounts table already computes client-side today.
        "realized_pnl": float(row.current_balance) - float(row.starting_balance),
        "unrealized_pnl": _unrealized_pnl(db, open_positions),
        "capital_per_trade": float(row.capital_per_trade),
        "risk_per_trade_pct": float(row.risk_per_trade_pct),
        "min_reward_risk_ratio": float(row.min_reward_risk_ratio),
        "enforce_risk_based_lots": row.enforce_risk_based_lots,
        "leverage": float(row.leverage),
        "leverage_buffer_pct": float(row.leverage_buffer_pct),
        "mtf_annual_interest_rate_pct": float(row.mtf_annual_interest_rate_pct) if row.mtf_annual_interest_rate_pct is not None else None,
        "square_off_time": row.square_off_time.isoformat() if row.square_off_time is not None else None,
        "live_trading_enabled": row.live_trading_enabled,
        "max_order_value": float(row.max_order_value) if row.max_order_value is not None else None,
        "max_daily_loss": float(row.max_daily_loss) if row.max_daily_loss is not None else None,
        "updated_at": row.updated_at.isoformat(),
    }


@router.get("/accounts")
def list_accounts(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """One row per segment - always exactly NSE/MCX/CRYPTO, one per SaaS
    user (created lazily with sensible defaults - see load_account - the
    first time each is touched, so a brand-new signup always sees all 3
    immediately rather than 404ing until they've placed a trade)."""
    rows = {seg: load_account(db, user.id, seg) for seg in _SEGMENTS}
    return [_to_out(db, rows[s]) for s in _SEGMENTS if rows[s] is not None]


@router.put("/accounts/{segment}")
def update_account(segment: str, update: AccountUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """starting_balance/capital_per_trade/risk_per_trade_pct/
    min_reward_risk_ratio/enforce_risk_based_lots/leverage/
    leverage_buffer_pct/mtf_annual_interest_rate_pct/square_off_time are
    editable here. Setting starting_balance also re-baselines
    current_balance to match (see AccountUpdate's own docstring) - use
    POST /accounts/{segment}/reset instead if you just want
    current_balance restored to whatever starting_balance ALREADY is,
    a deliberately separate action so it's never a side effect of a
    sizing tweak. square_off_time is the one field where `null` is itself
    a meaningful value (never force-close, e.g. CRYPTO), not just "leave
    unchanged" - model_fields_set distinguishes an explicit
    {"square_off_time": null} from the key being omitted entirely, same
    pattern signal-generation's update_strategy uses for fixed_lots."""
    row = load_account(db, user.id, segment.upper())
    if row is None:
        raise HTTPException(status_code=404, detail=f"no account for segment {segment}")
    if update.starting_balance is not None:
        row.starting_balance = update.starting_balance
        row.current_balance = update.starting_balance
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
    if update.leverage_buffer_pct is not None:
        row.leverage_buffer_pct = update.leverage_buffer_pct
    if "mtf_annual_interest_rate_pct" in update.model_fields_set:
        row.mtf_annual_interest_rate_pct = update.mtf_annual_interest_rate_pct
    if "square_off_time" in update.model_fields_set:
        row.square_off_time = update.square_off_time
    if update.live_trading_enabled is not None:
        row.live_trading_enabled = update.live_trading_enabled
    if "max_order_value" in update.model_fields_set:
        row.max_order_value = update.max_order_value
    if "max_daily_loss" in update.model_fields_set:
        row.max_daily_loss = update.max_daily_loss
    db.commit()
    db.refresh(row)
    return _to_out(db, row)


@router.get("/accounts/platform")
def list_platform_accounts(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Admin-only view of the platform-wide (user_id IS NULL) accounts -
    the rows the automated Strategy-driven flow actually reads (see
    load_account's own docstring). Distinct from GET /accounts above,
    which always returns the CALLER's own per-user rows - there was
    previously no route at all that could read or write these, forcing a
    raw `make psql` UPDATE to configure e.g. NSE MTF leverage/interest.
    See docs/architecture.md's "Positional spot holding + NSE MTF" section."""
    rows = {seg: load_account(db, None, seg) for seg in _SEGMENTS}
    return [_to_out(db, rows[s]) for s in _SEGMENTS if rows[s] is not None]


@router.put("/accounts/platform/{segment}")
def update_platform_account(
    segment: str, update: AccountUpdate, admin: User = Depends(require_admin), db: Session = Depends(get_db)
):
    """Same field-by-field update as PUT /accounts/{segment} above
    (including the starting_balance re-baselining behavior - see
    AccountUpdate's own docstring), just against the platform-wide row
    (user_id IS NULL) instead of the caller's own - the only route that
    can write it. Admin-gated since this is broker/platform config
    (leverage, MTF interest rate, etc.), not a per-SaaS-user setting -
    see the per-Strategy use_margin field (signal-generation) for how a
    strategy opts into it."""
    row = load_account(db, None, segment.upper())
    if row is None:
        raise HTTPException(status_code=404, detail=f"no platform account for segment {segment}")
    if update.starting_balance is not None:
        row.starting_balance = update.starting_balance
        row.current_balance = update.starting_balance
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
    if update.leverage_buffer_pct is not None:
        row.leverage_buffer_pct = update.leverage_buffer_pct
    if "mtf_annual_interest_rate_pct" in update.model_fields_set:
        row.mtf_annual_interest_rate_pct = update.mtf_annual_interest_rate_pct
    if "square_off_time" in update.model_fields_set:
        row.square_off_time = update.square_off_time
    if update.live_trading_enabled is not None:
        row.live_trading_enabled = update.live_trading_enabled
    if "max_order_value" in update.model_fields_set:
        row.max_order_value = update.max_order_value
    if "max_daily_loss" in update.model_fields_set:
        row.max_daily_loss = update.max_daily_loss
    db.commit()
    db.refresh(row)
    return _to_out(db, row)


@router.get("/live-trading/status")
def live_trading_status(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Live-broker-adapter status-check helper (see docs/architecture.md) -
    "is X actually live right now, and if not, why not" across every
    account and strategy_accounts row, without placing an order or calling
    out to market-data/Dhan at all. Admin-gated: this spans every user's
    own accounts plus the platform-wide one, same reasoning
    GET /accounts/platform above is admin-only rather than per-user
    scoped. See get_live_trading_status's own docstring for the exact
    "effectively_live"/"reason" semantics."""
    return get_live_trading_status(db)


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
    return _to_out(db, row)


# --- Optional per-strategy account override (execution.strategy_accounts) -
# see that table's own comment in infra/postgres/init/02-execution.sql and
# app/domain/position_manager.py's load_capital_account for the full
# design: a strategy with a row here sizes/tracks P&L against it instead of
# its segment's shared account above; every strategy without one keeps
# sharing the segment account exactly as before this existed. -----------


def _strategy_account_to_out(db: Session, row: db_models.StrategyAccount) -> dict:
    open_positions = db.query(db_models.Position).filter_by(strategy_id=row.strategy_id, segment=row.segment, status="OPEN").all()
    return {
        "strategy_id": str(row.strategy_id),
        "segment": row.segment,
        "starting_balance": float(row.starting_balance),
        "current_balance": float(row.current_balance),
        "realized_pnl": float(row.current_balance) - float(row.starting_balance),
        "unrealized_pnl": _unrealized_pnl(db, open_positions),
        "capital_per_trade": float(row.capital_per_trade),
        "risk_per_trade_pct": float(row.risk_per_trade_pct),
        "live_trading_user_id": str(row.live_trading_user_id) if row.live_trading_user_id is not None else None,
        "live_trading_enabled": row.live_trading_enabled,
        "max_order_value": float(row.max_order_value) if row.max_order_value is not None else None,
        "max_daily_loss": float(row.max_daily_loss) if row.max_daily_loss is not None else None,
        "updated_at": row.updated_at.isoformat(),
    }


@router.get("/accounts/strategy")
def list_strategy_accounts(db: Session = Depends(get_db)):
    rows = db.query(db_models.StrategyAccount).all()
    return [_strategy_account_to_out(db, r) for r in rows]


@router.get("/accounts/strategy/{strategy_id}")
def get_strategy_account(strategy_id: str, db: Session = Depends(get_db)):
    row = db.get(db_models.StrategyAccount, uuid.UUID(strategy_id))
    if row is None:
        raise HTTPException(status_code=404, detail=f"no dedicated account for strategy {strategy_id}")
    return _strategy_account_to_out(db, row)


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
    return _strategy_account_to_out(db, row)


@router.put("/accounts/strategy/{strategy_id}")
def update_strategy_account(strategy_id: str, update: StrategyAccountUpdate, db: Session = Depends(get_db)):
    """Live-broker-adapter P3 item 14 (see docs/architecture.md) -
    live_trading_user_id/live_trading_enabled/max_order_value/
    max_daily_loss are the only way to opt an automated Strategy into
    placing REAL orders; every other strategy stays paper-only forever
    (the shared platform account has no such fields at all). Enforces the
    DB's own "live_trading_enabled requires live_trading_user_id" CHECK
    here too, with a clean 422 - considers both what's already stored AND
    what this same request is changing, so either order (set the user id
    first, or in the same call as enabling) works."""
    row = db.get(db_models.StrategyAccount, uuid.UUID(strategy_id))
    if row is None:
        raise HTTPException(status_code=404, detail=f"no dedicated account for strategy {strategy_id}")
    if update.capital_per_trade is not None:
        row.capital_per_trade = update.capital_per_trade
    if update.risk_per_trade_pct is not None:
        row.risk_per_trade_pct = update.risk_per_trade_pct
    if "live_trading_user_id" in update.model_fields_set:
        row.live_trading_user_id = uuid.UUID(update.live_trading_user_id) if update.live_trading_user_id else None
    if update.live_trading_enabled is not None:
        row.live_trading_enabled = update.live_trading_enabled
    if "max_order_value" in update.model_fields_set:
        row.max_order_value = update.max_order_value
    if "max_daily_loss" in update.model_fields_set:
        row.max_daily_loss = update.max_daily_loss
    if row.live_trading_enabled and row.live_trading_user_id is None:
        raise HTTPException(status_code=422, detail="live_trading_enabled requires live_trading_user_id to be set")
    db.commit()
    db.refresh(row)
    return _strategy_account_to_out(db, row)


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
    return _strategy_account_to_out(db, row)
