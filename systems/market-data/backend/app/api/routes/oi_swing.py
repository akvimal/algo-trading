"""GET /oi-swing/shadow and /oi-swing/summary - the shadow log of the 1-3 day open-interest swing idea (app/domain/oi_swing_shadow.py, written by
app/scheduler.py's _record_oi_swing_shadow). Read-only: nothing here places an order."""

from datetime import date
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.adapters.db.models import OiAlertOutcome, OiSwingShadow
from app.adapters.db.session import get_db

router = APIRouter()


class ShadowRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    snapshot_date: date
    symbol: str
    direction: Literal["LONG", "SHORT"]
    taken: bool
    skip_reason: Optional[str] = None
    score: Optional[float] = None
    tier: Optional[str] = None
    criteria: dict
    ref_close: float
    stop_price: float
    risk_pct: Optional[float] = None
    result: Optional[str] = None
    entry_price: Optional[float] = None
    exit_price: Optional[float] = None
    exit_day: Optional[int] = None
    r_multiple: Optional[float] = None
    mfe_r: Optional[float] = None
    mae_r: Optional[float] = None


class ShadowOut(BaseModel):
    snapshot_date: Optional[date] = None
    rows: list[ShadowRow]


@router.get("/oi-swing/shadow", response_model=ShadowOut)
def get_shadow(
    day: Optional[date] = Query(None, description="A night; default is the latest one with rows"),
    decision: Literal["all", "taken", "skipped"] = "all",
    direction: Optional[Literal["LONG", "SHORT"]] = None,
    db: Session = Depends(get_db),
):
    """The night's candidates (stocks at a zone), best score first, with every criterion's value and verdict and, once known, the outcome."""
    snapshot = day or db.query(func.max(OiSwingShadow.snapshot_date)).scalar()
    if snapshot is None:
        return ShadowOut(rows=[])
    q = db.query(OiSwingShadow).filter(OiSwingShadow.snapshot_date == snapshot)
    if decision != "all":
        q = q.filter(OiSwingShadow.taken.is_(decision == "taken"))
    if direction:
        q = q.filter(OiSwingShadow.direction == direction)
    rows = sorted(q.all(), key=lambda r: (-(r.score or 0), r.symbol))
    return ShadowOut(snapshot_date=snapshot, rows=[ShadowRow.model_validate(r) for r in rows])


class Bucket(BaseModel):
    n: int
    resolved: int
    wins: int  # r_multiple > 0
    avg_r: Optional[float] = None


class SummaryOut(BaseModel):
    nights: int
    first_night: Optional[date] = None
    last_night: Optional[date] = None
    taken: Bucket
    skipped: Bucket  # what the candidates that failed a criterion went on to do: the control group
    by_direction: dict[str, Bucket]


def _bucket(rows: list[OiSwingShadow]) -> Bucket:
    done = [r for r in rows if r.result and r.result != "invalid"]
    return Bucket(
        n=len(rows), resolved=len(done), wins=sum(1 for r in done if (r.r_multiple or 0) > 0),
        avg_r=round(sum(r.r_multiple or 0 for r in done) / len(done), 2) if done else None,
    )


@router.get("/oi-swing/summary", response_model=SummaryOut)
def get_summary(db: Session = Depends(get_db)):
    """How the would-have-taken rows did against the ones the criteria turned away. Small samples for a long while: read the counts before the averages."""
    rows = db.query(OiSwingShadow).all()
    dates = sorted({r.snapshot_date for r in rows})
    return SummaryOut(
        nights=len(dates), first_night=dates[0] if dates else None, last_night=dates[-1] if dates else None,
        taken=_bucket([r for r in rows if r.taken]), skipped=_bucket([r for r in rows if not r.taken]),
        by_direction={d: _bucket([r for r in rows if r.taken and r.direction == d]) for d in ("LONG", "SHORT")},
    )


class AlertBucket(BaseModel):
    n: int  # alerts that have at least a 1-day result
    hit_rate: Optional[float] = None  # share that moved the called way, %
    avg: Optional[float] = None  # average signed move, %
    avg_vs_market: Optional[float] = None  # ...minus the average stock's, same sign convention


class AlertSummaryOut(BaseModel):
    alerts: int
    nights: int
    first_night: Optional[date] = None
    last_night: Optional[date] = None
    horizons: dict[str, AlertBucket]  # "1d" | "2d" | "3d"
    by_direction: dict[str, dict[str, AlertBucket]]


class AlertRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    snapshot_date: date
    symbol: str
    direction: str
    score: Optional[float] = None
    source: Optional[str] = None
    reasons: Optional[list] = None
    ret_1d: Optional[float] = None
    ret_2d: Optional[float] = None
    ret_3d: Optional[float] = None
    mkt_1d: Optional[float] = None
    mkt_2d: Optional[float] = None
    mkt_3d: Optional[float] = None


def _alert_bucket(rows: list[OiAlertOutcome], k: int) -> AlertBucket:
    pairs = [(getattr(r, f"ret_{k}d"), getattr(r, f"mkt_{k}d")) for r in rows if getattr(r, f"ret_{k}d") is not None]
    if not pairs:
        return AlertBucket(n=0)
    rets = [p[0] for p in pairs]
    diffs = [p[0] - p[1] for p in pairs if p[1] is not None]
    return AlertBucket(
        n=len(pairs), hit_rate=round(100 * sum(1 for r in rets if r > 0) / len(rets), 1), avg=round(sum(rets) / len(rets), 2),
        avg_vs_market=round(sum(diffs) / len(diffs), 2) if diffs else None,
    )


@router.get("/oi-swing/alerts/summary", response_model=AlertSummaryOut)
def get_alert_summary(db: Session = Depends(get_db)):
    """How the stocks the major-OI-shift alert named did over the next 1-3 days, against the average stock. Few alerts a week, so read n first."""
    rows = db.query(OiAlertOutcome).all()
    dates = sorted({r.snapshot_date for r in rows})
    return AlertSummaryOut(
        alerts=len(rows), nights=len(dates), first_night=dates[0] if dates else None, last_night=dates[-1] if dates else None,
        horizons={f"{k}d": _alert_bucket(rows, k) for k in (1, 2, 3)},
        by_direction={d: {f"{k}d": _alert_bucket([r for r in rows if r.direction == d], k) for k in (1, 2, 3)} for d in ("bullish", "bearish")},
    )


@router.get("/oi-swing/alerts", response_model=list[AlertRow])
def get_alerts(limit: int = Query(60, ge=1, le=500), db: Session = Depends(get_db)):
    """The most recent alerted stocks with their results so far, newest night first."""
    rows = db.query(OiAlertOutcome).order_by(OiAlertOutcome.snapshot_date.desc(), OiAlertOutcome.score.desc()).limit(limit).all()
    return [AlertRow.model_validate(r) for r in rows]
