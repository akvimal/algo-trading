"""EOD equity screener - GET /equity-screener, the read side of
app/scheduler.py's _record_equity_screener_snapshot (see
app/domain/equity_screener.py for the momentum/trend + 52-week-proximity
math). Pure DB read, no live Dhan call and no auth dependency - same
"reads what the scheduled job already persisted" shape as
app/api/routes/oi_buildup.py.
"""

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.adapters.db.models import EquityScreenerSnapshot
from app.adapters.db.session import get_db
from app.domain.equity_screener import LIQUID_MIN_CR, percentile_ranks
from app.domain.models import EquityScreenerHistoryPoint, EquityScreenerOut, EquityScreenerRowOut

router = APIRouter()


@router.get("/equity-screener", response_model=EquityScreenerOut)
def get_equity_screener(history_days: int = Query(10, ge=1, le=60), db: Session = Depends(get_db)):
    """Every NSE equity's most recent EOD momentum/trend + 52-week-
    proximity read (the latest snapshot_date the job has actually
    written), each with up to `history_days` earlier days' closes
    (oldest-first, INCLUDING the latest row itself) for the frontend's
    sparkline. Empty rows list (not a 404) before the job has ever run
    once - same convention as GET /oi-buildup."""
    latest_date: date | None = db.query(func.max(EquityScreenerSnapshot.snapshot_date)).scalar()
    if latest_date is None:
        return EquityScreenerOut(snapshot_date=date.today(), rows=[])

    latest_rows = (
        db.query(EquityScreenerSnapshot)
        .filter(EquityScreenerSnapshot.snapshot_date == latest_date)
        .order_by(EquityScreenerSnapshot.symbol.asc())
        .all()
    )
    symbols = [row.symbol for row in latest_rows]

    history_rows = (
        db.query(EquityScreenerSnapshot)
        .filter(EquityScreenerSnapshot.symbol.in_(symbols))
        .order_by(EquityScreenerSnapshot.symbol.asc(), EquityScreenerSnapshot.snapshot_date.desc())
        .all()
    )
    history_by_symbol: dict[str, list[EquityScreenerSnapshot]] = {}
    for row in history_rows:
        bucket = history_by_symbol.setdefault(row.symbol, [])
        if len(bucket) < history_days:
            bucket.append(row)

    # Ranks are among the stocks a swing trader could actually trade (at least Rs 5 Cr a day), so a thinly traded micro-cap's wild return never sets the scale.
    liquid = [r for r in latest_rows if (r.avg_turnover_cr or 0) >= LIQUID_MIN_CR]
    rs_3m = percentile_ranks({r.symbol: r.ret_3m_pct for r in liquid})
    rs_12m = percentile_ranks({r.symbol: r.mom_12_1_pct for r in liquid})

    rows = [
        EquityScreenerRowOut(
            symbol=row.symbol,
            exchange=row.exchange,
            snapshot_date=row.snapshot_date,
            close=row.close,
            pct_change_5d=row.pct_change_5d,
            pct_change_20d=row.pct_change_20d,
            adx=row.adx,
            regime=row.regime,
            high_52w=row.high_52w,
            low_52w=row.low_52w,
            pct_from_52w_high=row.pct_from_52w_high,
            pct_from_52w_low=row.pct_from_52w_low,
            proximity=row.proximity,
            is_fno=bool(row.is_fno),
            universes=[k for k in (row.index_memberships or "").split(",") if k],
            avg_turnover_cr=row.avg_turnover_cr,
            ret_3m_pct=row.ret_3m_pct,
            mom_12_1_pct=row.mom_12_1_pct,
            rsi3=row.rsi3,
            dist_ema20_pct=row.dist_ema20_pct,
            atr_pct=row.atr_pct,
            vol_ratio=row.vol_ratio,
            rs_3m_pctile=rs_3m.get(row.symbol),
            rs_12m_pctile=rs_12m.get(row.symbol),
            history=[
                EquityScreenerHistoryPoint.model_validate(h)
                for h in reversed(history_by_symbol.get(row.symbol, []))
            ],
        )
        for row in latest_rows
    ]
    return EquityScreenerOut(snapshot_date=latest_date, rows=rows)
