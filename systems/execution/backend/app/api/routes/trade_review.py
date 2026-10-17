"""GET /trade-review/taxonomy and GET /trade-review/{kind}/{id}/suggestions - the post-trade review by cause (app/domain/trade_review.py).
Saving the person's confirmed tags goes through the existing PUT /positions/{id}/tags and /option-groups/{id}/tags."""

import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.auth import User, get_current_user
from app.domain import discipline_v2 as dv2
from app.domain import on_plan as op
from app.domain import session_grid as sg
from app.domain import trade_review as tr
from app.domain.discipline_load import load_trade_facts
from app.domain.performance import day_key, epoch_start

router = APIRouter()


@router.get("/trade-review/taxonomy")
def taxonomy():
    """The three levels in order, each with its tags (slug and label)."""
    return {"levels": [{"level": lv, "tags": [{"tag": t, "label": label} for t, label in tr.TAXONOMY[lv].items()]} for lv in tr.LEVELS]}


@router.get("/trade-review/{kind}/{trade_id}/suggestions")
def suggestions(kind: Literal["position", "group"], trade_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The mistake tags the data supports for one closed manual trade, each with why. Empty (available=false) for a trade the discipline checks
    do not cover (an open one, an auto-traded fill, a multi-day hold)."""
    try:
        parsed = uuid.UUID(trade_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="trade not found")
    model = db_models.Position if kind == "position" else db_models.OptionPositionGroup
    row = db.get(model, parsed)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="trade not found")
    none = {"available": False, "tags": [], "root_cause": None, "had_context": bool(row.entry_context)}
    if row.status != "CLOSED":
        return none
    account = db.query(db_models.Account).filter_by(user_id=user.id, segment=row.segment, book="intraday").first()
    cfg = dv2.DisciplineConfig.from_settings(
        min_rr=float(account.min_reward_risk_ratio) if account is not None else 2.0,
        daily_loss_limit=float(account.max_daily_loss) if account is not None and account.max_daily_loss is not None else None,
    )
    scores = dv2.evaluate_all(load_trade_facts(db, user.id, row.segment, None), cfg)
    mine = next((s for s in scores if s.facts.id == str(parsed) and not s.facts.auto_traded), None)
    if mine is None:
        return none
    verdict = tr.override_verdict(mine.facts.entry_context, mine.facts.stop0, mine.facts.target0, mine.planned_rr, mine.exit_r, mine.facts.pnl, cfg.min_rr)
    return {"available": True, **tr.suggest(mine.facts.action, mine.mistakes, mine.facts.entry_context, verdict)}


@router.get("/trade-review/on-plan")
def on_plan(days: int = 90, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The ids of the caller's recent closed manual trades that went to plan (a stop and a target at order time, reward-to-risk at the minimum, no
    mistake found) and have no review of their own: they need none, so they are not counted as waiting. Every market together."""
    days = max(1, min(days, 365))
    return {"ids": sorted(op.on_plan_for_user(db, user.id, date.today() - timedelta(days=days)))}


@router.get("/trade-review/summary/{segment}")
def summary(segment: str, scope: Literal["epoch", "all"] = "epoch", user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """What the reviewed trades cost, by level and by tag, for the caller's closed manual trades in one segment; plus how many still wait for a
    review. Auto-traded fills are left out, as they are in the discipline score."""
    seg = segment.upper()
    if seg not in ("NSE", "MCX", "CRYPTO"):
        raise HTTPException(status_code=404, detail=f"unknown segment {segment}")
    account = db.query(db_models.Account).filter_by(user_id=user.id, segment=seg, book="intraday").first()
    since = epoch_start(db, account) if (scope == "epoch" and account is not None) else None
    facts = [f for f in load_trade_facts(db, user.id, seg, since) if not f.auto_traded]
    if facts:  # a trade that went to plan counts as a clean review
        cfg = op.segment_config(db, user.id, seg)
        facts = op.cleared(facts, op.on_plan_ids(dv2.evaluate_all(facts, cfg), cfg))
    out = tr.summarize([{"exit_time": f.exit_time, "pnl": f.pnl, "root_cause": f.root_cause, "tags": f.mistake_tags} for f in facts])
    return {"segment": seg, "scope": scope, **out}


@router.get("/trade-review/sessions")
def sessions(limit: int = 10, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The last `limit` trading sessions as two grids (app/domain/session_grid.py): the person's own trades judged on Study / Plan / Trade from their reviews,
    and the bots' trades judged on result, wins and a clean run. Every market together; a session with no closed trade is skipped. `overrides` counts, over the
    sessions shown, how often the person overrode the system's read of the market and how often that paid off."""
    limit = max(1, min(limit, 30))
    since = date.today() - timedelta(days=75)  # ten sessions fit comfortably; older history is not read
    facts: list = []
    verdicts: dict = {}
    for seg in ("NSE", "MCX", "CRYPTO"):
        seg_facts = load_trade_facts(db, user.id, seg, since)
        if not seg_facts:
            continue
        cfg = op.segment_config(db, user.id, seg)
        scores = dv2.evaluate_all(seg_facts, cfg)
        facts += op.cleared(seg_facts, op.on_plan_ids(scores, cfg))  # a trade that went to plan counts as a clean review
        if any((f.entry_context or {}).get("overridden") for f in seg_facts):
            for s in scores:
                if not s.facts.auto_traded:
                    verdicts[s.facts.id] = tr.override_verdict(s.facts.entry_context, s.facts.stop0, s.facts.target0, s.planned_rr, s.exit_r, s.facts.pnl, cfg.min_rr)
    D = db_models.SpreadBotDecision
    failed: dict = {}
    for d in db.query(D).filter(D.user_id == user.id, D.outcome == "failed", D.decided_at >= datetime.combine(since, datetime.min.time(), tzinfo=timezone.utc)).all():
        failed[day_key(d.decided_at)] = failed.get(day_key(d.decided_at), 0) + 1
    manual = sg.manual_sessions([f for f in facts if not f.auto_traded], limit, verdicts)
    return {
        "manual": manual,
        "bot": sg.bot_sessions([f for f in facts if f.auto_traded], failed, limit),
        "overrides": {"total": sum(m["overrides"] for m in manual), "paid_off": sum(m["paid_off"] for m in manual)},
    }
