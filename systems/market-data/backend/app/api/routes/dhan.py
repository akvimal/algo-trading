"""Manual trigger + visibility for Dhan access-token renewal - mirrors
instruments.py's POST /instruments/sync + GET /instruments/sync-status
pair. The actual renewal also runs on a schedule (app/scheduler.py); this
exists for on-demand renewal and to see the current in-memory state
(app/providers/dhan.py's renew_access_token/renew_token_status).

Also the live market feed's status + manual subscribe endpoint - unlike
Delta's own feed, the Dhan feed is no longer auto-started on boot (its
reconnect-on-every-restart behavior was hammering Dhan's own account-wide
rate limit, which also blocks the plain REST quote API - reproduced live),
so POST /dhan/feed/subscribe below now calls start_feed() itself before
subscribing (idempotent - a no-op if the background thread's already
running) rather than relying on app.main's startup handler to have started
it already."""

from fastapi import APIRouter, HTTPException

from app.config import settings
from app.domain.models import DhanCredentialsUpdate, FeedSubscribeRequest
from app.providers.dhan import current_access_token, renew_access_token, renew_token_status, set_manual_credentials
from app.providers.dhan_feed import feed_status, start_feed, subscribe

# The platform operator's own ops surface (Dhan data-provider credentials,
# token renewal, live-feed status/subscribe). No login required (removed
# 2026-08-29 at the user's request) - this is a single-operator, self-
# hosted platform, and gating the screen an operator needs in order to get
# quotes working at all added friction without protecting anything a
# person on this same box couldn't already do.
router = APIRouter()


@router.get("/dhan/token-expiry")
def token_expiry():
    # Narrower than /dhan/token-status below (just the expiry timestamp) -
    # kept as its own route since shell/index.html's global "Dhan token
    # expiring soon" banner has polled this one specifically since
    # 2026-08-29 and there's no reason to churn its URL now.
    return {"token_expires_at": renew_token_status()["token_expires_at"]}


@router.post("/dhan/renew-token")
def renew_token():
    try:
        return renew_access_token()
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/dhan/token-status")
def token_status():
    # dhan_client_id/has_access_token surface what's CURRENTLY configured
    # (from .env, or a prior PUT /dhan/credentials) - has_access_token is
    # a presence check only, never the raw secret itself.
    return {
        **renew_token_status(),
        "dhan_client_id": settings.dhan_client_id,
        "has_access_token": bool(current_access_token()),
    }


@router.put("/dhan/credentials")
def update_credentials(payload: DhanCredentialsUpdate):
    """The UI's 'Data provider keys' form - sets both the Dhan client ID
    and access token at runtime, no restart needed (see
    set_manual_credentials' own docstring for the in-memory-only caveat)."""
    set_manual_credentials(payload.client_id, payload.access_token)
    return token_status()


@router.get("/dhan/feed-status")
def get_feed_status():
    return feed_status()


@router.post("/dhan/feed/subscribe")
def subscribe_feed(payload: FeedSubscribeRequest):
    start_feed()
    try:
        ok = subscribe(payload.exchange, payload.symbol)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not ok:
        raise HTTPException(
            status_code=404, detail=f"could not resolve '{payload.symbol}' on exchange '{payload.exchange}' for the live feed"
        )
    return feed_status()
