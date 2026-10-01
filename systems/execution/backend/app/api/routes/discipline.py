"""GET /discipline/{segment} - the caller's discipline v2 score (app/domain/discipline_v2.py): a behaviour score over their last 20
closed manual trades, split into greed, fear and patience, with the mistakes that cost the most, a one-line weekly coaching
sentence, and (best effort) what price did after their most recent early exits. Scope 'epoch' (default) counts only trades
since the latest equity reset; 'all' counts every trade."""

import functools
from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.adapters.quotes.client import get_candle_history
from app.auth import User, get_current_user
from app.domain import credentials as cred
from app.domain import discipline_v2 as dv2
from app.domain.discipline_load import attach_what_ifs, load_trade_facts
from app.domain.models import CredentialOut, DisciplineCheckOut, DisciplineCoachingOut, DisciplineTradeOut, DisciplineV2Out, WhatIfOut
from app.domain.performance import epoch_start

router = APIRouter()

_SEGMENTS = ("NSE", "MCX", "CRYPTO")


@router.get("/discipline/{segment}", response_model=DisciplineV2Out)
def get_discipline(
    segment: str,
    scope: Literal["epoch", "all"] = "epoch",
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    seg = segment.upper()
    if seg not in _SEGMENTS:
        raise HTTPException(status_code=404, detail=f"unknown segment {segment}")
    account = db.query(db_models.Account).filter_by(user_id=user.id, segment=seg).first()
    since = epoch_start(db, account) if (scope == "epoch" and account is not None) else None
    facts = load_trade_facts(db, user.id, seg, since)

    cfg = dv2.DisciplineConfig.from_settings(
        min_rr=float(account.min_reward_risk_ratio) if account is not None else 2.0,
        daily_loss_limit=float(account.max_daily_loss) if account is not None and account.max_daily_loss is not None else None,
    )
    scores = dv2.evaluate_all(facts, cfg)
    summary = dv2.summarize(scores)

    recent = sorted((s for s in scores if not s.facts.auto_traded), key=lambda s: s.facts.exit_time)[-dv2.WINDOW_TRADES:]
    fetch = functools.partial(get_candle_history, token=user.token)
    what_ifs = attach_what_ifs(recent, fetch)

    trades = [
        DisciplineTradeOut(
            id=s.facts.id, kind=s.facts.kind, symbol=s.facts.symbol, action=s.facts.action, exit_time=s.facts.exit_time,
            exit_reason=s.facts.exit_reason, exit_kind=s.exit_kind, planned_rr=s.planned_rr, exit_r=s.exit_r, score=s.score,
            pnl=s.facts.pnl, mistakes=s.mistakes, flags=s.flags,
            checks=[DisciplineCheckOut(key=c.key, category=c.category, emotion=c.emotion, score=c.score, mistake=c.mistake) for c in s.checks],
            what_if=WhatIfOut(**what_ifs[s.facts.id]) if s.facts.id in what_ifs else None,
            emotion_tag=s.facts.emotion_tag, needs_emotion=s.needs_emotion,
        )
        for s in reversed(recent)
    ]
    return DisciplineV2Out(
        segment=seg, scope=scope, score=summary["score"], trade_count=summary["trade_count"], emotions=summary["emotions"],
        categories=summary["categories"], mistakes=summary["mistakes"], week_mistakes=summary["week_mistakes"],
        target_and_stop_moved=summary["target_and_stop_moved"], emotion_counts=summary["emotion_counts"], needs_emotion=summary["needs_emotion"],
        coaching=DisciplineCoachingOut(**summary["coaching"]) if summary["coaching"] else None, trades=trades,
        credentials=[CredentialOut(**asdict(c)) for c in cred.evaluate(scores, cfg.daily_loss_limit, cfg.timezone)],
    )
