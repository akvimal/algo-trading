"""HTTP client for signal-engine - only what dedicated strategy accounts need:
whether the CALLER may see a strategy, and who created it.

Uses the caller's own bearer token against GET /strategies/{id}, which
signal-engine scopes by ownership (a strategy someone else owns is a 404 for
them once its REQUIRE_AUTH flag is on). Execution therefore never has to
trust a client-supplied "I own this strategy", and never reads signal-engine's
tables (systems/* stay self-contained)."""

import logging
from dataclasses import dataclass
from typing import Optional

import requests

from app.config import settings

logger = logging.getLogger(__name__)

FOUND = "found"
NOT_FOUND = "not_found"
UNAVAILABLE = "unavailable"


@dataclass
class StrategyLookup:
    status: str  # FOUND | NOT_FOUND | UNAVAILABLE
    created_by: Optional[str] = None  # the strategy's owner (None = platform/legacy strategy)


def lookup_strategy(strategy_id: str, token: str) -> StrategyLookup:
    """FOUND (with the owner), NOT_FOUND (missing, or not visible to this
    caller - signal-engine deliberately does not distinguish), or UNAVAILABLE
    when it could not be determined (unreachable, timeout, unexpected
    response). Callers must fail closed on UNAVAILABLE."""
    if not token:
        return StrategyLookup(UNAVAILABLE)
    try:
        resp = requests.get(
            f"{settings.signal_engine_base_url}/strategies/{strategy_id}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=5,
        )
    except requests.RequestException:
        logger.exception("strategy accounts: could not reach signal-engine to look up strategy %s", strategy_id)
        return StrategyLookup(UNAVAILABLE)
    if resp.status_code in (403, 404):
        return StrategyLookup(NOT_FOUND)
    try:
        resp.raise_for_status()
        return StrategyLookup(FOUND, created_by=resp.json().get("created_by"))
    except (requests.RequestException, ValueError):
        logger.exception("strategy accounts: unexpected signal-engine response (%s) for strategy %s", resp.status_code, strategy_id)
        return StrategyLookup(UNAVAILABLE)
