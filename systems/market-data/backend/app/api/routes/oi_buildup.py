"""OI-buildup EOD screener - GET /oi-buildup, the read side of
app/scheduler.py's _record_oi_eod_snapshot (see app/domain/oi_buildup.py
for the buildup-classification math). Pure DB read, no live Dhan call and
no auth dependency - unlike GET /options/oi-summary etc., this never
touches a BYO Dhan credential, it only ever reads what the scheduled job
already persisted using the platform-default one.
"""

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.adapters.db.models import OiEodSnapshot
from app.adapters.db.session import get_db
from app.domain.models import OiBuildupScreenerOut, OiEodSnapshotHistoryPoint, OiEodSnapshotOut

router = APIRouter()


@router.get("/oi-buildup", response_model=OiBuildupScreenerOut)
def get_oi_buildup(history_days: int = Query(10, ge=1, le=60), db: Session = Depends(get_db)):
    """Every NSE F&O stock's most recent EOD OI snapshot (the latest
    snapshot_date the job has actually written - not necessarily "today",
    e.g. before the job's own scheduled time has run yet), each with up to
    `history_days` earlier days (oldest-first, INCLUDING the latest row
    itself as the last point) for the frontend's sparkline. Empty rows
    list (not a 404) before the job has ever run once."""
    latest_date: date | None = db.query(func.max(OiEodSnapshot.snapshot_date)).scalar()
    if latest_date is None:
        return OiBuildupScreenerOut(snapshot_date=date.today(), rows=[])

    latest_rows = (
        db.query(OiEodSnapshot)
        .filter(OiEodSnapshot.snapshot_date == latest_date)
        .order_by(OiEodSnapshot.symbol.asc())
        .all()
    )
    symbols = [row.symbol for row in latest_rows]

    # One query for every symbol's last `history_days` rows, newest first
    # per symbol (idx_oi_eod_snapshot_symbol_date backs this directly) -
    # bucketed in Python below rather than N separate per-symbol queries.
    history_rows = (
        db.query(OiEodSnapshot)
        .filter(OiEodSnapshot.symbol.in_(symbols))
        .order_by(OiEodSnapshot.symbol.asc(), OiEodSnapshot.snapshot_date.desc())
        .all()
    )
    history_by_symbol: dict[str, list[OiEodSnapshot]] = {}
    for row in history_rows:
        bucket = history_by_symbol.setdefault(row.symbol, [])
        if len(bucket) < history_days:
            bucket.append(row)

    rows = [
        OiEodSnapshotOut(
            symbol=row.symbol,
            exchange=row.exchange,
            snapshot_date=row.snapshot_date,
            spot_price=row.spot_price,
            total_call_oi=row.total_call_oi,
            total_put_oi=row.total_put_oi,
            pcr=row.pcr,
            call_oi_change_pct=row.call_oi_change_pct,
            put_oi_change_pct=row.put_oi_change_pct,
            price_change_pct=row.price_change_pct,
            call_buildup=row.call_buildup,
            put_buildup=row.put_buildup,
            history=[
                OiEodSnapshotHistoryPoint.model_validate(h)
                for h in reversed(history_by_symbol.get(row.symbol, []))
            ],
        )
        for row in latest_rows
    ]
    return OiBuildupScreenerOut(snapshot_date=latest_date, rows=rows)
