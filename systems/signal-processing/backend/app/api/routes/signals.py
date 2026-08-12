import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.adapters.queue.publisher import publish_resolved_order
from app.domain.models import SignalIngest
from app.domain.resolution.errors import ResolutionError
from app.domain.resolution.pipeline import resolve

router = APIRouter()


@router.post("/signals", status_code=202)
def create_signal(signal: SignalIngest, db: Session = Depends(get_db)):
    signal_row = db_models.Signal(
        strategy_id=uuid.UUID(signal.strategy_id),
        symbol=signal.symbol,
        exchange=signal.exchange,
        action=signal.action,
        price=signal.price,
        source=signal.source,
        source_meta=signal.source_meta,
        signal_ts=signal.timestamp or datetime.now(timezone.utc),
    )
    db.add(signal_row)
    db.flush()  # assign signal_row.id before it's referenced below

    try:
        resolved = resolve(signal)
    except ResolutionError as exc:
        order_row = db_models.ResolvedOrder(
            signal_id=signal_row.id,
            strategy_id=uuid.UUID(signal.strategy_id),
            symbol=signal.symbol,
            exchange=signal.exchange,
            action=signal.action,
            price=signal.price,
            status="rejected",
            rejection_reason=exc.reason,
        )
        db.add(order_row)
        db.commit()
        return {"signal_id": str(signal_row.id), "status": "rejected", "reason": exc.reason}

    order_row = db_models.ResolvedOrder(
        signal_id=signal_row.id,
        strategy_id=uuid.UUID(signal.strategy_id),
        symbol=signal.symbol,
        exchange=signal.exchange,
        action=signal.action,
        horizon=resolved.horizon,
        instrument_type=resolved.instrument_type,
        strategy=resolved.strategy,
        price=signal.price,
        status="pending",
    )
    db.add(order_row)
    db.commit()
    db.refresh(order_row)

    publish_resolved_order(
        {
            "signal_id": str(signal_row.id),
            "strategy_id": signal.strategy_id,
            "symbol": signal.symbol,
            "exchange": signal.exchange,
            "action": signal.action,
            "horizon": resolved.horizon,
            "instrument_type": resolved.instrument_type,
            "segment": resolved.segment,
            "strategy": resolved.strategy,
            "price": signal.price,
            "resolved_at": order_row.resolved_at.isoformat(),
            "status": order_row.status,
            "stop_loss_method": resolved.stop_loss_method,
            "stop_loss_interval": resolved.stop_loss_interval,
            "stop_loss_percent": resolved.stop_loss_percent,
            "target_percent": resolved.target_percent,
            "trailing_stop_enabled": resolved.trailing_stop_enabled,
            "square_off_time": resolved.square_off_time.isoformat() if resolved.square_off_time else None,
            "duplicate_signal_policy": resolved.duplicate_signal_policy,
            "counter_signal_policy": resolved.counter_signal_policy,
        }
    )

    return {"signal_id": str(signal_row.id), "status": "accepted"}


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
