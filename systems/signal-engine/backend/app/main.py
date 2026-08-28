import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import health, indicators, ingest, rules, saved_backtests, signals, strategies, watchlists, webhooks
from app.consumers.signal_resolution_consumer import start_background as start_resolution_consumer
from app.scheduler import start_scheduler

# Was never configured before the signal-resolution consumer was added -
# logger.info calls (including the consumer's own "started"/error logs)
# were silently dropped at the default WARNING root level. Matches
# execution/backend/app/main.py's existing basicConfig call.
logging.basicConfig(level=logging.INFO)

# signal-engine is the merger of the old signal-generation and
# signal-processing services (2026-08-28, see docs/architecture.md) -
# "decide when a signal fires and what it means" (Strategy/Rule config +
# the in-house engine) and "turn a fired signal into a resolved order"
# (webhook intake + resolution) were split across two services coupled by
# a synchronous HTTP call on every single signal; merging removes that
# call entirely (see app/domain/processing/resolution/generation_lookup.py).
app = FastAPI(title="signal-engine")

# Local-dev only: the frontend runs on a different port. Tighten this
# before deploying anywhere beyond localhost.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(indicators.router)
app.include_router(ingest.router)
app.include_router(rules.router)
app.include_router(saved_backtests.router)
app.include_router(signals.router)
app.include_router(strategies.router)
app.include_router(watchlists.router)
app.include_router(webhooks.router)

_consumer_stop_event = None


@app.on_event("startup")
def _startup() -> None:
    global _consumer_stop_event
    start_scheduler()
    _consumer_stop_event = start_resolution_consumer()


@app.on_event("shutdown")
def _shutdown() -> None:
    if _consumer_stop_event is not None:
        _consumer_stop_event.set()
