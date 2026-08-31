"""Fetches a Strategy for resolve() (see pipeline.py's fetch_strategy
parameter) directly from the DB - the in-process replacement for what used
to be an HTTP GET to signal-generation's own GET /strategies/{id}, before
the signal-engine merge (2026-08-28, see docs/architecture.md). Reuses
strategies.py's own row->dict serialization so this produces the exact
same shape resolve() always expected, byte-for-byte - which means
mode="json" below, not model_dump()'s default: pipeline.py's
is_within_active_window expects active_windows' start/end as "HH:MM:SS"
strings, straight off the old HTTP JSON response's own wire shape.
StrategyOut.active_windows is typed as real datetime.time objects
(ActiveWindow.start/end) - a plain model_dump() keeps those as time
objects instead of serializing them, which time.fromisoformat() then
rejects with "argument must be str". Confirmed live 2026-08-31 on VPS:
crashed resolution for any strategy with active_windows actually set
(the empty-list case never reaches is_within_active_window at all, which
is why this went unnoticed until a real one had them configured)."""

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
    return _to_out(row, rule_row, _last_scan_at(db, parsed_id)).model_dump(mode="json")
