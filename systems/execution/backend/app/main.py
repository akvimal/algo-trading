import logging

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import accounts, checklist, health, internal, option_groups, positions, trade_images
from app.api.routes import settings as settings_routes
from app.auth import get_current_user
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

# health stays open (liveness probe) - every other router requires a valid
# bearer token, enforced once here rather than per-route. This is Phase 2
# of the manual-trading SaaS (see docs/architecture.md) - execution-frontend
# and manual-trading-frontend don't send a token yet (Phase 4), so their
# calls to these routers 401 until then; that's the known, accepted cost
# of this phase actually enforcing tenant isolation.
_auth_dep = [Depends(get_current_user)]
app.include_router(health.router)
# Shared-secret protected (see internal.py's own _require_internal_secret),
# NOT the app-wide user-JWT dependency below - market-data (relaying Dhan's
# order-update postback) has no user bearer token to forward here.
app.include_router(internal.router)
app.include_router(positions.router, dependencies=_auth_dep)
app.include_router(option_groups.router, dependencies=_auth_dep)
app.include_router(settings_routes.router, dependencies=_auth_dep)
app.include_router(accounts.router, dependencies=_auth_dep)
app.include_router(checklist.router, dependencies=_auth_dep)
app.include_router(trade_images.router, dependencies=_auth_dep)

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
