"""The intraday credit-spread bot: GET/PUT /spread-bot/settings and GET /spread-bot/decisions. See app/domain/spread_bot.py. Paper only."""

from datetime import time as dt_time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.auth import User, get_current_user
from app.domain.position_manager import load_account

router = APIRouter()

_ALLOWED_SYMBOLS = {"NIFTY", "BANKNIFTY"}


class SpreadBotSettingsOut(BaseModel):
    enabled: bool = False
    risk_pct: float = 1.0
    symbols: list[str] = ["NIFTY", "BANKNIFTY"]
    entry_from: str = "09:45"
    entry_to: str = "13:30"
    min_votes: int = 3
    width_strikes: int = 2
    max_trades_per_day: int = 2


class SpreadBotSettingsUpdate(BaseModel):
    enabled: Optional[bool] = None
    risk_pct: Optional[float] = Field(default=None, gt=0, le=5)
    symbols: Optional[list[str]] = None
    entry_from: Optional[str] = None
    entry_to: Optional[str] = None
    min_votes: Optional[int] = Field(default=None, ge=2, le=4)
    width_strikes: Optional[int] = Field(default=None, ge=1, le=10)
    max_trades_per_day: Optional[int] = Field(default=None, ge=1, le=10)

    @field_validator("symbols")
    @classmethod
    def _symbols(cls, v):
        if v is None:
            return v
        cleaned = [s.strip().upper() for s in v if s.strip()]
        if not cleaned or any(s not in _ALLOWED_SYMBOLS for s in cleaned):
            raise ValueError("symbols must be NIFTY and/or BANKNIFTY")
        return list(dict.fromkeys(cleaned))


class SpreadBotDecisionOut(BaseModel):
    id: int
    symbol: str
    decided_at: str
    outcome: str
    reason: str
    votes: Optional[dict] = None
    detail: Optional[dict] = None
    group_id: Optional[str] = None


def _hhmm(t: dt_time) -> str:
    return t.strftime("%H:%M")


def _parse(value: str, label: str) -> dt_time:
    try:
        h, m = value.split(":")
        return dt_time(int(h), int(m))
    except Exception:
        raise HTTPException(status_code=422, detail=f"{label} must be a time like 09:45")


def _out(row: Optional[db_models.SpreadBotSettings]) -> SpreadBotSettingsOut:
    if row is None:
        return SpreadBotSettingsOut()
    return SpreadBotSettingsOut(
        enabled=bool(row.enabled), risk_pct=float(row.risk_pct), symbols=[s for s in row.symbols.split(",") if s], entry_from=_hhmm(row.entry_from),
        entry_to=_hhmm(row.entry_to), min_votes=row.min_votes, width_strikes=row.width_strikes, max_trades_per_day=row.max_trades_per_day,
    )


@router.get("/spread-bot/settings", response_model=SpreadBotSettingsOut)
def get_settings(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _out(db.get(db_models.SpreadBotSettings, user.id))


@router.put("/spread-bot/settings", response_model=SpreadBotSettingsOut)
def put_settings(payload: SpreadBotSettingsUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if payload.enabled:
        account = load_account(db, user.id, "NSE")
        if account is not None and account.live_trading_enabled:
            raise HTTPException(status_code=409, detail="The bot is paper only, and your NSE account is set to live trading. Switch it back to paper first.")
    row = db.get(db_models.SpreadBotSettings, user.id)
    if row is None:
        row = db_models.SpreadBotSettings(user_id=user.id, enabled=False, risk_pct=1, symbols="NIFTY,BANKNIFTY", entry_from=dt_time(9, 45), entry_to=dt_time(13, 30), min_votes=3, width_strikes=2, max_trades_per_day=2)
        db.add(row)
    if payload.enabled is not None:
        row.enabled = payload.enabled
    if payload.risk_pct is not None:
        row.risk_pct = payload.risk_pct
    if payload.symbols is not None:
        row.symbols = ",".join(payload.symbols)
    if payload.entry_from is not None:
        row.entry_from = _parse(payload.entry_from, "entry_from")
    if payload.entry_to is not None:
        row.entry_to = _parse(payload.entry_to, "entry_to")
    if row.entry_from >= row.entry_to:
        raise HTTPException(status_code=422, detail="the entry window must end after it starts")
    if payload.min_votes is not None:
        row.min_votes = payload.min_votes
    if payload.width_strikes is not None:
        row.width_strikes = payload.width_strikes
    if payload.max_trades_per_day is not None:
        row.max_trades_per_day = payload.max_trades_per_day
    db.commit()
    return _out(row)


@router.get("/spread-bot/decisions", response_model=list[SpreadBotDecisionOut])
def list_decisions(limit: int = Query(default=100, ge=1, le=500), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    D = db_models.SpreadBotDecision
    rows = db.query(D).filter(D.user_id == user.id).order_by(D.decided_at.desc()).limit(limit).all()
    return [
        SpreadBotDecisionOut(
            id=r.id, symbol=r.symbol, decided_at=r.decided_at.isoformat(), outcome=r.outcome, reason=r.reason, votes=r.votes, detail=r.detail,
            group_id=str(r.group_id) if r.group_id else None,
        )
        for r in rows
    ]
