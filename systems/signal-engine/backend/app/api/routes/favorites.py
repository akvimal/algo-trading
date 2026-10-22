"""A person's favourite stocks: GET /favorites, PUT/DELETE /favorites/{symbol}. Personal: every call is scoped to the caller's own rows
(an admin's too), unlike the shared-visibility routes in app/ownership.py."""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.api.routes.fundamentals import valid_symbol
from app.auth import Caller, get_caller

router = APIRouter()

# Who owns the rows when sign-in is not enforced (one local user).
_NO_USER = uuid.UUID(int=0)


def _owner(caller: Caller) -> uuid.UUID:
    return caller.user_id or _NO_USER


@router.get("/favorites", response_model=list[str])
def list_favorites(db: Session = Depends(get_db), caller: Caller = Depends(get_caller)):
    rows = db.query(db_models.Favorite).filter_by(owner=_owner(caller)).order_by(db_models.Favorite.created_at.desc()).all()
    return [r.symbol for r in rows]


@router.put("/favorites/{symbol}", response_model=list[str])
def add_favorite(symbol: str, db: Session = Depends(get_db), caller: Caller = Depends(get_caller)):
    """Idempotent: starring a stock twice leaves one row."""
    sym = valid_symbol(symbol)
    if db.get(db_models.Favorite, (_owner(caller), sym)) is None:
        db.add(db_models.Favorite(owner=_owner(caller), symbol=sym))
        db.commit()
    return list_favorites(db, caller)


@router.delete("/favorites/{symbol}", response_model=list[str])
def remove_favorite(symbol: str, db: Session = Depends(get_db), caller: Caller = Depends(get_caller)):
    sym = valid_symbol(symbol)
    row: Optional[db_models.Favorite] = db.get(db_models.Favorite, (_owner(caller), sym))
    if row is not None:
        db.delete(row)
        db.commit()
    return list_favorites(db, caller)
