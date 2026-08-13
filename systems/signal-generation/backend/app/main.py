from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import health, indicators, rules, strategies
from app.scheduler import start_scheduler

app = FastAPI(title="signal-generation")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(indicators.router)
app.include_router(rules.router)
app.include_router(strategies.router)


@app.on_event("startup")
def _startup() -> None:
    start_scheduler()
