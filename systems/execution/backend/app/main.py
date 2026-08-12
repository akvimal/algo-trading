import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import accounts, health, positions
from app.api.routes import settings as settings_routes
from app.consumers.orders_consumer import start_background as start_consumer
from app.scheduler import start_scheduler

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="execution")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(positions.router)
app.include_router(settings_routes.router)
app.include_router(accounts.router)

_consumer_stop_event = None


@app.on_event("startup")
def _startup() -> None:
    global _consumer_stop_event
    start_scheduler()
    _consumer_stop_event = start_consumer()


@app.on_event("shutdown")
def _shutdown() -> None:
    if _consumer_stop_event is not None:
        _consumer_stop_event.set()
