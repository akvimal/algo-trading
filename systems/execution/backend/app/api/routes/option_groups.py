"""Multi-leg option position groups (Phase 4d of the options trading
module - see docs/architecture.md). Mirrors positions.py's route
shapes/status-code conventions 1:1 - see there for the spot/future
equivalents this parallels."""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.adapters.quotes.client import get_ltp_batch
from app.domain.models import StopLossUpdate
from app.domain.option_position_manager import (
    check_option_group_exits,
    compute_group_unrealized_pnl,
    legs_by_group,
    square_off_all_open_option_groups,
    square_off_due_option_groups,
    square_off_option_group,
    update_group_stop_loss,
)

router = APIRouter()


def _group_to_out(row: db_models.OptionPositionGroup, legs: list[dict], live_combined_price: Optional[float] = None, unrealized_pnl: Optional[float] = None) -> dict:
    return {
        "id": str(row.id),
        "signal_id": str(row.signal_id),
        "strategy_id": str(row.strategy_id),
        "underlying_symbol": row.underlying_symbol,
        "exchange": row.exchange,
        "segment": row.segment,
        "strategy_type": row.strategy_type,
        "action": row.action,
        "horizon": row.horizon,
        "quantity": float(row.quantity) if row.quantity is not None else None,
        "net_debit": float(row.net_debit) if row.net_debit is not None else None,
        "combined_stop_loss_price": float(row.combined_stop_loss_price) if row.combined_stop_loss_price is not None else None,
        "combined_target_price": float(row.combined_target_price) if row.combined_target_price is not None else None,
        "sl_scope": row.sl_scope,
        "live_combined_price": live_combined_price,
        "unrealized_pnl": unrealized_pnl,
        "status": row.status,
        "rejection_reason": row.rejection_reason,
        "exit_reason": row.exit_reason,
        "pnl": float(row.pnl) if row.pnl is not None else None,
        "square_off_time": row.square_off_time.isoformat() if row.square_off_time is not None else None,
        "legs": legs,
    }


def _leg_dict(pos: db_models.Position) -> dict:
    return {
        "id": str(pos.id),
        "symbol": pos.symbol,
        "action": pos.action,
        "quantity": float(pos.quantity) if pos.quantity is not None else None,
        "entry_price": float(pos.entry_price),
        "exit_price": float(pos.exit_price) if pos.exit_price is not None else None,
        "pnl": float(pos.pnl) if pos.pnl is not None else None,
        "status": pos.status,
        # Only set when the group's own sl_scope='individual' - null (as
        # for every other option leg) in 'combined' mode.
        "stop_loss_price": float(pos.stop_loss_price) if pos.stop_loss_price is not None else None,
        "target_price": float(pos.target_price) if pos.target_price is not None else None,
    }


@router.get("/option-groups")
def list_option_groups(
    status: Optional[str] = Query(default=None),
    signal_id: Optional[str] = Query(default=None),
    limit: int = 100,
    with_live_pnl: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    """signal_id: exact match, for cross-system deep links, same as
    GET /positions. with_live_pnl: mark-to-market OPEN groups against a
    fresh combined quote - off by default, same reasoning as
    GET /positions."""
    q = db.query(db_models.OptionPositionGroup)
    if status:
        q = q.filter_by(status=status.upper())
    if signal_id:
        try:
            q = q.filter_by(signal_id=uuid.UUID(signal_id))
        except ValueError:
            return []
    rows = q.order_by(db_models.OptionPositionGroup.created_at.desc()).limit(limit).all()

    legs = legs_by_group(db, rows)
    mtm = compute_group_unrealized_pnl(rows, legs, get_ltp_batch) if with_live_pnl else {}

    return [
        _group_to_out(
            r,
            [_leg_dict(pos) for pos in legs.get(r.id, {}).values()],
            live_combined_price=mtm[r.id][0] if r.id in mtm else None,
            unrealized_pnl=mtm[r.id][1] if r.id in mtm else None,
        )
        for r in rows
    ]


@router.put("/option-groups/{group_id}/stop-loss")
def edit_group_stop_loss(group_id: str, payload: StopLossUpdate, db: Session = Depends(get_db)):
    """Generically useful, not manual-only - editing combined SL on any
    already-open option group. 404 if missing, 409 if not OPEN or not
    sl_scope='combined' (editing an individual leg's own SL isn't
    supported by this endpoint)."""
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")

    row = db.get(db_models.OptionPositionGroup, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="option group not found")
    if row.status != "OPEN":
        raise HTTPException(status_code=409, detail=f"option group is {row.status}, not OPEN")
    if row.sl_scope != "combined":
        raise HTTPException(status_code=409, detail="only sl_scope='combined' groups support editing SL here")

    row = update_group_stop_loss(db, parsed_id, payload.stop_loss_price)
    legs = legs_by_group(db, [row]).get(row.id, {})
    return _group_to_out(row, [_leg_dict(pos) for pos in legs.values()])


@router.post("/option-groups/square-off")
def square_off_all_now(db: Session = Depends(get_db)):
    """Manual override - closes EVERY open option group immediately,
    same as POST /positions/square-off for spot/future."""
    return square_off_all_open_option_groups(db, get_ltp_batch)


@router.post("/option-groups/square-off-due")
def square_off_due_now(db: Session = Depends(get_db)):
    """Manual trigger - same logic the scheduled square-off job runs for
    option groups."""
    return square_off_due_option_groups(db, get_ltp_batch)


@router.post("/option-groups/check-exits")
def check_exits_now(db: Session = Depends(get_db)):
    """Manual trigger - same combined SL/target logic the exit-monitor
    job runs for option groups."""
    return check_option_group_exits(db, get_ltp_batch)


@router.post("/option-groups/{group_id}/square-off")
def square_off_one(group_id: str, db: Session = Depends(get_db)):
    """Closes exactly one OPEN option group (both legs) - 404/409/502
    conventions match POST /positions/{position_id}/square-off."""
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")

    result = square_off_option_group(db, parsed_id, get_ltp_batch)
    if result["status"] == "not_found":
        raise HTTPException(status_code=404, detail="option group not found")
    if result["status"] == "not_open":
        raise HTTPException(status_code=409, detail=f"option group is {result['group_status']}, not OPEN")
    if result["status"] == "quote_unavailable":
        raise HTTPException(status_code=502, detail="could not fetch a live quote for one or both legs - still OPEN")
    return result
