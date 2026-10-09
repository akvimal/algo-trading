"""Asks the execution service for one user's trades of a day (its internal, shared-secret route), for the post-session summary.
Market-data never reads execution's tables: this is the HTTP seam between the two."""

import logging
from datetime import date
from typing import Optional
from uuid import UUID

import requests

from app.config import settings

logger = logging.getLogger(__name__)


def trader_day(user_id: UUID, segment: str, day: date) -> Optional[dict]:
    """The person's closed trades for that IST day (paper and live apart), what is still open and their discipline score; None when
    execution cannot be reached (the summary then says so rather than pretending there were no trades)."""
    try:
        resp = requests.get(
            f"{settings.execution_base_url}/internal/session-summary",
            params={"user_id": str(user_id), "segment": segment, "day": day.isoformat()},
            headers={"X-Internal-Secret": settings.internal_service_secret},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.RequestException as exc:
        logger.warning("session summary: execution could not be asked for %s: %s", user_id, exc)
        return None
