"""Shared intake plumbing - archiving a provider's raw payload and
persisting/resolving/publishing a canonical signal. Extracted out of
app/api/routes/ingest.py and signals.py so both the generic
POST /ingest/raw + POST /signals endpoints AND the Chartink-specific
webhook route (app/api/routes/webhooks.py) can call the same logic
in-process - see docs/architecture.md for why Chartink intake now lives
directly here instead of in n8n.

create_signal_from_ingest is deliberately split into a fast path (this
function) and resolve_and_finalize_signal (below) - the former only does
local DB writes and an XADD, the latter does resolve()'s Dhan-throttled
option-chain calls. This split exists because a multi-symbol Chartink
alert against an option-instrument-type Strategy previously blocked the
whole webhook response on resolve() run sequentially per symbol (~3-6s
each, confirmed live 2026-08-14: ~12s for 2 symbols) - resolve_and_finalize_signal
now runs from app/consumers/signal_resolution_consumer.py instead, off
the caller's request/response cycle entirely. See docs/architecture.md."""

import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.adapters.db import processing_models as db_models
from app.adapters.queue.publisher import publish_resolved_order
from app.adapters.queue.signal_queue import publish_pending_signal
from app.domain.processing.models import SignalIngest
from app.domain.processing.resolution.errors import ResolutionError
from app.domain.processing.resolution.generation_lookup import fetch_strategy
from app.domain.processing.resolution.pipeline import resolve


def archive_raw_payload(db: Session, provider: str, raw_payload: dict) -> db_models.RawSignalPayload:
    """Archive a provider's raw payload before normalization, so a future
    format change can be debugged/replayed against real history."""
    row = db_models.RawSignalPayload(provider=provider, raw_payload=raw_payload)
    db.add(row)
    db.commit()
    return row


def create_signal_from_ingest(db: Session, signal: SignalIngest) -> dict:
    """Fast path, callable in-process by both POST /signals and the
    Chartink webhook route: persists the signal + a 'queued' placeholder
    ResolvedOrder (no horizon/instrument_type/rejection_reason yet - real
    resolution hasn't happened), enqueues the full signal onto
    signals.pending_resolution, and returns immediately. The actual
    resolve()/publish work - and the queued->pending/rejected transition,
    on this SAME resolved_orders row - happens in
    resolve_and_finalize_signal below, called by
    app/consumers/signal_resolution_consumer.py. GET /signals shows
    'queued' until that consumer picks the message up (typically
    milliseconds), then 'pending'/'rejected' as before - the 1-row-per-
    signal shape and ?signal_id= deep links are unchanged.

    No intake path (Chartink, manual, in-house) ever actually sets
    SignalIngest.timestamp today - it's always None on arrival. Normalized
    here, once, before either persistence or the queued payload use it:
    resolve() (now called later, by the consumer) needs a real datetime
    for is_within_active_window (it crashed with AttributeError on
    None.astimezone() - reproduced live 2026-08-14, see
    app/domain/resolution/pipeline.py's own defense-in-depth for this
    too). Reassigning signal.timestamp itself (not just a local variable)
    so persistence, the queued payload, and resolve() are all guaranteed
    to agree on the same value."""
    signal.timestamp = signal.timestamp or datetime.now(timezone.utc)
    signal_row = db_models.Signal(
        strategy_id=uuid.UUID(signal.strategy_id),
        symbol=signal.symbol,
        exchange=signal.exchange,
        action=signal.action,
        price=signal.price,
        source=signal.source,
        source_meta=signal.source_meta,
        signal_ts=signal.timestamp,
    )
    db.add(signal_row)
    db.flush()  # assign signal_row.id before it's referenced below

    order_row = db_models.ResolvedOrder(
        signal_id=signal_row.id,
        strategy_id=uuid.UUID(signal.strategy_id),
        symbol=signal.symbol,
        exchange=signal.exchange,
        action=signal.action,
        price=signal.price,
        status="queued",
    )
    db.add(order_row)
    db.commit()

    publish_pending_signal(str(signal_row.id), signal)

    return {"signal_id": str(signal_row.id), "status": "queued"}


def resolve_and_finalize_signal(db: Session, signal_id: str, signal: SignalIngest) -> None:
    """Called by signal_resolution_consumer.py, off the request/response
    cycle - the resolve()/publish logic that used to be inline in
    create_signal_from_ingest. Updates the EXISTING 'queued' ResolvedOrder
    row in place (looked up by signal_id) rather than inserting a new one,
    so GET /signals keeps its 1-row-per-signal shape. Safe to re-run on
    redelivery (Redis Streams at-least-once): resolve() is a pure
    computation, and re-publishing the same signal_id to orders.resolved
    is a no-op there too - execution's open_position/open_option_group are
    already idempotent on signal_id (see orders_consumer.py)."""
    order_row = db.query(db_models.ResolvedOrder).filter_by(signal_id=uuid.UUID(signal_id)).one()

    try:
        resolved = resolve(signal, lambda strategy_id: fetch_strategy(db, strategy_id))
    except ResolutionError as exc:
        order_row.status = "rejected"
        order_row.rejection_reason = exc.reason
        db.commit()
        return

    order_row.horizon = resolved.horizon
    order_row.instrument_type = resolved.instrument_type
    order_row.strategy = resolved.strategy
    order_row.status = "pending"
    db.commit()
    db.refresh(order_row)

    publish_resolved_order(
        {
            "signal_id": signal_id,
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
            "stop_loss_indicator_type": resolved.stop_loss_indicator_type,
            "stop_loss_indicator_params": resolved.stop_loss_indicator_params,
            "target_percent": resolved.target_percent,
            "trailing_stop_enabled": resolved.trailing_stop_enabled,
            "duplicate_signal_policy": resolved.duplicate_signal_policy,
            "counter_signal_policy": resolved.counter_signal_policy,
            "option_sl_scope": resolved.option_sl_scope,
            "fixed_lots": resolved.fixed_lots,
            "use_margin": resolved.use_margin,
        }
    )
