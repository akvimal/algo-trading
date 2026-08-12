"""Provider webhook intake - replaces the n8n chartink-{buy,sell}-intake
workflows (see docs/architecture.md). One route per provider+direction,
same convention n8n used (a query param scopes a request to a Strategy,
not a route per strategy) - adding a new provider means adding a new
parse_<provider>_alert (app/domain/intake/<provider>.py) plus 1-2 routes
here, never touching the resolution/execution systems - see the
add-signal-provider skill."""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.adapters.db.session import get_db
from app.domain.intake.chartink import parse_chartink_alert
from app.domain.intake.core import archive_raw_payload, create_signal_from_ingest
from app.domain.models import SignalIngest

router = APIRouter()


def _handle_chartink_alert(db: Session, body: dict, strategy_id: str, action: str) -> dict:
    """Archive first (same ordering n8n's workflow used - a malformed
    payload is still archived for debugging), then normalize/fan-out.
    One bad symbol (missing/unparseable price, or a price that fails
    SignalIngest's own validation) is skipped, not allowed to abort the
    rest of a multi-symbol alert - an explicit improvement over n8n's
    opaque per-item failure behavior."""
    archive_raw_payload(db, "chartink", body)

    scan_name = body.get("scan_name") or body.get("alert_name")
    results = []
    for symbol, price in parse_chartink_alert(body):
        if price is None:
            results.append({"symbol": symbol, "status": "skipped", "reason": "missing/invalid price"})
            continue
        try:
            signal = SignalIngest(
                strategy_id=strategy_id,
                symbol=symbol,
                exchange="NSE",  # Chartink scans in this repo are NSE-only
                action=action,
                price=price,
                source="chartink",
                source_meta={"scan_name": scan_name, "alert_name": body.get("alert_name")},
            )
        except ValidationError as exc:
            results.append({"symbol": symbol, "status": "rejected", "reason": str(exc)})
            continue
        results.append({"symbol": symbol, **create_signal_from_ingest(db, signal)})

    return {"status": "ok", "received": len(results), "results": results}


@router.post("/webhook/chartink-buy", status_code=202)
def chartink_buy(payload: dict, strategy_id: str = Query(...), db: Session = Depends(get_db)):
    if not strategy_id:
        raise HTTPException(status_code=422, detail="strategy_id is required")
    return _handle_chartink_alert(db, payload, strategy_id, "BUY")


@router.post("/webhook/chartink-sell", status_code=202)
def chartink_sell(payload: dict, strategy_id: str = Query(...), db: Session = Depends(get_db)):
    if not strategy_id:
        raise HTTPException(status_code=422, detail="strategy_id is required")
    return _handle_chartink_alert(db, payload, strategy_id, "SELL")
