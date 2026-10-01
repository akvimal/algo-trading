"""Builds the facts discipline v2 scores (app/domain/discipline_v2.py) from the database: a user's own closed manual trades for one
segment (single spot/future positions, and whole option groups) with their stop/target move logs."""

from datetime import date, datetime, timedelta
from typing import Callable, Optional

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.domain import discipline_v2 as dv2
from app.domain.performance import _f, _reviewed, day_key


def _event_fact(e: db_models.PositionEvent) -> dv2.EventFact:
    return dv2.EventFact(
        field=e.field, move=e.move, source=e.source, accepted=bool(e.accepted), created_at=e.created_at,
        tight_trail=e.tight_trail, old_price=_f(e.old_price), new_price=_f(e.new_price),
    )


def load_trade_facts(db: Session, user_id, segment: str, since: Optional[date] = None) -> list[dv2.TradeFacts]:
    P, G, E = db_models.Position, db_models.OptionPositionGroup, db_models.PositionEvent
    positions = (
        db.query(P)
        .filter(P.user_id == user_id, P.strategy_id.is_(None), P.status == "CLOSED", P.segment == segment, P.option_group_id.is_(None), P.exit_time.isnot(None))
        .all()
    )
    groups = (
        db.query(G)
        .filter(G.user_id == user_id, G.strategy_id.is_(None), G.status == "CLOSED", G.segment == segment, G.exit_time.isnot(None))
        .all()
    )
    pos_events: dict = {}
    group_events: dict = {}
    if positions or groups:
        rows = db.query(E).filter(E.user_id == user_id).order_by(E.created_at.asc()).all()
        for e in rows:
            if e.position_id is not None:
                pos_events.setdefault(e.position_id, []).append(_event_fact(e))
            if e.option_group_id is not None:
                group_events.setdefault(e.option_group_id, []).append(_event_fact(e))

    facts: list[dv2.TradeFacts] = []
    for p in positions:
        events = pos_events.get(p.id, [])
        stop_final, target_final = _f(p.stop_loss_price), _f(p.target_price)
        stop0, target0 = dv2.plan_at_entry(p.entry_time, stop_final, target_final, events)
        if p.initial_stop_loss_price is not None:
            stop0 = _f(p.initial_stop_loss_price)
        facts.append(
            dv2.TradeFacts(
                id=str(p.id), kind="position", segment=p.segment, symbol=p.symbol, action=p.action, entry_time=p.entry_time,
                exit_time=p.exit_time, exit_reason=p.exit_reason, order_type=p.order_type, entry_price=_f(p.entry_price),
                exit_price=_f(p.exit_price), quantity=_f(p.quantity), system_quantity=_f(p.system_quantity), stop0=stop0,
                target0=target0, stop_final=stop_final, target_final=target_final, pnl=_f(p.pnl), entry_setup_tag=p.entry_setup_tag,
                reviewed=_reviewed(p.reviewed_at, p.notes), auto_traded=bool(p.auto_traded), entry_interval=p.entry_interval, emotion_tag=p.emotion_tag, events=events,
            )
        )
    for g in groups:
        events = group_events.get(g.id, [])
        stop_final, target_final = _f(g.spot_stop_loss_price), _f(g.spot_target_price)
        stop0, target0 = dv2.plan_at_entry(g.created_at, stop_final, target_final, events)
        facts.append(
            dv2.TradeFacts(
                id=str(g.id), kind="group", segment=g.segment, symbol=g.underlying_symbol, action=g.action, entry_time=g.created_at,
                exit_time=g.exit_time, exit_reason=g.exit_reason, order_type=g.order_type, entry_price=_f(g.entry_spot_price),
                exit_price=None, quantity=_f(g.quantity), system_quantity=_f(g.system_quantity), stop0=stop0, target0=target0,
                stop_final=stop_final, target_final=target_final, pnl=_f(g.pnl), entry_setup_tag=g.entry_setup_tag,
                reviewed=_reviewed(g.reviewed_at, g.notes), auto_traded=bool(g.auto_traded), entry_interval=g.entry_interval, emotion_tag=g.emotion_tag, events=events,
            )
        )
    if since is not None:
        facts = [f for f in facts if day_key(f.exit_time) >= since]
    return facts


CandleFetch = Callable[[str, str, str, date, date], list]


def attach_what_ifs(scores: list[dv2.TradeScore], fetch: CandleFetch, limit: int = 5) -> dict[str, dict]:
    """For the most recent trades that were closed early (a tight trail or a manual exit), how much further price went in the
    trade's favour that day. Spot/future positions only (an option group has no price of its own to follow). Best effort: a
    market-data failure just leaves that trade without one."""
    wanted = [s for s in reversed(sorted(scores, key=lambda s: s.facts.exit_time)) if s.exit_kind in ("tight_trail", "early_exit") and s.facts.kind == "position"]
    out: dict[str, dict] = {}
    for s in wanted[:limit]:
        t = s.facts
        risk = abs(t.entry_price - t.stop0) if t.entry_price is not None and t.stop0 is not None else None
        day = t.exit_time.date()
        try:
            candles = fetch(t.segment, t.symbol, t.entry_interval or "5min", day, day + timedelta(days=1))
        except Exception:
            continue
        result = dv2.what_if_after_exit(t, risk, candles)
        if result is not None:
            out[t.id] = result
    return out
