"""Per-user ownership helpers for the core routes (see app/auth.py's Caller).

Rules, in one place:

- Every ownable row has a nullable `created_by` (the JWT `sub` of whoever
  created it). NULL means "platform / legacy": rows that predate ownership
  (or were created anonymously while REQUIRE_AUTH was off).
- When ownership is enforced, a non-admin sees ONLY rows whose created_by is
  their own id, so NULL-owner rows are invisible to them. Admins see
  everything. (`Caller.scope_user_id` is None for admins and for the
  flag-off case, which is how unrestricted access falls out with no special
  casing in the routes.)
- Someone else's row is reported as 404, not 403, so existence is not
  disclosed.
- The engine (app/domain/generation/engine.py) and other in-process code do
  not go through these helpers and keep evaluating every strategy
  regardless of owner - ownership scopes the API, not the scheduler.
"""

import uuid
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.auth import Caller


def is_visible(row: Any, caller: Caller) -> bool:
    scope = caller.scope_user_id
    return scope is None or getattr(row, "created_by", None) == scope


def apply_scope(query, model, caller: Caller):
    """Restrict a Query on `model` to what `caller` may see."""
    scope = caller.scope_user_id
    if scope is None:
        return query
    return query.filter(model.created_by == scope)


def get_owned_or_404(db: Session, model, row_id: uuid.UUID, caller: Caller, detail: str):
    row = db.get(model, row_id)
    if row is None or not is_visible(row, caller):
        raise HTTPException(status_code=404, detail=detail)
    return row


def visible_strategy_ids(caller: Caller):
    """A subquery of the strategy ids `caller` may see, or None when
    unrestricted - for scoping tables that only carry a strategy_id
    (signals, resolved orders) without their own created_by."""
    scope = caller.scope_user_id
    if scope is None:
        return None
    return select(db_models.Strategy.id).where(db_models.Strategy.created_by == scope)


def owner_for_create(caller: Caller) -> Optional[uuid.UUID]:
    """The created_by to stamp on a new row: the caller's id whenever they
    sent a valid token (even with the flag off, so ownership accumulates
    ahead of the flip), else None."""
    return caller.user_id
