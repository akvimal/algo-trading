"""Thin HTTP client to signal-processing - the in-house engine posts a
signal exactly the way n8n does for webhook providers (POST /signals),
so it goes through the exact same resolution/publish pipeline. See
docs/architecture.md."""

import requests

from app.config import settings


def post_signal(payload: dict) -> dict:
    resp = requests.post(
        f"{settings.signal_processing_base_url}/signals",
        json=payload,
        timeout=settings.signal_processing_timeout_seconds,
    )
    resp.raise_for_status()
    return resp.json()
