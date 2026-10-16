"""The track record of the major-OI-shift alert: for every stock it named, what the price did over the next one to three daily bars, signed so
positive means the alert's direction was right, next to what the average stock did over the same bars (so a rising market does not make every
bullish alert look clever). Recorded and settled by the nightly OI swing shadow job, from rows already stored: no provider calls, no orders."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Optional

HORIZONS = (1, 2, 3)


def sign(direction: str) -> int:
    return 1 if direction == "bullish" else -1


def pct_moves(ref_close: Optional[float], closes: list[float]) -> list[Optional[float]]:
    """Unsigned % move from the reference close to each of the next bars' closes, one entry per horizon (None where that bar does not exist yet)."""
    out: list[Optional[float]] = []
    for k in HORIZONS:
        out.append(round((closes[k - 1] / ref_close - 1) * 100, 3) if ref_close and len(closes) >= k else None)
    return out


def signed(direction: str, moves: list[Optional[float]]) -> list[Optional[float]]:
    return [None if m is None else round(sign(direction) * m, 3) for m in moves]


def market_moves(per_stock: list[list[Optional[float]]]) -> list[Optional[float]]:
    """The average unsigned move per horizon across stocks that have it. A horizon needs at least 20 stocks, or it is None."""
    out: list[Optional[float]] = []
    for i in range(len(HORIZONS)):
        vals = [m[i] for m in per_stock if m[i] is not None]
        out.append(round(sum(vals) / len(vals), 3) if len(vals) >= 20 else None)
    return out


def record_and_settle(db, today: date) -> tuple[int, int]:
    """Writes tonight's alerted stocks (the same ones the 16:05 alert picked, recomputed from the stored scan) and fills in the results of earlier
    nights as their bars arrive. Idempotent. Returns (rows written, rows fully settled)."""
    from app.adapters.db.models import EquityDailyBar, OiAlertOutcome, OiEodSnapshot
    from app.domain import notification_jobs

    written = 0
    shifts, snapshot_date = notification_jobs.latest_shifts(db)
    if snapshot_date == today:
        for s in shifts:
            if db.query(OiAlertOutcome).filter(OiAlertOutcome.symbol == s["symbol"], OiAlertOutcome.snapshot_date == today).first() is not None:
                continue
            db.add(OiAlertOutcome(snapshot_date=today, symbol=s["symbol"], direction=s["direction"], score=s["score"], source=s["source"], reasons=s["reasons"]))
            written += 1
        db.commit()

    settled = 0
    open_rows = db.query(OiAlertOutcome).filter(OiAlertOutcome.resolved_at.is_(None), OiAlertOutcome.snapshot_date < today).all()
    by_night: dict[date, list] = {}
    for r in open_rows:
        by_night.setdefault(r.snapshot_date, []).append(r)
    for night, rows in by_night.items():
        symbols = [r.symbol for r in db.query(OiEodSnapshot.symbol).filter(OiEodSnapshot.snapshot_date == night)]
        bars: dict[str, dict[date, float]] = {}
        for b in db.query(EquityDailyBar).filter(EquityDailyBar.symbol.in_(symbols), EquityDailyBar.bar_date >= night, EquityDailyBar.bar_date <= night + timedelta(days=12)):
            bars.setdefault(b.symbol, {})[b.bar_date] = b.close

        def moves_for(symbol: str) -> tuple[Optional[float], list[Optional[float]]]:
            series = bars.get(symbol, {})
            ref = series.get(night)
            after = [series[d] for d in sorted(series) if d > night]
            return ref, pct_moves(ref, after)

        mkt = market_moves([moves_for(sym)[1] for sym in symbols])
        for r in rows:
            ref, moves = moves_for(r.symbol)
            if ref is None:
                continue  # the alert night's own bar is not stored (yet): nothing to measure from
            r.ref_close = ref
            r.ret_1d, r.ret_2d, r.ret_3d = signed(r.direction, moves)
            r.mkt_1d, r.mkt_2d, r.mkt_3d = signed(r.direction, mkt)
            if r.ret_3d is not None:
                r.resolved_at = datetime.now(timezone.utc)
                settled += 1
        db.commit()
    return written, settled
