import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import health, ingest, signals, webhooks
from app.consumers.signal_resolution_consumer import start_background as start_consumer

# Was never configured before the signal-resolution consumer was added -
# logger.info calls (including the consumer's own "started"/error logs)
# were silently dropped at the default WARNING root level. Matches
# execution/backend/app/main.py's existing basicConfig call.
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="signal-processing")

# Local-dev only: the frontend runs on a different port. Tighten this
# before deploying anywhere beyond localhost.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(ingest.router)
app.include_router(signals.router)
app.include_router(webhooks.router)

_consumer_stop_event = None


@app.on_event("startup")
def _startup() -> None:
    global _consumer_stop_event
    _consumer_stop_event = start_consumer()


@app.on_event("shutdown")
def _shutdown() -> None:
    if _consumer_stop_event is not None:
        _consumer_stop_event.set()
