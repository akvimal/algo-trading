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

from app.domain.models import FeedSubscribeRequest
from app.providers.dhan import renew_access_token, renew_token_status
from app.providers.dhan_feed import feed_status, start_feed, subscribe

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
