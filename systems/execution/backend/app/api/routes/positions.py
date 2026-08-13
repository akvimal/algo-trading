import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.adapters.quotes.client import get_lot_size, get_ltp_batch, get_previous_candle
from app.domain.models import ManualPositionCreate, StopLossUpdate
from app.domain.position_manager import (
    check_exits,
    compute_unrealized_pnl,
    load_settings,
    open_manual_position,
    square_off_all_open,
    square_off_due_positions,
    square_off_position,
    update_stop_loss,
)

router = APIRouter()


def _position_to_out(row: db_models.Position, live_price: Optional[float] = None, unrealized_pnl: Optional[float] = None) -> dict:
    return {
        "id": str(row.id),
        "signal_id": str(row.signal_id),
        # None for manually-opened positions (Manual tab) - no Strategy at all, see docs/architecture.md.
        "strategy_id": str(row.strategy_id) if row.strategy_id is not None else None,
        "symbol": row.symbol,
        "exchange": row.exchange,
        "segment": row.segment,
        "action": row.action,
        "horizon": row.horizon,
        "instrument_type": row.instrument_type,
        "quantity": float(row.quantity) if row.quantity is not None else None,
        "entry_price": float(row.entry_price),
        "entry_time": row.entry_time.isoformat(),
        "exit_price": float(row.exit_price) if row.exit_price is not None else None,
        "exit_time": row.exit_time.isoformat() if row.exit_time else None,
        "pnl": float(row.pnl) if row.pnl is not None else None,
        "live_price": live_price,
        "unrealized_pnl": unrealized_pnl,
        "status": row.status,
        "rejection_reason": row.rejection_reason,
        "stop_loss_price": float(row.stop_loss_price) if row.stop_loss_price is not None else None,
        "target_price": float(row.target_price) if row.target_price is not None else None,
        "trailing_stop_enabled": row.trailing_stop_enabled,
        "exit_reason": row.exit_reason,
        "square_off_time": row.square_off_time.isoformat() if row.square_off_time is not None else None,
        "option_group_id": str(row.option_group_id) if row.option_group_id is not None else None,
    }


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
        _position_to_out(r, live_price=mtm[r.id][0] if r.id in mtm else None, unrealized_pnl=mtm[r.id][1] if r.id in mtm else None)
        for r in rows
    ]


@router.post("/positions/manual")
def open_manual(payload: ManualPositionCreate, db: Session = Depends(get_db)):
    """The Manual tab (signal-generation's frontend) - spot/future only,
    bypasses signal-generation/signal-processing entirely (no Strategy, no
    resolution pipeline). Options go through the real pipeline instead via
    an auto-provisioned Strategy - see docs/architecture.md. Always
    200/201 regardless of whether the result is OPEN or REJECTED, matching
    the existing pipeline's own convention - a rejection is a legitimate
    persisted outcome, not an HTTP error."""
    settings = load_settings(db)
    row = open_manual_position(
        payload.segment,
        payload.symbol,
        payload.action,
        payload.instrument_type,
        payload.price,
        payload.quantity,
        payload.stop_loss_price,
        payload.square_off_time,
        settings,
        db,
        get_lot_size,
    )
    return _position_to_out(row)


@router.put("/positions/{position_id}/stop-loss")
def edit_stop_loss(position_id: str, payload: StopLossUpdate, db: Session = Depends(get_db)):
    """Generically useful, not manual-only - editing SL on any already-open
    position. 404 if missing, 409 if not OPEN."""
    try:
        parsed_id = uuid.UUID(position_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="position not found")

    row = db.get(db_models.Position, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="position not found")
    if row.status != "OPEN":
        raise HTTPException(status_code=409, detail=f"position is {row.status}, not OPEN")

    row = update_stop_loss(db, parsed_id, payload.stop_loss_price)
    return _position_to_out(row)


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
def square_off_one(position_id: str, quantity: Optional[float] = Query(default=None, gt=0), db: Session = Depends(get_db)):
    """Closes exactly one OPEN position - the frontend's per-row
    'Square off' button on the Positions grid. 404 if the id doesn't
    exist, 409 if it's not OPEN (already closed/rejected), 502 if a CMP
    couldn't be fetched (position is left OPEN, same as the bulk paths).
    `quantity` (optional) partially closes - see square_off_position's own
    docstring; omitted behaves exactly as before this parameter existed."""
    try:
        parsed_id = uuid.UUID(position_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="position not found")

    result = square_off_position(db, parsed_id, get_ltp_batch, quantity)
    if result["status"] == "not_found":
        raise HTTPException(status_code=404, detail="position not found")
    if result["status"] == "not_open":
        raise HTTPException(status_code=409, detail=f"position is {result['position_status']}, not OPEN")
    if result["status"] == "invalid_quantity":
        raise HTTPException(status_code=422, detail=f"quantity must be > 0 and <= {result['held_quantity']} held")
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
