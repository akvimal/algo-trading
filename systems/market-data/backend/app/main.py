from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import candles, dhan, health, instruments, options, quotes
from app.providers.dhan_feed import start_feed
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
app.include_router(dhan.router)
app.include_router(options.router)


@app.on_event("startup")
def _startup() -> None:
    start_scheduler()
    start_feed()
