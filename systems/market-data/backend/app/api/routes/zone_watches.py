"""Zones and levels armed on a chart, watched by the server (app/domain/zone_watch.py).

The chart keeps the drawings in the browser; whenever the armed ones change it sends the full set for that instrument here
(PUT /zone-watches/{exchange}/{symbol}), and the server watches them. Every route needs a signed-in user: a watch spends the platform's
market-data quota and sends a message to the owner's own Telegram chat, and one person's zones must never reach another's chat."""

import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.adapters.db.models import ZoneEvent, ZoneWatch
from app.adapters.db.session import get_db
from app.auth import User, require_user
from app.domain import zone_watch as zw

router = APIRouter()


class WatchIn(BaseModel):
    kind: str
    lo: float
    hi: float


class SyncIn(BaseModel):
    interval: str = zw.DEFAULT_INTERVAL
    watches: list[WatchIn] = []


class WatchOut(BaseModel):
    id: str
    exchange: str
    symbol: str
    kind: str
    lo: float
    hi: float
    role: Optional[str]
    interval: str
    last_state: Optional[str]


class EventOut(BaseModel):
    symbol: str
    exchange: str
    kind: str
    lo: float
    hi: float
    role: Optional[str]
    event: str
    at: datetime
    extreme: Optional[float]
    close: Optional[float]


class WatchListOut(BaseModel):
    watches: list[WatchOut]
    events: list[EventOut]


def _out(w: ZoneWatch) -> WatchOut:
    return WatchOut(id=str(w.id), exchange=w.exchange, symbol=w.symbol, kind=w.kind, lo=float(w.lo), hi=float(w.hi), role=w.role, interval=w.interval, last_state=w.last_state)


@router.put("/zone-watches/{exchange}/{symbol}", response_model=list[WatchOut])
def sync(exchange: str, symbol: str, payload: SyncIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Make the server's watches for this instrument exactly the ones sent (an empty list clears them)."""
    try:
        specs = zw.clean_specs([w.model_dump() for w in payload.watches])
        rows = zw.sync_watches(db, user.user_id, exchange.upper(), symbol, specs, payload.interval)
    except zw.ZoneWatchError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)
    return [_out(w) for w in rows]


@router.get("/zone-watches", response_model=WatchListOut)
def list_watches(user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Every zone and level this person has armed, and the last few things that happened to them."""
    watches = db.query(ZoneWatch).filter(ZoneWatch.user_id == user.user_id).order_by(ZoneWatch.exchange, ZoneWatch.symbol, ZoneWatch.lo).all()
    events = db.query(ZoneEvent).filter(ZoneEvent.user_id == user.user_id).order_by(ZoneEvent.at.desc()).limit(20).all()
    return WatchListOut(
        watches=[_out(w) for w in watches],
        events=[
            EventOut(symbol=e.symbol, exchange=e.exchange, kind=e.kind, lo=float(e.lo), hi=float(e.hi), role=e.role, event=e.event, at=e.at,
                     extreme=float(e.extreme) if e.extreme is not None else None, close=float(e.close) if e.close is not None else None)
            for e in events
        ],
    )


@router.delete("/zone-watches/{watch_id}", status_code=204)
def remove(watch_id: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    try:
        row = db.get(ZoneWatch, uuid.UUID(watch_id))
    except ValueError:
        raise HTTPException(status_code=404, detail="No such zone.")
    if row is None or row.user_id != user.user_id:
        raise HTTPException(status_code=404, detail="No such zone.")  # someone else's is the same answer as none
    db.delete(row)
    db.commit()
