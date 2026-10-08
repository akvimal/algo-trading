"""GET /market-brief/{segment} - the in-session NSE pulse and the MCX and crypto briefs, the counterparts of the NSE
morning GET /premarket: live inputs, a rule-based score and an AI read, in the same response shape. Built on demand and
cached for an hour (see app/domain/segment_brief.py); `?refresh=true` rebuilds it now (at most every 15 minutes), on the
caller's own OpenRouter key when they have one. The model is only called again when the numbers changed."""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from app.adapters import accounts_client
from app.auth import get_optional_user_id
from app.config import settings
from app.domain.models import PremarketReportOut
from app.domain.segment_brief import SEGMENTS, get_brief

router = APIRouter()


@router.get("/market-brief/{segment}", response_model=PremarketReportOut)
def get_market_brief(segment: str, refresh: bool = False, user_id: Optional[UUID] = Depends(get_optional_user_id)):
    seg = segment.strip().upper()
    if seg not in SEGMENTS:
        raise HTTPException(status_code=404, detail=f"no market brief for '{segment}'")
    if refresh and user_id is None:
        raise HTTPException(status_code=401, detail="Sign in to refresh.")
    key = (accounts_client.get_user_openrouter_key(user_id) if user_id else None) or settings.openrouter_api_key or None
    try:
        return PremarketReportOut(**get_brief(seg, key, force=refresh))
    except PermissionError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
