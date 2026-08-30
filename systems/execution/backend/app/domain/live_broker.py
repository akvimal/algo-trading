"""Live-broker-adapter P1/P2 (see docs/architecture.md) - the actual real-
order submission path, gated behind BOTH the platform-wide kill switch
(app/config.py's live_trading_kill_switch) and each account's own
live_trading_enabled opt-in. Scoped to NSE/MCX spot/future MARKET/
STOP_LOSS_MARKET/INTRADAY orders only (Manual tab) - no options, no CRYPTO
(a different broker), no LIMIT orders yet.

Two submission paths, sharing the same underlying primitives:
- Token-based (submit_live_order, submit_resting_stop_loss) - a real HTTP
  request with a live user bearer token (Manual tab open/close).
- Internal (submit_exit_order_scheduled, modify_resting_order_scheduled,
  cancel_resting_order_scheduled) - a scheduler job (app/scheduler.py) with
  no live token, via market-data's shared-secret-gated /internal/dhan/*
  routes instead (user_id stands in for the JWT).

Position creation/closure stays gated on TRADED, per the plan's own
"Position created only on fill" design - nothing here touches a Position
row itself; callers only ever create/close one once a function here
returns with no error."""

import logging
import time
import uuid
from typing import Callable, Optional

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.quotes.client import (
    cancel_broker_order_internal,
    modify_broker_order_internal,
    place_broker_order,
    place_broker_order_internal,
)
from app.config import settings

logger = logging.getLogger(__name__)

# How long a submission that needs to CONFIRM A FILL waits for Dhan's own
# postback before giving up - no Position is ever opened/closed off an
# order this function can't confirm filled within this window. Dhan MARKET
# orders on NSE/MCX are expected to confirm within low single-digit
# seconds; kept short since callers are either a human waiting on a live
# HTTP request or a scheduler tick that runs every 30s regardless. A
# resting stop-loss order (submit_resting_stop_loss) does NOT wait at all -
# it may sit on the exchange for hours - see that function's own docstring.
FILL_WAIT_TIMEOUT_SECONDS = 8.0
FILL_POLL_INTERVAL_SECONDS = 0.5


def is_live_enabled(account: db_models.Account) -> bool:
    return bool(account.live_trading_enabled) and not settings.live_trading_kill_switch


def _write_broker_order(
    db: Session,
    user_id: uuid.UUID,
    position_id: Optional[uuid.UUID],
    purpose: str,
    exchange: str,
    symbol: str,
    action: str,
    quantity: float,
    order_type: str,
    trigger_price: Optional[float] = None,
) -> db_models.BrokerOrder:
    order = db_models.BrokerOrder(
        user_id=user_id,
        position_id=position_id,
        purpose=purpose,
        client_order_id=str(uuid.uuid4()),
        status="submitting",
        exchange=exchange,
        symbol=symbol,
        segment=exchange,
        action=action,
        quantity=int(quantity),
        order_type=order_type,
        product_type="INTRADAY",
        trigger_price=trigger_price,
    )
    db.add(order)
    db.commit()  # written BEFORE calling Dhan - submit-then-crash safety, see broker_orders' own comment
    return order


def _submit(db: Session, order: db_models.BrokerOrder, call: Callable[[], dict]) -> Optional[str]:
    """`call` is whatever closure actually reaches Dhan (a direct
    place_broker_order call, or the *_internal variant) - shared by every
    submission path below so the write-before-call/update-after-call
    bookkeeping only lives in one place."""
    try:
        raw = call()
    except Exception as exc:
        logger.exception("live order submission failed for client_order_id=%s", order.client_order_id)
        order.status = "failed"
        order.failure_reason = str(exc)[:500]
        db.commit()
        return f"order submission to Dhan failed: {exc}"

    order_id = raw.get("orderId") if isinstance(raw, dict) else None
    order.broker_order_id = str(order_id) if order_id else None
    order.raw_response = raw if isinstance(raw, dict) else {"raw": raw}
    if order.status == "submitting":
        order.status = "pending"
    db.commit()
    return None


def _wait_for_fill(db: Session, order: db_models.BrokerOrder) -> tuple[db_models.BrokerOrder, Optional[str]]:
    deadline = time.monotonic() + FILL_WAIT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        db.refresh(order)
        if order.status == "traded":
            return order, None
        if order.status in ("rejected", "cancelled", "failed"):
            return order, f"Dhan {order.status} the order (broker_order_id={order.broker_order_id})"
        time.sleep(FILL_POLL_INTERVAL_SECONDS)

    return order, (
        f"order submitted to Dhan (broker_order_id={order.broker_order_id}) but not confirmed traded within "
        f"{FILL_WAIT_TIMEOUT_SECONDS:.0f}s - it may still fill; check Dhan's own order book directly, this will "
        "be picked up by the reconciliation job"
    )


def submit_live_order(
    db: Session,
    user_id: uuid.UUID,
    token: str,
    position_id: Optional[uuid.UUID],
    purpose: str,
    exchange: str,
    symbol: str,
    action: str,
    quantity: float,
) -> tuple[Optional[db_models.BrokerOrder], Optional[str]]:
    """Submits a real MARKET/INTRADAY order to Dhan (via market-data, using
    the caller's own bearer token) and waits up to FILL_WAIT_TIMEOUT_SECONDS
    for its postback to confirm TRADED. Returns (broker_order, None) once
    traded; (broker_order, reason) if Dhan rejects it outright or it never
    confirms in time - callers must NOT create/mutate a Position in the
    reason-not-None case. Used for entry (open_manual_position) and a
    manual full close (square_off_position), always inside a live HTTP
    request. quantity is real units (shares/contracts), not lots."""
    order = _write_broker_order(db, user_id, position_id, purpose, exchange, symbol, action, quantity, order_type="MARKET")
    error = _submit(
        db,
        order,
        lambda: place_broker_order(
            exchange=exchange,
            symbol=symbol,
            transaction_type=action,
            quantity=int(quantity),
            order_type="MARKET",
            product_type="INTRADAY",
            token=token,
            correlation_id=order.client_order_id,
        ),
    )
    if error is not None:
        return order, error
    return _wait_for_fill(db, order)


def submit_resting_stop_loss(
    db: Session,
    user_id: uuid.UUID,
    token: str,
    position_id: uuid.UUID,
    exchange: str,
    symbol: str,
    action: str,
    quantity: float,
    trigger_price: float,
) -> tuple[Optional[db_models.BrokerOrder], Optional[str]]:
    """Places a real STOP_LOSS_MARKET order that RESTS on the exchange
    until triggered - unlike submit_live_order, does NOT wait for a fill
    (a resting stop may sit for hours); returns once Dhan ACCEPTS it
    (order.status='pending'), or the rejection reason if Dhan refuses it
    outright. When this fails, the caller keeps the position open under
    the existing in-app CMP-based exit-monitor as a fallback (see
    position_manager._settle_live_exit, which submits a REAL reactive
    market exit if the in-app monitor ever detects a stop/target hit with
    no confirmed resting order protecting the position) - a resting order
    is additive protection, never the position's ONLY safety net."""
    order = _write_broker_order(
        db, user_id, position_id, "stop_loss", exchange, symbol, action, quantity,
        order_type="STOP_LOSS_MARKET", trigger_price=trigger_price,
    )
    error = _submit(
        db,
        order,
        lambda: place_broker_order(
            exchange=exchange,
            symbol=symbol,
            transaction_type=action,
            quantity=int(quantity),
            order_type="STOP_LOSS_MARKET",
            product_type="INTRADAY",
            trigger_price=trigger_price,
            token=token,
            correlation_id=order.client_order_id,
        ),
    )
    return order, error


def submit_exit_order_scheduled(
    db: Session,
    user_id: uuid.UUID,
    position_id: uuid.UUID,
    exchange: str,
    symbol: str,
    action: str,
    quantity: float,
) -> tuple[Optional[db_models.BrokerOrder], Optional[str]]:
    """Same as submit_live_order, but via market-data's internal shared-
    secret route instead of a user bearer token - for the exit-monitor/
    square-off scheduler jobs, which run with no live request/session
    context at all. Used ONLY to close an already-open live position for
    real (a real square-off, or a reactive exit when the in-app monitor
    detects a stop/target hit with no resting order covering it) - never
    an entry from THIS function specifically (a scheduler job never opens
    a new position); see submit_entry_order_scheduled below for the one
    context that DOES open a live position with no live request either
    (the automated Strategy-driven flow)."""
    return _submit_via_internal_route(db, user_id, position_id, "exit", exchange, symbol, action, quantity, order_type="MARKET")


def submit_entry_order_scheduled(
    db: Session,
    user_id: uuid.UUID,
    exchange: str,
    symbol: str,
    action: str,
    quantity: float,
) -> tuple[Optional[db_models.BrokerOrder], Optional[str]]:
    """Opens a NEW live position with no live request/session context at
    all - live-broker-adapter P3 item 14 (see docs/architecture.md): the
    automated Strategy-driven flow (open_position, called from a Redis
    consumer, not an HTTP request) has no bearer token to forward, same
    reason the scheduler jobs use the internal route for closes. Only ever
    reachable when a Strategy has an execution.strategy_accounts row with
    live_trading_enabled=true AND a live_trading_user_id set - the shared
    platform account can never trigger this (it has no such fields at
    all). position_id is always None here (unlike every other submission
    function) - a Position for this entry doesn't exist yet, same
    "Position only on fill" ordering open_manual_position's own live path
    already follows."""
    return _submit_via_internal_route(db, user_id, None, "entry", exchange, symbol, action, quantity, order_type="MARKET")


def submit_resting_stop_loss_scheduled(
    db: Session,
    user_id: uuid.UUID,
    position_id: uuid.UUID,
    exchange: str,
    symbol: str,
    action: str,
    quantity: float,
    trigger_price: float,
) -> tuple[Optional[db_models.BrokerOrder], Optional[str]]:
    """Same as submit_resting_stop_loss, but via the internal route - the
    automated Strategy-driven flow's own counterpart, placed right after
    submit_entry_order_scheduled confirms TRADED. Does NOT wait for a
    fill, same reasoning as the token-based version."""
    order = _write_broker_order(
        db, user_id, position_id, "stop_loss", exchange, symbol, action, quantity,
        order_type="STOP_LOSS_MARKET", trigger_price=trigger_price,
    )
    error = _submit(
        db,
        order,
        lambda: place_broker_order_internal(
            exchange=exchange,
            symbol=symbol,
            transaction_type=action,
            quantity=int(quantity),
            order_type="STOP_LOSS_MARKET",
            product_type="INTRADAY",
            trigger_price=trigger_price,
            user_id=str(user_id),
            correlation_id=order.client_order_id,
        ),
    )
    return order, error


def _submit_via_internal_route(
    db: Session,
    user_id: uuid.UUID,
    position_id: Optional[uuid.UUID],
    purpose: str,
    exchange: str,
    symbol: str,
    action: str,
    quantity: float,
    order_type: str,
) -> tuple[Optional[db_models.BrokerOrder], Optional[str]]:
    """Shared by submit_exit_order_scheduled/submit_entry_order_scheduled -
    both are a MARKET order via the internal route that waits for TRADED,
    differing only in purpose and whether position_id is already known."""
    order = _write_broker_order(db, user_id, position_id, purpose, exchange, symbol, action, quantity, order_type=order_type)
    error = _submit(
        db,
        order,
        lambda: place_broker_order_internal(
            exchange=exchange,
            symbol=symbol,
            transaction_type=action,
            quantity=int(quantity),
            order_type=order_type,
            product_type="INTRADAY",
            user_id=str(user_id),
            correlation_id=order.client_order_id,
        ),
    )
    if error is not None:
        return order, error
    return _wait_for_fill(db, order)


def modify_resting_order_scheduled(db: Session, user_id: uuid.UUID, order: db_models.BrokerOrder, new_trigger_price: float) -> Optional[str]:
    """Moves an already-resting order's trigger price via Dhan's Modify
    Order API - the trailing-SL reconciliation job's own mechanism
    (check_exits' own _reconcile_trailing_stop), via the internal shared-
    secret route since a scheduler job has no live user token. Throttling/
    coalescing (only call this when the new value actually differs from
    what Dhan was last told) is the CALLER's job - see
    _reconcile_trailing_stop's own docstring: it's only invoked when
    _evaluate_exits' own ratchet actually changed pos.stop_loss_price this
    tick, which already caps this to at most one call per position per
    30s exit-monitor tick."""
    if order.broker_order_id is None:
        return "no broker_order_id on record for this resting order yet - cannot modify"
    try:
        raw = modify_broker_order_internal(
            exchange=order.exchange,
            broker_order_id=order.broker_order_id,
            order_type=order.order_type,
            quantity=order.quantity,
            user_id=str(user_id),
            trigger_price=new_trigger_price,
        )
    except Exception as exc:
        logger.exception("modify resting order failed for broker_order_id=%s", order.broker_order_id)
        return f"modify order failed: {exc}"
    order.trigger_price = new_trigger_price
    order.raw_response = raw if isinstance(raw, dict) else {"raw": raw}
    db.commit()
    return None


def cancel_resting_order_scheduled(db: Session, user_id: uuid.UUID, order: db_models.BrokerOrder) -> Optional[str]:
    """Pulls a resting order via the internal route - used before a
    reactive market exit (position_manager._settle_live_exit) so at most
    ONE real closing order is ever in flight for a given position at a
    time; never called from a live HTTP request (see cancel_order/
    DELETE /dhan/orders/{id} for that path, unused so far - no route
    exposes cancelling a resting order to the Manual tab UI yet)."""
    if order.broker_order_id is None:
        return "no broker_order_id on record for this resting order yet - cannot cancel"
    try:
        raw = cancel_broker_order_internal(exchange=order.exchange, broker_order_id=order.broker_order_id, user_id=str(user_id))
    except Exception as exc:
        logger.exception("cancel resting order failed for broker_order_id=%s", order.broker_order_id)
        return f"cancel order failed: {exc}"
    order.status = "cancelled"
    order.raw_response = raw if isinstance(raw, dict) else {"raw": raw}
    db.commit()
    return None
