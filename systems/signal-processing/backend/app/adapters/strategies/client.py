"""Thin HTTP client to signal-generation. signal-processing never guesses
horizon/instrument_type/quantity itself - it asks the Strategy that
produced the signal, same cross-system-HTTP pattern as execution calling
market-data for quotes."""

import requests

from app.config import settings
from app.domain.resolution.errors import ResolutionError


def fetch_strategy(strategy_id: str) -> dict:
    try:
        resp = requests.get(
            f"{settings.signal_generation_base_url}/strategies/{strategy_id}",
            timeout=settings.signal_generation_timeout_seconds,
        )
    except requests.RequestException as exc:
        raise ResolutionError(f"could not reach signal-generation: {exc}") from exc

    if resp.status_code == 404:
        raise ResolutionError(f"strategy {strategy_id} not found")
    try:
        resp.raise_for_status()
    except requests.exceptions.HTTPError as exc:
        raise ResolutionError(f"signal-generation error ({resp.status_code}): {resp.text[:200]}") from exc

    return resp.json()
