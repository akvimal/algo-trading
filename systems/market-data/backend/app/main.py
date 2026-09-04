from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import (
    candles,
    delta,
    dhan,
    health,
    instruments,
    options,
    order_blocks,
    price_alerts,
    quotes,
    regime,
)
from app.providers.delta_feed import start_feed as start_delta_feed
from app.providers.dhan import load_persisted_credentials
from app.scheduler import start_scheduler

app = FastAPI(title="market-data")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(quotes.router)
app.include_router(instruments.router)
app.include_router(candles.router)
app.include_router(order_blocks.router)
app.include_router(regime.router)
app.include_router(price_alerts.router)
app.include_router(dhan.router)
app.include_router(delta.router)
app.include_router(options.router)


@app.on_event("startup")
def _startup() -> None:
    load_persisted_credentials()
    start_scheduler()
    # Dhan's live feed is no longer auto-started on boot - its
    # reconnect-on-every-restart behavior was hammering Dhan's own
    # account-wide rate limit (keyed by DHAN_CLIENT_ID, shared with the
    # REST quote API - a 429 block here also broke plain LTP calls,
    # reproduced live) every time this service gets rebuilt/restarted,
    # which happens often during normal development. Still available via
    # POST /dhan/feed/subscribe if a live tick feed is actually needed for
    # a session - that's a deliberate, one-off opt-in now instead of an
    # unconditional one on every boot.
    start_delta_feed()
