"""Fetches a Strategy for resolve() (see pipeline.py's fetch_strategy
parameter) directly from the DB - the in-process replacement for what used
to be an HTTP GET to signal-generation's own GET /strategies/{id}, before
the signal-engine merge (2026-08-28, see docs/architecture.md). Reuses
strategies.py's own row->dict serialization so this produces the exact
same shape resolve() always expected, byte-for-byte."""

import uuid

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.api.routes.strategies import _last_scan_at, _to_out
from app.domain.processing.resolution.errors import ResolutionError


def fetch_strategy(db: Session, strategy_id: str) -> dict:
    try:
        parsed_id = uuid.UUID(strategy_id)
    except ValueError:
        raise ResolutionError(f"strategy {strategy_id} not found")

    row = db.get(db_models.Strategy, parsed_id)
    if row is None:
        raise ResolutionError(f"strategy {strategy_id} not found")
    rule_row = db.get(db_models.Rule, row.rule_id) if row.rule_id is not None else None
    return _to_out(row, rule_row, _last_scan_at(db, parsed_id)).model_dump()
