"""GET /zone-scan - the nightly shortlist of F&O stocks at a demand or supply zone (see app/domain/zone_scan.py for what the tiers mean and
app/scheduler.py's _record_zone_scan for when it is written). Read by the OI buildup scan page's "At a zone" filter and its zone badges."""

from datetime import date
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.adapters.db.models import ZoneScan
from app.adapters.db.session import get_db

router = APIRouter()

_TIER_ORDER = {"A": 0, "B": 1, "C": 2}


class ZoneScanRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    symbol: str
    exchange: str
    close: float
    daily_trend: Literal["up", "down", "range"]
    weekly_trend: Optional[Literal["up", "down", "range"]] = None
    tier: Literal["A", "B", "C"]
    zone_kind: Literal["demand", "supply"]
    zone_position: Literal["inside", "approaching"]
    zone_proximal: float
    zone_distal: float
    zone_distance_pct: float
    zone_distance_atr: float
    weekly_zone: bool
    weekly_agrees: bool
    call_buildup: Optional[str] = None
    put_buildup: Optional[str] = None
    oi_agrees: Optional[bool] = None


class ZoneScanOut(BaseModel):
    snapshot_date: Optional[date] = None  # None before the first scan has ever run
    rows: list[ZoneScanRow]


@router.get("/zone-scan", response_model=ZoneScanOut)
def get_zone_scan(
    day: Optional[date] = Query(None, alias="date", description="A past scan day; default is the latest"),
    tier: Optional[str] = Query(None, description="Only this tier (A, B or C)"),
    db: Session = Depends(get_db),
):
    """The stocks that had an untested, trend-aligned daily zone at or approaching price on the scan day, best tier first and then nearest first."""
    if tier is not None and tier.upper() not in _TIER_ORDER:
        raise HTTPException(status_code=422, detail="tier must be A, B or C")
    snapshot = day or db.query(func.max(ZoneScan.snapshot_date)).scalar()
    if snapshot is None:
        return ZoneScanOut(rows=[])
    q = db.query(ZoneScan).filter(ZoneScan.snapshot_date == snapshot, ZoneScan.tier.isnot(None))
    if tier is not None:
        q = q.filter(ZoneScan.tier == tier.upper())
    rows = sorted(q.all(), key=lambda r: (_TIER_ORDER[r.tier], r.zone_distance_atr or 0.0, r.symbol))
    return ZoneScanOut(snapshot_date=snapshot, rows=[ZoneScanRow.model_validate(r) for r in rows])
