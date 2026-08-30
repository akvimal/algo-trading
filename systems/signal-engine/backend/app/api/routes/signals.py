import uuid
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.adapters.db import processing_models as db_models
from app.adapters.db.session import get_db
from app.domain.processing.intake.core import create_signal_from_ingest
from app.domain.processing.models import SignalIngest

router = APIRouter()


@router.get("/signals/counts")
def signal_counts(db: Session = Depends(get_db)):
    """Total signal count per strategy_id, every source/status included -
    the "Total signals" figure on execution's Money page "Performance" tab
    (combined there with execution's own GET /strategies/performance by
    strategy_id, since win-rate/PnL/drawdown live in execution's own
    Position data, not here). A plain GROUP BY, not filtered to `live`
    strategies or any particular source - a strategy's total signal count
    is meaningful even while draft/paused/backtesting."""
    rows = (
        db.query(db_models.Signal.strategy_id, func.count(db_models.Signal.id))
        .group_by(db_models.Signal.strategy_id)
        .all()
    )
    return [{"strategy_id": str(strategy_id), "total_signals": count} for strategy_id, count in rows]


@router.post("/signals", status_code=202)
def create_signal(signal: SignalIngest, db: Session = Depends(get_db)):
    return create_signal_from_ingest(db, signal)


@router.get("/signals")
def list_signals(
    limit: int = 50,
    source: Optional[str] = None,
    strategy_id: Optional[str] = None,
    signal_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """source: e.g. 'chartink' - lets other systems' dashboards (signal-generation)
    show provider activity without owning a copy of this data themselves.
    strategy_id: all signals for one Strategy (signal-generation's per-strategy view).
    signal_id: exact match, for cross-system deep links (?signal_id=... from
    execution's frontend back to a specific signal)."""
    q = db.query(db_models.Signal, db_models.ResolvedOrder).outerjoin(
        db_models.ResolvedOrder, db_models.ResolvedOrder.signal_id == db_models.Signal.id
    )
    if source:
        q = q.filter(db_models.Signal.source == source)
    if strategy_id:
        try:
            q = q.filter(db_models.Signal.strategy_id == uuid.UUID(strategy_id))
        except ValueError:
            return []
    if signal_id:
        try:
            q = q.filter(db_models.Signal.id == uuid.UUID(signal_id))
        except ValueError:
            return []  # not a valid UUID - no match rather than a 500
    rows = q.order_by(db_models.Signal.received_at.desc()).limit(limit).all()
    return [
        {
            "signal_id": str(s.id),
            "strategy_id": str(s.strategy_id),
            "symbol": s.symbol,
            "exchange": s.exchange,
            "action": s.action,
            "price": float(s.price),
            "source": s.source,
            "received_at": s.received_at.isoformat(),
            "horizon": o.horizon if o else None,
            "instrument_type": o.instrument_type if o else None,
            "status": o.status if o else None,
            "rejection_reason": o.rejection_reason if o else None,
        }
        for s, o in rows
    ]


@router.delete("/signals")
def clear_signals(db: Session = Depends(get_db)):
    """Wipes all signal-processing data (resolved orders, signals, and
    their raw provider payloads) - a manual reset for testing, not
    something the pipeline itself ever calls. resolved_orders is deleted
    first since it FK-references signals. Strategies in signal-generation
    and positions in execution are untouched - each system only ever
    clears its own schema, see docs/architecture.md."""
    resolved_orders_deleted = db.query(db_models.ResolvedOrder).delete()
    signals_deleted = db.query(db_models.Signal).delete()
    raw_payloads_deleted = db.query(db_models.RawSignalPayload).delete()
    db.commit()
    return {
        "signals_deleted": signals_deleted,
        "resolved_orders_deleted": resolved_orders_deleted,
        "raw_payloads_deleted": raw_payloads_deleted,
    }
