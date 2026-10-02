"""The custom equity screener - saved, per-user screens (CRUD, require_
user_id: never anonymous, decided with the user - unlike PriceAlert's
generous own+anonymous visibility) plus running one (saved, by id, or an
ad-hoc preview before saving) against the latest EOD universe. See
app/domain/screener_expr.py for the expression grammar and
app/domain/custom_screens.py for the pure evaluation core this route
feeds - the actual DB reads (the base-universe filter against
equity_screener_snapshot's latest date, the batch equity_daily_bar fetch)
live here, same "pure core, thin route" split every other domain module
in this service uses."""

import time
import uuid
from datetime import date, timedelta
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.adapters.db.models import CustomScreen, EquityDailyBar, EquityScreenerSnapshot
from app.adapters.db.session import get_db
from app.api.routes.candles import fetch_candle_history_cached
from app.auth import Caller, get_caller, require_user_id
from app.data_access import data_credentials
from app.domain.custom_screens import ScreenCandidate, matches_universe_filters, run_screen
from app.domain.models import Candle, CustomScreenCreate, CustomScreenMatchOut, CustomScreenOut, CustomScreenRunResult
from app.domain.screener_expr import ExpressionError, IntradayUnavailable, parse_expression
from app.providers.router import get_provider

router = APIRouter()

# Intraday bars are not stored for the universe: they are fetched from the exchange feed, one call per stock per interval, paced by the
# provider (about two a second). A run is therefore capped: at most this many stocks are fetched, in at most this long, and a feed that
# fails this many times in a row is given up on for the rest of the run (an expired token fails them all the same way).
INTRADAY_STOCK_LIMIT = 120
INTRADAY_SECONDS_LIMIT = 55.0
INTRADAY_FAILURES_BEFORE_GIVING_UP = 4
# Days of history to ask for, per interval: enough bars for an ema(20) or a rolling window, not more than a call needs.
_INTRADAY_DAYS = {"5min": 5, "15min": 10, "30min": 20, "60min": 40}


class _IntradayFeed:
    """Fetches a candidate's intraday bars for one run, inside the run's limits. The cached history fetch is the one the charts use, so a
    stock someone just charted costs nothing, and a repeated run is cheap too."""

    def __init__(self, caller: Caller):
        self.provider = get_provider("NSE")
        self.credentials = data_credentials(caller, "NSE")
        self.started = time.monotonic()
        self.stocks: set[str] = set()
        self.failures = 0
        self.last_error: Optional[str] = None
        self.hit_limit = False

    def __call__(self, candidate: ScreenCandidate, interval: str):
        if candidate.symbol not in self.stocks:
            if self.failures >= INTRADAY_FAILURES_BEFORE_GIVING_UP:
                raise IntradayUnavailable(self.last_error or "the data feed is not responding")
            if len(self.stocks) >= INTRADAY_STOCK_LIMIT or time.monotonic() - self.started > INTRADAY_SECONDS_LIMIT:
                self.hit_limit = True
                raise IntradayUnavailable("limit")
            self.stocks.add(candidate.symbol)
        today = date.today()
        try:
            candles = fetch_candle_history_cached(
                self.provider, candidate.exchange, candidate.symbol, interval, today - timedelta(days=_INTRADAY_DAYS.get(interval, 10)), today, self.credentials
            )
        except (ValueError, RuntimeError) as exc:
            self.failures += 1
            self.last_error = str(exc)
            raise IntradayUnavailable(str(exc)) from exc
        self.failures = 0
        return candles

    def note(self, skipped: int, candidates: int) -> Optional[str]:
        if skipped == 0:
            return None
        if self.hit_limit:
            return (
                f"{skipped} of {candidates} stocks were not checked: intraday bars are fetched live, so a run covers at most "
                f"{INTRADAY_STOCK_LIMIT} stocks. Narrow the universe (F&O, an index), or put the daily conditions first so fewer stocks need intraday data."
            )
        return f"{skipped} of {candidates} stocks were not checked: the intraday data feed said \"{self.last_error}\"."


@router.get("/custom-screens", response_model=list[CustomScreenOut])
def list_custom_screens(user_id: UUID = Depends(require_user_id), db: Session = Depends(get_db)):
    return db.query(CustomScreen).filter(CustomScreen.user_id == user_id).order_by(CustomScreen.created_at.desc()).all()


@router.post("/custom-screens", response_model=CustomScreenOut, status_code=201)
def create_custom_screen(payload: CustomScreenCreate, user_id: UUID = Depends(require_user_id), db: Session = Depends(get_db)):
    _validate_expression(payload.expression)
    row = CustomScreen(user_id=user_id, **payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/custom-screens/{screen_id}", response_model=CustomScreenOut)
def update_custom_screen(screen_id: str, payload: CustomScreenCreate, user_id: UUID = Depends(require_user_id), db: Session = Depends(get_db)):
    _validate_expression(payload.expression)
    row = _owned_or_404(db, screen_id, user_id)
    for field, value in payload.model_dump().items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/custom-screens/{screen_id}", status_code=204)
def delete_custom_screen(screen_id: str, user_id: UUID = Depends(require_user_id), db: Session = Depends(get_db)):
    row = _owned_or_404(db, screen_id, user_id)
    db.delete(row)
    db.commit()


@router.get("/custom-screens/{screen_id}/run", response_model=CustomScreenRunResult)
def run_saved_screen(screen_id: str, user_id: UUID = Depends(require_user_id), caller: Caller = Depends(get_caller), db: Session = Depends(get_db)):
    row = _owned_or_404(db, screen_id, user_id)
    return _run(db, row.expression, row.is_fno, row.index_membership, row.min_price, row.max_price, caller)


@router.post("/custom-screens/preview", response_model=CustomScreenRunResult)
def preview_custom_screen(payload: CustomScreenCreate, caller: Caller = Depends(get_caller), db: Session = Depends(get_db)):
    """Runs `payload` without saving it - for trying a condition out before
    committing to it. No auth dependency: unlike the saved-screen CRUD
    above, there is nothing here that belongs to anyone yet."""
    _validate_expression(payload.expression)
    return _run(db, payload.expression, payload.is_fno, payload.index_membership, payload.min_price, payload.max_price, caller)


def _validate_expression(expression: str) -> None:
    try:
        parse_expression(expression)
    except ExpressionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _owned_or_404(db: Session, screen_id: str, user_id: UUID) -> CustomScreen:
    try:
        parsed = uuid.UUID(screen_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="screen not found")
    row = db.query(CustomScreen).filter(CustomScreen.id == parsed, CustomScreen.user_id == user_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="screen not found")
    return row


def _run(
    db: Session, expression: str, is_fno: Optional[bool], index_membership: Optional[str], min_price: Optional[float], max_price: Optional[float],
    caller: Optional[Caller] = None,
) -> CustomScreenRunResult:
    latest_date: Optional[date] = db.query(func.max(EquityScreenerSnapshot.snapshot_date)).scalar()
    if latest_date is None:
        return CustomScreenRunResult(snapshot_date=None, candidates=0, matches=[])

    snapshot_rows = db.query(EquityScreenerSnapshot).filter(EquityScreenerSnapshot.snapshot_date == latest_date).all()
    candidate_rows = [
        r for r in snapshot_rows
        if matches_universe_filters(r.is_fno, r.index_memberships, r.close, is_fno, index_membership, min_price, max_price)
    ]
    if not candidate_rows:
        return CustomScreenRunResult(snapshot_date=latest_date, candidates=0, matches=[])

    symbols = [r.symbol for r in candidate_rows]
    bar_rows = (
        db.query(EquityDailyBar)
        .filter(EquityDailyBar.symbol.in_(symbols))
        .order_by(EquityDailyBar.symbol.asc(), EquityDailyBar.bar_date.asc())
        .all()
    )
    bars_by_symbol: dict[str, list[Candle]] = {}
    for b in bar_rows:
        bars_by_symbol.setdefault(b.symbol, []).append(
            Candle(exchange=b.exchange, symbol=b.symbol, interval="daily", open=b.open, high=b.high, low=b.low, close=b.close, volume=b.volume, timestamp=f"{b.bar_date.isoformat()}T00:00:00", provider="cache")
        )

    candidates = [
        ScreenCandidate(symbol=r.symbol, exchange=r.exchange, close=r.close, bars=bars_by_symbol.get(r.symbol, []))
        for r in candidate_rows
    ]
    feed = _IntradayFeed(caller) if caller is not None else None
    try:
        run = run_screen(expression, candidates, intraday=feed)
    except ExpressionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return CustomScreenRunResult(
        snapshot_date=latest_date, candidates=len(candidates),
        matches=[CustomScreenMatchOut(symbol=m.symbol, exchange=m.exchange, close=m.close) for m in run.matches],
        intraday_skipped=run.skipped,
        intraday_note=feed.note(run.skipped, len(candidates)) if feed is not None else None,
    )
