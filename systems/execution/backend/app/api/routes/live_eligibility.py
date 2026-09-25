"""GET /live-eligibility/{segment} - the caller's progress toward being allowed
to turn live trading on: each paper track-record requirement with its required
and actual value (app/domain/track_record.py). Informational unless
REQUIRE_PAPER_TRACK_RECORD is on, which the `enforced` flag reports."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.auth import User, get_current_user
from app.config import settings
from app.domain.live_gate import LIVE_SEGMENTS
from app.domain.models import LiveEligibilityOut, RequirementOut
from app.domain.track_record import Requirement, Thresholds, evaluate, evaluate_for_account

router = APIRouter()

_SEGMENTS = ("NSE", "MCX", "CRYPTO")


@router.get("/live-eligibility/{segment}", response_model=LiveEligibilityOut)
def get_live_eligibility(segment: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    seg = segment.upper()
    if seg not in _SEGMENTS:
        raise HTTPException(status_code=404, detail=f"unknown segment {segment}")
    if seg not in LIVE_SEGMENTS:
        requirements = [Requirement("segment", "Live trading available", " or ".join(LIVE_SEGMENTS), seg, False)]
    else:
        account = db.query(db_models.Account).filter_by(user_id=user.id, segment=seg).first()
        if account is None:
            # Nothing traded yet: every requirement is unmet at zero.
            requirements = evaluate(
                Thresholds.from_settings(), apply_charges=False, slippage_bps=0.0, qualifying_trades=0, days_tracked=0,
                discipline_score=None, max_drawdown_pct=None, net_pnl=None,
            )
        else:
            requirements = evaluate_for_account(db, user.id, account)
    return LiveEligibilityOut(
        segment=seg,
        enforced=settings.require_paper_track_record,
        eligible=all(r.met for r in requirements),
        requirements=[RequirementOut(key=r.key, label=r.label, required=r.required, actual=r.actual, met=r.met) for r in requirements],
    )
