"""Service-to-service routes - never called by a browser or by a user's own
bearer token, only by market-data relaying Dhan's own order-status postback
(live-broker-adapter P0, see docs/architecture.md). Protected by a shared
secret header, not a user JWT, since the caller here is a trusted service,
not a person - mirrors systems/accounts' identical app/api/routes/internal.py
pattern. Must be included in main.py WITHOUT the app-wide get_current_user
dependency (same as health.router) - market-data has no user bearer token to
forward here, only the shared secret."""

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.adapters.db import models
from app.adapters.db.session import get_db
from app.config import settings
from app.domain.position_manager import settle_live_position_exit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal", tags=["internal"])


def _require_internal_secret(x_internal_secret: str = Header(default="")) -> None:
    if x_internal_secret != settings.internal_service_secret:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="invalid internal service secret")


@router.post("/dhan/order-update", dependencies=[Depends(_require_internal_secret)])
def dhan_order_update(payload: dict, db: Session = Depends(get_db)):
    """Relayed as-is by market-data's POST /dhan/order-update/{secret} -
    see that route's own docstring on why market-data itself validates only
    the shared-secret path segment and holds no order state of its own.
    Matches the update to a broker_orders row by correlationId (which we
    always send as our own client_order_id, see BrokerOrder's own comment) -
    silently ignored (not a 404/500) if no such row exists, since a
    postback for an order this service didn't originate (e.g. a stale
    secret shared with a decommissioned deployment) must never crash this
    endpoint - Dhan itself doesn't retry postbacks in a way that tolerates
    a non-2xx cleanly."""
    correlation_id = payload.get("correlationId")
    broker_order_id = payload.get("orderId")
    order_status = payload.get("orderStatus")

    order = None
    if correlation_id:
        order = db.query(models.BrokerOrder).filter(models.BrokerOrder.client_order_id == correlation_id).one_or_none()
    if order is None and broker_order_id:
        order = db.query(models.BrokerOrder).filter(models.BrokerOrder.broker_order_id == broker_order_id).one_or_none()
    if order is None:
        logger.warning("Dhan order-update postback matched no broker_orders row: %s", payload)
        return {"matched": False}

    if broker_order_id:
        order.broker_order_id = broker_order_id
    if order_status:
        order.status = _STATUS_MAP.get(order_status.upper(), order.status)
    # Best-effort only - Dhan's exact postback field names for fill price/
    # quantity aren't confirmed live yet (see DhanProvider.place_order's
    # own docstring on this whole slice's unconfirmed-field-shape caveat).
    # live_broker.submit_live_order's caller falls back to its own
    # originally-computed price/quantity when these stay None, so a wrong
    # guess here degrades gracefully rather than corrupting a real trade.
    avg_price = payload.get("averageTradedPrice") or payload.get("tradedPrice") or payload.get("price")
    if avg_price:
        try:
            order.average_fill_price = float(avg_price)
        except (TypeError, ValueError):
            pass
    filled_qty = payload.get("filledQty") or payload.get("tradedQty") or payload.get("quantity")
    if filled_qty:
        try:
            order.filled_quantity = int(float(filled_qty))
        except (TypeError, ValueError):
            pass
    order.raw_response = payload
    db.commit()

    # Live-broker-adapter P2 (see docs/architecture.md) - a RESTING
    # stop-loss order fills on Dhan's own schedule, not ours; neither
    # scheduler job is watching for that moment, so this postback is the
    # ONLY place that ever learns about it. An 'exit' order (a scheduled
    # square-off/reactive exit) is normally already settled synchronously
    # by whichever job submitted it (see position_manager._settle_live_exit) -
    # settle_live_position_exit's own idempotency guard (no-op if the
    # position isn't OPEN any more) makes a redundant postback for that
    # case harmless rather than double-applying P&L.
    if order.status == "traded" and order.position_id is not None and order.purpose in ("stop_loss", "exit"):
        pos = db.get(models.Position, order.position_id)
        if pos is not None:
            exit_price = order.average_fill_price
            if exit_price is None and order.purpose == "stop_loss" and order.trigger_price is not None:
                exit_price = order.trigger_price
            if exit_price is not None:
                settle_live_position_exit(db, pos, float(exit_price), "stop_loss" if order.purpose == "stop_loss" else "square_off")
                db.commit()
            else:
                logger.warning(
                    "position %s: stop-loss/exit order %s reached TRADED but no fill price could be determined - "
                    "left OPEN, will need manual attention",
                    order.position_id, order.id,
                )

    return {"matched": True, "broker_order_id": order.broker_order_id, "status": order.status}


# Dhan's own order-status vocabulary (TRANSIT/PENDING/TRADED/REJECTED/
# CANCELLED/EXPIRED per general v2 docs) mapped onto broker_orders.status's
# narrower CHECK constraint - unconfirmed against a live postback payload,
# same caveat as everywhere else in this P0 slice (see DhanProvider.
# place_order's own docstring).
_STATUS_MAP = {
    "TRANSIT": "pending",
    "PENDING": "pending",
    "TRADED": "traded",
    "REJECTED": "rejected",
    "CANCELLED": "cancelled",
    "EXPIRED": "cancelled",
}
