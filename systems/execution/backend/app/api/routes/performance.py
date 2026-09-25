"""GET /performance/{segment} - the caller's own trading performance and
discipline score, computed on the server (app/domain/performance.py) so a
graduation gate can rely on it. Scope 'epoch' (default) counts only trades from
the current equity curve (since the latest reset); 'all' counts every trade."""

from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.auth import User, get_current_user
from app.domain.equity_history import compute_equity_stats, to_point
from app.domain.models import DisciplineOut, EquityStatsOut, PerformanceOut, PerformanceStatsOut
from app.domain.performance import compute_discipline, compute_performance, epoch_start, load_manual_trades

router = APIRouter()

_SEGMENTS = ("NSE", "MCX", "CRYPTO")


def _discipline_out(d: dict) -> DisciplineOut:
    return DisciplineOut(
        score=d["score"], window_days=d["windowDays"], window_start=d["windowStart"], trade_count=d["tradeCount"],
        planned=d["planned"], plan_adherence=d["planAdherence"],
        plan_review={"rate": d["planReview"]["rate"], "trades": d["planReview"]["trades"], "before_rate": d["planReview"]["beforeRate"], "after_rate": d["planReview"]["afterRate"]},
        outcome={"rate": d["outcome"]["rate"], "trades": d["outcome"]["trades"], "win_rate": d["outcome"]["winRate"], "avg_r": d["outcome"]["avgR"]},
    )


@router.get("/performance/{segment}", response_model=PerformanceOut)
def get_performance(
    segment: str,
    scope: Literal["epoch", "all"] = "epoch",
    discipline_days: int = Query(30, ge=1, le=365),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    seg = segment.upper()
    if seg not in _SEGMENTS:
        raise HTTPException(status_code=404, detail=f"unknown segment {segment}")
    account = db.query(db_models.Account).filter_by(user_id=user.id, segment=seg).first()
    since = epoch_start(db, account) if (scope == "epoch" and account is not None) else None
    trades = load_manual_trades(db, user.id, seg, since)

    equity = None
    if account is not None:
        rows = (
            db.query(db_models.AccountEquitySnapshot)
            .filter_by(account_id=account.id)
            .order_by(db_models.AccountEquitySnapshot.snapshot_date.asc())
            .all()
        )
        stats = compute_equity_stats([to_point(r) for r in rows])
        equity = EquityStatsOut(**asdict(stats)) if stats is not None else None

    perf = compute_performance([t for t in trades if not t.auto_traded])
    return PerformanceOut(
        segment=seg, scope=scope, since=since,
        performance=PerformanceStatsOut(**asdict(perf)) if perf is not None else None,
        discipline=_discipline_out(compute_discipline(trades, discipline_days)),
        equity=equity,
    )
