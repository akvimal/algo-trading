"""GET /equity-history/{segment} - the caller's own balance/equity curve for one
segment, plus statistics over the CURRENT curve (from the latest reset). See
app/domain/equity_history.py for how it is recorded and its granularity."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.auth import User, get_current_user
from app.domain.equity_history import compute_equity_stats, to_point, today_in_equity_tz
from app.domain.models import EquityHistoryOut, EquityPointOut, EquityStatsOut

router = APIRouter()

_SEGMENTS = ("NSE", "MCX", "CRYPTO")


@router.get("/equity-history/{segment}", response_model=EquityHistoryOut)
def get_equity_history(
    segment: str, days: int = Query(90, ge=1, le=730), user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """`points` covers the last `days` days; `stats` always covers the whole
    current curve (so a short window cannot make a drawdown disappear). Only
    ever the caller's own account."""
    seg = segment.upper()
    if seg not in _SEGMENTS:
        raise HTTPException(status_code=404, detail=f"unknown segment {segment}")
    account = db.query(db_models.Account).filter_by(user_id=user.id, segment=seg).first()
    if account is None:
        return EquityHistoryOut(segment=seg, days=days, points=[], stats=None)

    rows = (
        db.query(db_models.AccountEquitySnapshot)
        .filter_by(account_id=account.id)
        .order_by(db_models.AccountEquitySnapshot.snapshot_date.asc())
        .all()
    )
    all_points = [to_point(r) for r in rows]
    stats = compute_equity_stats(all_points)
    window_start = today_in_equity_tz(datetime.now(timezone.utc)) - timedelta(days=days - 1)
    return EquityHistoryOut(
        segment=seg,
        days=days,
        points=[
            EquityPointOut(
                snapshot_date=p.day, balance=p.balance, unrealized_pnl=p.unrealized_pnl, equity=p.equity, is_reset_point=p.is_reset_point
            )
            for p in all_points
            if p.day >= window_start
        ],
        stats=EquityStatsOut(
            since=stats.since,
            baseline=stats.baseline,
            latest_equity=stats.latest_equity,
            return_pct=stats.return_pct,
            peak_equity=stats.peak_equity,
            max_drawdown_pct=stats.max_drawdown_pct,
            days_tracked=stats.days_tracked,
            points=stats.points,
        )
        if stats is not None
        else None,
    )
