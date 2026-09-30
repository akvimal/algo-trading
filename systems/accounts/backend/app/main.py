import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.secure_config import cors_origins, enforce_secure_config
from app.api.routes import admin, auth, credentials, health, internal

logging.basicConfig(level=logging.INFO)

# Refuses to start with placeholder secrets / wildcard CORS when
# REQUIRE_SECURE_CONFIG=true (see app/secure_config.py).
enforce_secure_config()

app = FastAPI(title="accounts")

# Local-dev only: every frontend runs on a different port. Tighten this
# before deploying anywhere beyond localhost - see docs/architecture.md's
# Phase 4 (frontend auth) notes on why this can't stay ["*"] once cookies
# or credentialed requests enter the picture.
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(credentials.router)
app.include_router(internal.router)
app.include_router(admin.router)
