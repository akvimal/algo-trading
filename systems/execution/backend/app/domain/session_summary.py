"""One user's trading for one day, for the post-session Telegram summary (market-data builds the message; this only supplies the numbers,
over the internal service route). The same trades the performance page counts: the person's own MANUAL trades (not the auto-trader's), net
of charges and slippage where the account applied them, with paper and live kept apart."""

from dataclasses import dataclass
from datetime import date
from typing import Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.domain.performance import TradeRecord, _has_plan, _realized_r, compute_discipline, day_key, load_manual_trades


@dataclass
class ModeDay:
    trades: int
    wins: int
    losses: int
    net_pnl: float
    charges: float
    with_plan: int  # trades that were a limit order with a stop
    best: Optional[dict]
    worst: Optional[dict]


def _leg(t: TradeRecord) -> dict:
    r = _realized_r(t)
    return {"symbol": t.symbol, "pnl": t.pnl, "r": round(r, 2) if r is not None else None, "exit_reason": t.exit_reason}


def _mode_day(trades: list[TradeRecord]) -> Optional[ModeDay]:
    counted = [t for t in trades if t.pnl is not None]
    if not counted:
        return None
    return ModeDay(
        trades=len(counted),
        wins=sum(1 for t in counted if t.pnl > 0),
        losses=sum(1 for t in counted if t.pnl < 0),
        net_pnl=sum(t.pnl for t in counted),
        charges=sum(t.charges for t in counted),
        with_plan=sum(1 for t in counted if _has_plan(t)),
        best=_leg(max(counted, key=lambda t: t.pnl)),
        worst=_leg(min(counted, key=lambda t: t.pnl)),
    )


def open_now(db: Session, user_id: UUID, segment: str) -> int:
    """Manual positions (single, and whole spreads) still open."""
    P, G = db_models.Position, db_models.OptionPositionGroup
    singles = db.query(P).filter(P.user_id == user_id, P.strategy_id.is_(None), P.status == "OPEN", P.segment == segment, P.option_group_id.is_(None)).count()
    groups = db.query(G).filter(G.user_id == user_id, G.strategy_id.is_(None), G.status == "OPEN", G.segment == segment).count()
    return singles + groups


def trader_day(db: Session, user_id: UUID, segment: str, day: date) -> dict:
    """The day's closed trades split into paper and live, what is still open, and the 30-day discipline score. `day` is an IST date."""
    everything = load_manual_trades(db, user_id, segment)
    manual = [t for t in everything if not t.auto_traded]
    today = [t for t in manual if day_key(t.exit_time) == day]
    out = {}
    for mode, flag in (("paper", False), ("live", True)):
        d = _mode_day([t for t in today if t.live is flag])
        out[mode] = d.__dict__ if d else None
    score = compute_discipline(everything, 30).get("score")
    return {"segment": segment, "day": day.isoformat(), **out, "open_now": open_now(db, user_id, segment), "discipline_score": score}
