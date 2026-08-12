"""Delta Exchange India live feed status + manual subscribe - mirrors
dhan.py's own feed-status/subscribe pair. The feed connection itself runs
continuously in a background thread (app/providers/delta_feed.py's
start_feed(), called from app.main's startup handler). Kept as a separate
router/path (`/delta/...` vs `/dhan/...`) rather than generalizing both
providers' feed routes onto one shared path - avoids touching Dhan's
already-working routes for a speculative abstraction, see
docs/architecture.md."""

from fastapi import APIRouter, HTTPException

from app.domain.models import FeedSubscribeRequest
from app.providers.delta_feed import feed_status, subscribe

router = APIRouter()


@router.get("/delta/feed-status")
def get_feed_status():
    return feed_status()


@router.post("/delta/feed/subscribe")
def subscribe_feed(payload: FeedSubscribeRequest):
    try:
        ok = subscribe(payload.exchange, payload.symbol)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not ok:
        raise HTTPException(
            status_code=404, detail=f"could not resolve '{payload.symbol}' on exchange '{payload.exchange}' for the live feed"
        )
    return feed_status()
