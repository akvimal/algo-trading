"""Manual trigger + visibility for Dhan access-token renewal - mirrors
instruments.py's POST /instruments/sync + GET /instruments/sync-status
pair. The actual renewal also runs on a schedule (app/scheduler.py); this
exists for on-demand renewal and to see the current in-memory state
(app/providers/dhan.py's renew_access_token/renew_token_status)."""

from fastapi import APIRouter, HTTPException

from app.providers.dhan import renew_access_token, renew_token_status

router = APIRouter()


@router.post("/dhan/renew-token")
def renew_token():
    try:
        return renew_access_token()
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/dhan/token-status")
def token_status():
    return renew_token_status()
