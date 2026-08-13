"""Shared intake plumbing - archiving a provider's raw payload and
persisting/resolving/publishing a canonical signal. Extracted out of
app/api/routes/ingest.py and signals.py so both the generic
POST /ingest/raw + POST /signals endpoints AND the Chartink-specific
webhook route (app/api/routes/webhooks.py) can call the same logic
in-process - see docs/architecture.md for why Chartink intake now lives
directly here instead of in n8n."""

import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.queue.publisher import publish_resolved_order
from app.domain.models import SignalIngest
from app.domain.resolution.errors import ResolutionError
from app.domain.resolution.pipeline import resolve


def archive_raw_payload(db: Session, provider: str, raw_payload: dict) -> db_models.RawSignalPayload:
    """Archive a provider's raw payload before normalization, so a future
    format change can be debugged/replayed against real history."""
    row = db_models.RawSignalPayload(provider=provider, raw_payload=raw_payload)
    db.add(row)
    db.commit()
    return row


def create_signal_from_ingest(db: Session, signal: SignalIngest) -> dict:
    """Persists the signal, resolves it (or persists it as rejected with
    no publish), and XADDs the resolved order to orders.resolved on
    success - the full POST /signals behavior, callable in-process."""
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
            "option_sl_scope": resolved.option_sl_scope,
            "option_fixed_lots": resolved.option_fixed_lots,
        }
    )

    return {"signal_id": str(signal_row.id), "status": "accepted"}
