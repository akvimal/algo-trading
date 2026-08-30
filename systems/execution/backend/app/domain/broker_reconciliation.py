"""Live-broker-adapter P0 item 6 (see docs/architecture.md) - resolves
execution.broker_orders rows stuck in 'submitting' past
settings.broker_order_submit_timeout_seconds against Dhan's own order book,
rather than ever retrying a submission blind. A row lands in 'submitting'
only when this service crashes (or the outbound call to market-data times
out) between writing the row and recording Dhan's place-order response -
see broker_orders' own comment (infra/postgres/init/02-execution.sql) on
why that write ordering is the whole point.

Matching is by client_order_id, which we always send to Dhan as its own
correlationId (see DhanProvider.place_order's docstring on why that dedup
isn't yet confirmed to actually work Dhan-side - this job's match-by-value
fallback is what makes that unconfirmed assumption non-fatal even if Dhan
never echoes it back reliably: worst case a stuck row simply stays
'submitting' for another poll rather than silently double-submitting).

user_id is required on every real broker_orders row precisely because this
job (and market-data's order-placement routes generally) has no path to
place/query a real order without a specific person's own BYO Dhan
credentials - see app/auth.py's require_user_id in market-data. A row with
no user_id (the legacy platform-wide automated-Strategy flow) cannot be
reconciled here at all yet - live automation for Strategy-driven signals is
explicitly out of scope until P3 item 14."""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.adapters.db import models
from app.adapters.quotes.client import get_broker_order_book_internal
from app.config import settings

logger = logging.getLogger(__name__)


def reconcile_stuck_broker_orders(db: Session) -> dict:
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=settings.broker_order_submit_timeout_seconds)
    stuck = (
        db.query(models.BrokerOrder)
        .filter(models.BrokerOrder.status == "submitting")
        .filter(models.BrokerOrder.requested_at < cutoff)
        .filter(models.BrokerOrder.user_id.isnot(None))
        .all()
    )
    resolved = 0
    still_stuck = 0
    for order in stuck:
        try:
            book = get_broker_order_book_internal(order.exchange, str(order.user_id))
        except Exception:
            logger.exception("reconciliation: could not fetch Dhan order book for user %s / exchange %s", order.user_id, order.exchange)
            still_stuck += 1
            continue

        match = next(
            (
                row
                for row in book
                if row.get("correlationId") == order.client_order_id or row.get("orderId") == order.broker_order_id
            ),
            None,
        )
        if match is None:
            # Genuinely never reached Dhan (crashed before the HTTP call
            # completed, or Dhan itself rejected it silently) - mark
            # failed rather than leaving it 'submitting' forever. No
            # Position was ever created off this row (see the
            # live-broker-adapter plan's own "Position created only on
            # fill" design), so there's nothing else to unwind.
            order.status = "failed"
            order.failure_reason = "not found in Dhan's order book after submit timeout"
        else:
            order.broker_order_id = match.get("orderId") or order.broker_order_id
            order.raw_response = match
            order.status = _map_dhan_status(match.get("orderStatus"))
        resolved += 1

    if stuck:
        db.commit()
    if resolved or still_stuck:
        logger.info("broker-order reconciliation: resolved=%s still_stuck=%s", resolved, still_stuck)
    return {"resolved": resolved, "still_stuck": still_stuck}


def _map_dhan_status(dhan_status: str) -> str:
    return {
        "TRANSIT": "pending",
        "PENDING": "pending",
        "TRADED": "traded",
        "REJECTED": "rejected",
        "CANCELLED": "cancelled",
        "EXPIRED": "cancelled",
    }.get((dhan_status or "").upper(), "pending")
