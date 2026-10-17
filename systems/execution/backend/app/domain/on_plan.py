"""Which closed manual trades went to plan and so need no review (app/domain/trade_review.py's `on_plan`), found from the database.

A trade the person has already reviewed keeps their verdict; this only speaks for trades with none. Computed when asked, never stored: change the
minimum reward-to-risk and the answer changes with it."""

from dataclasses import replace
from datetime import date
from typing import Optional

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.domain import discipline_v2 as dv2
from app.domain import trade_review as tr
from app.domain.discipline_load import load_trade_facts

SEGMENTS = ("NSE", "MCX", "CRYPTO")


def segment_config(db: Session, user_id, segment: str) -> dv2.DisciplineConfig:
    account = db.query(db_models.Account).filter_by(user_id=user_id, segment=segment, book="intraday").first()
    return dv2.DisciplineConfig.from_settings(
        min_rr=float(account.min_reward_risk_ratio) if account is not None else 2.0,
        daily_loss_limit=float(account.max_daily_loss) if account is not None and account.max_daily_loss is not None else None,
    )


def on_plan_ids(scores: list[dv2.TradeScore], cfg: dv2.DisciplineConfig) -> set[str]:
    """The ids of the person's own trades, with no review of their own, that went to plan."""
    return {
        s.facts.id for s in scores
        if not s.facts.auto_traded and not s.facts.root_cause and tr.on_plan(s.mistakes, s.facts.stop0, s.facts.target0, s.planned_rr, cfg.min_rr)
    }


def cleared(facts: list[dv2.TradeFacts], ids: set[str]) -> list[dv2.TradeFacts]:
    """The facts with each on-plan trade counted as a clean review, for the totals and the grid."""
    return [replace(f, root_cause="clean", mistake_tags=[]) if f.id in ids else f for f in facts]


def on_plan_for_user(db: Session, user_id, since: Optional[date] = None, segments=SEGMENTS) -> set[str]:
    out: set[str] = set()
    for seg in segments:
        facts = load_trade_facts(db, user_id, seg, since)
        if not facts:
            continue
        cfg = segment_config(db, user_id, seg)
        out |= on_plan_ids(dv2.evaluate_all(facts, cfg), cfg)
    return out
