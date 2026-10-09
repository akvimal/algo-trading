"""Balance and equity history for paper accounts.

An account only ever held its CURRENT balance, so there was no equity curve, no
drawdown, and nothing a graduation gate could trust (browser-computed numbers
cannot be). This records one row per account per day (execution.
account_equity_snapshots, see infra/postgres/migrations/
020-account-equity-snapshots.sql) and turns the rows into statistics.

Recording is STATE SAMPLING, not event hooks: a scheduled job reads each
account's current balance and marks its open positions to market, so it never
needs to know which of the several code paths (open fees, closes, exits,
square-off) moved the balance, and a missed tick loses only intraday
resolution, never a realized change. The one event that IS hooked is a reset,
because a reset starts a NEW curve: it writes a marker row, and the statistics
measure only from the latest marker so a reset can never hide earlier losses.

Granularity is one row per day (the last write wins), so max drawdown here is a
close-of-day drawdown and understates intraday swings. Rows are sparse: a day
with nothing open and no balance change writes nothing.
"""

import logging
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.config import settings
from app.domain.position_manager import _usdinr_rate_by_user, compute_unrealized_pnl, inr_of

logger = logging.getLogger(__name__)


# --- pure statistics -----------------------------------------------------------------------------


@dataclass(frozen=True)
class EquityPoint:
    day: date
    starting_balance: float
    balance: float
    unrealized_pnl: float
    equity: float
    is_reset_point: bool


@dataclass(frozen=True)
class EquityStats:
    """Measured over the current curve only (from the latest reset point)."""

    since: date
    baseline: float  # what the curve started from (the starting balance)
    latest_equity: float
    return_pct: float
    peak_equity: float
    max_drawdown_pct: float
    days_tracked: int  # calendar days from `since` to the last point, inclusive
    points: int


def current_curve(points: list[EquityPoint]) -> list[EquityPoint]:
    """The points from the latest reset marker onward (all of them if there is
    none). `points` must be in ascending date order."""
    start = 0
    for i, p in enumerate(points):
        if p.is_reset_point:
            start = i
    return points[start:]


def compute_equity_stats(points: list[EquityPoint]) -> Optional[EquityStats]:
    """None for no history. Return is measured against the curve's starting
    balance; the running peak starts at that baseline, so a curve that only
    ever loses still shows a drawdown from where it began."""
    curve = current_curve(points)
    if not curve:
        return None
    baseline = curve[0].starting_balance
    peak = baseline
    max_dd = 0.0
    for p in curve:
        peak = max(peak, p.equity)
        if peak > 0:
            max_dd = max(max_dd, (peak - p.equity) / peak * 100.0)
    latest = curve[-1]
    return EquityStats(
        since=curve[0].day,
        baseline=baseline,
        latest_equity=latest.equity,
        return_pct=((latest.equity - baseline) / baseline * 100.0) if baseline > 0 else 0.0,
        peak_equity=peak,
        max_drawdown_pct=max_dd,
        days_tracked=(latest.day - curve[0].day).days + 1,
        points=len(curve),
    )


def to_point(row) -> EquityPoint:
    return EquityPoint(
        day=row.snapshot_date,
        starting_balance=float(row.starting_balance),
        balance=float(row.balance),
        unrealized_pnl=float(row.unrealized_pnl),
        equity=float(row.equity),
        is_reset_point=bool(row.is_reset_point),
    )


# --- recording ---------------------------------------------------------------------------------------


def today_in_equity_tz(now: datetime) -> date:
    return now.astimezone(ZoneInfo(settings.equity_history_timezone)).date()


def _upsert(
    db: Session, account, today: date, balance: float, unrealized: float, open_count: int, now: datetime, *, reset: bool = False
) -> None:
    row = db.query(db_models.AccountEquitySnapshot).filter_by(account_id=account.id, snapshot_date=today).first()
    if row is None:
        row = db_models.AccountEquitySnapshot(account_id=account.id, user_id=account.user_id, segment=account.segment, snapshot_date=today)
        db.add(row)
    row.starting_balance = float(account.starting_balance)
    row.balance = balance
    row.unrealized_pnl = unrealized
    row.equity = balance + unrealized
    row.open_positions = open_count
    row.taken_at = now
    if reset:
        row.is_reset_point = True  # sticky: a later tick the same day must not clear it
    elif row.is_reset_point is None:
        row.is_reset_point = False


def record_reset_point(db: Session, account, now: Optional[datetime] = None) -> None:
    """Called when an account is reset or re-baselined, BEFORE the caller
    commits (same transaction as the reset itself). Writes today's row as a
    reset marker at the account's post-reset balance with nothing unrealized.
    Platform accounts (no user_id) are not recorded."""
    if account.user_id is None:
        return
    now = now or datetime.now(timezone.utc)
    _upsert(db, account, today_in_equity_tz(now), float(account.current_balance), 0.0, 0, now, reset=True)


def record_equity_snapshots(db: Session, get_ltp_batch: Callable, now: Optional[datetime] = None) -> dict:
    """One pass over every user account (called by app/scheduler.py).

    All open positions are marked to market with a single batched quote fetch.
    An account with any open position whose quote is missing this tick is
    SKIPPED, not recorded with a partial (understated) unrealized figure; the
    next tick tries again. Otherwise today's row is inserted/updated. An
    account with nothing open, an unchanged balance and an unchanged baseline
    since its last row writes nothing (the curve is forward-filled)."""
    now = now or datetime.now(timezone.utc)
    today = today_in_equity_tz(now)
    accounts = db.query(db_models.Account).filter(db_models.Account.user_id.isnot(None)).all()
    open_positions = (
        db.query(db_models.Position).filter(db_models.Position.status == "OPEN", db_models.Position.user_id.isnot(None)).all()
    )
    by_account: dict[tuple[uuid.UUID, str], list] = defaultdict(list)
    for pos in open_positions:
        by_account[(pos.user_id, pos.segment)].append(pos)
    live = compute_unrealized_pnl(open_positions, get_ltp_batch) if open_positions else {}
    rates = _usdinr_rate_by_user(db, open_positions) if any(p.segment == "CRYPTO" for p in open_positions) else {}  # a crypto position's P&L is in dollars; the balance is rupees

    written = skipped_incomplete = unchanged = failed = 0
    for account in accounts:
        try:
            positions = by_account.get((account.user_id, account.segment), [])
            if any(p.id not in live for p in positions):
                skipped_incomplete += 1
                continue
            converted = [inr_of(p, live[p.id][1], rates.get(p.user_id)) for p in positions]
            if any(c is None for c in converted):  # a crypto position and no rate to value it at: skip rather than record dollars as rupees
                skipped_incomplete += 1
                continue
            unrealized = sum(converted)
            balance = float(account.current_balance)

            existing_today = (
                db.query(db_models.AccountEquitySnapshot).filter_by(account_id=account.id, snapshot_date=today).first()
            )
            if existing_today is None and not positions:
                last = (
                    db.query(db_models.AccountEquitySnapshot)
                    .filter(db_models.AccountEquitySnapshot.account_id == account.id, db_models.AccountEquitySnapshot.snapshot_date < today)
                    .order_by(db_models.AccountEquitySnapshot.snapshot_date.desc())
                    .first()
                )
                if (
                    last is not None
                    and float(last.balance) == balance
                    and float(last.unrealized_pnl) == 0.0
                    and float(last.starting_balance) == float(account.starting_balance)
                ):
                    unchanged += 1
                    continue
            _upsert(db, account, today, balance, unrealized, len(positions), now)
            db.commit()
            written += 1
        except Exception:
            failed += 1
            db.rollback()
            logger.exception("equity snapshot failed for account %s", account.id)
    return {"written": written, "skipped_incomplete": skipped_incomplete, "unchanged": unchanged, "failed": failed, "accounts": len(accounts)}
