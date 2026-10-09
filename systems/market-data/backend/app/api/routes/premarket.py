"""GET /premarket, POST /premarket/refresh - the morning pre-market bias (US close, crude, USDINR, yields, ADRs and the
GIFT Nifty gap, scored by rules and read by an AI model). See app/domain/premarket_report.py.

The report is one shared row per day, written by the 08:45 IST job (app/scheduler.py) on the platform OpenRouter key.
A manual refresh re-runs it on the caller's own key (or the platform's), the same BYO-key pattern as /ai-read."""

import threading
import time
from datetime import date
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.adapters import accounts_client
from app.adapters.db.models import PremarketReport
from app.adapters.db.session import get_db
from app.auth import require_user_id
from app.config import settings
from app.domain.models import PremarketReportOut
from app.domain.premarket_report import build_report, get_report, save_report, today_ist

router = APIRouter()

# A refresh hits two public data sources and a paid model call, so back-to-back clicks are collapsed.
_REFRESH_MIN_GAP_SECONDS = 30
_refresh_lock = threading.Lock()
_last_refresh = 0.0


def report_out(row: PremarketReport) -> PremarketReportOut:
    return PremarketReportOut(
        day=row.day, generated_at=row.generated_at, bias=row.bias, agree=row.agree, model=row.model,
        ai_error=row.ai_error, inputs=row.inputs, rules=row.rules, ai=row.ai, macro=row.macro,
    )


@router.get("/premarket", response_model=PremarketReportOut)
def get_premarket(day: Optional[date] = None, db: Session = Depends(get_db)):
    """That day's report; with no `day`, today's if it exists, else the most recent one (so the card is never empty
    on a weekend or before the first run of the morning)."""
    row = get_report(db, day)
    if row is None:
        raise HTTPException(status_code=404, detail="no pre-market report for that day yet")
    return report_out(row)


@router.post("/premarket/refresh", response_model=PremarketReportOut)
def refresh_premarket(db: Session = Depends(get_db), user_id: UUID = Depends(require_user_id)):
    """Re-run today's report now (e.g. to pick up GIFT Nifty closer to the open) and replace today's row."""
    global _last_refresh
    with _refresh_lock:
        wait = _REFRESH_MIN_GAP_SECONDS - (time.monotonic() - _last_refresh)
        if wait > 0:
            raise HTTPException(status_code=429, detail=f"Just refreshed - try again in {int(wait) + 1}s.")
        _last_refresh = time.monotonic()
    key = accounts_client.get_user_openrouter_key(user_id) or settings.openrouter_api_key or None
    today = get_report(db, today_ist())
    prior = {"inputs": today.inputs, "rules": today.rules, "macro": today.macro, "ai": today.ai, "model": today.model} if today else None
    report = build_report(key, prior=prior)
    out = report_out(save_report(db, today_ist(), report))
    out.ai_reused = report["ai_reused"]  # not stored: it describes this refresh, not the day's report
    return out
