import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.adapters.quotes.client import get_ltp_batch, get_previous_candle
from app.domain.position_manager import (
    check_exits,
    compute_unrealized_pnl,
    square_off_all_open,
    square_off_due_positions,
    square_off_position,
)

router = APIRouter()


@router.get("/positions")
def list_positions(
    status: Optional[str] = Query(default=None),
    signal_id: Optional[str] = Query(default=None),
    limit: int = 100,
    with_live_pnl: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    """signal_id: exact match, for cross-system deep links (?signal_id=...
    from signal-processing's frontend to this position's outcome).
    with_live_pnl: mark-to-market OPEN positions in this response against
    a fresh quote (one batched call per distinct exchange) - off by default
    since it means extra Dhan calls on every request; the frontend opts in
    for its own polling, other callers (cross-links, other systems) don't
    pay for it unless they ask."""
    q = db.query(db_models.Position)
    if status:
        q = q.filter_by(status=status.upper())
    if signal_id:
        try:
            q = q.filter_by(signal_id=uuid.UUID(signal_id))
        except ValueError:
            return []  # not a valid UUID - no match rather than a 500
    rows = q.order_by(db_models.Position.entry_time.desc()).limit(limit).all()

    mtm = compute_unrealized_pnl(rows, get_ltp_batch) if with_live_pnl else {}

    return [
        {
            "id": str(r.id),
            "signal_id": str(r.signal_id),
            "strategy_id": str(r.strategy_id),
            "symbol": r.symbol,
            "exchange": r.exchange,
            "segment": r.segment,
            "action": r.action,
            "horizon": r.horizon,
            "instrument_type": r.instrument_type,
            "quantity": float(r.quantity) if r.quantity is not None else None,
            "entry_price": float(r.entry_price),
            "entry_time": r.entry_time.isoformat(),
            "exit_price": float(r.exit_price) if r.exit_price is not None else None,
            "exit_time": r.exit_time.isoformat() if r.exit_time else None,
            "pnl": float(r.pnl) if r.pnl is not None else None,
            "live_price": mtm[r.id][0] if r.id in mtm else None,
            "unrealized_pnl": mtm[r.id][1] if r.id in mtm else None,
            "status": r.status,
            "rejection_reason": r.rejection_reason,
            "stop_loss_price": float(r.stop_loss_price) if r.stop_loss_price is not None else None,
            "target_price": float(r.target_price) if r.target_price is not None else None,
            "trailing_stop_enabled": r.trailing_stop_enabled,
            "exit_reason": r.exit_reason,
            "square_off_time": r.square_off_time.isoformat() if r.square_off_time is not None else None,
        }
        for r in rows
    ]


@router.post("/positions/square-off")
def square_off_now(db: Session = Depends(get_db)):
    """Manual override - closes EVERY open position immediately,
    regardless of each one's own square_off_time. Useful for squaring off
    early or testing without waiting for the clock."""
    return square_off_all_open(db, get_ltp_batch)


@router.post("/positions/square-off-due")
def square_off_due_now(db: Session = Depends(get_db)):
    """Manual trigger - same logic the scheduled square-off job runs
    (only closes positions whose own square_off_time has passed, not
    everything). Useful for testing without waiting on the poll interval."""
    return square_off_due_positions(db, get_ltp_batch)


@router.post("/positions/check-exits")
def check_exits_now(db: Session = Depends(get_db)):
    """Manual trigger - same logic the exit-monitor job runs on its
    interval. Useful for testing without waiting on the poll interval."""
    return check_exits(db, get_ltp_batch, get_previous_candle)


@router.post("/positions/{position_id}/square-off")
def square_off_one(position_id: str, db: Session = Depends(get_db)):
    """Closes exactly one OPEN position - the frontend's per-row
    'Square off' button on the Positions grid. 404 if the id doesn't
    exist, 409 if it's not OPEN (already closed/rejected), 502 if a CMP
    couldn't be fetched (position is left OPEN, same as the bulk paths)."""
    try:
        parsed_id = uuid.UUID(position_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="position not found")

    result = square_off_position(db, parsed_id, get_ltp_batch)
    if result["status"] == "not_found":
        raise HTTPException(status_code=404, detail="position not found")
    if result["status"] == "not_open":
        raise HTTPException(status_code=409, detail=f"position is {result['position_status']}, not OPEN")
    if result["status"] == "quote_unavailable":
        raise HTTPException(status_code=502, detail="could not fetch a live quote for this position - still OPEN")
    return result


@router.delete("/positions")
def clear_positions(db: Session = Depends(get_db)):
    """Wipes all positions (OPEN/CLOSED/REJECTED) - a manual reset for
    testing, not something the pipeline itself ever calls. Settings and
    the Redis stream/consumer group are untouched. Signals in
    signal-processing and strategies in signal-generation are untouched
    too - each system only ever clears its own schema, see
    docs/architecture.md."""
    positions_deleted = db.query(db_models.Position).delete()
    db.commit()
    return {"positions_deleted": positions_deleted}
