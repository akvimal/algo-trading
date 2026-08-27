import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.domain.rule import parse_symbol_list
from app.domain.watchlist import WatchlistCreate, WatchlistOut, WatchlistUpdate

router = APIRouter()


def _to_out(row: db_models.Watchlist) -> WatchlistOut:
    return WatchlistOut(
        id=str(row.id),
        name=row.name,
        symbols=row.symbols,
        symbol_count=len(parse_symbol_list(row.symbols)),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.post("/watchlists", response_model=WatchlistOut, status_code=201)
def create_watchlist(payload: WatchlistCreate, db: Session = Depends(get_db)):
    row = db_models.Watchlist(name=payload.name, symbols=payload.symbols)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f"a watchlist named '{payload.name}' already exists")
    db.refresh(row)
    return _to_out(row)


@router.get("/watchlists", response_model=list[WatchlistOut])
def list_watchlists(db: Session = Depends(get_db)):
    rows = db.query(db_models.Watchlist).order_by(db_models.Watchlist.name).all()
    return [_to_out(r) for r in rows]


@router.get("/watchlists/{watchlist_id}", response_model=WatchlistOut)
def get_watchlist(watchlist_id: str, db: Session = Depends(get_db)):
    try:
        parsed_id = uuid.UUID(watchlist_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="watchlist not found")

    row = db.get(db_models.Watchlist, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="watchlist not found")
    return _to_out(row)


@router.put("/watchlists/{watchlist_id}", response_model=WatchlistOut)
def update_watchlist(watchlist_id: str, payload: WatchlistUpdate, db: Session = Depends(get_db)):
    """symbols only - `name` isn't editable after creation, see
    WatchlistUpdate's own docstring (a rename would silently orphan every
    Rule already referencing the old name)."""
    try:
        parsed_id = uuid.UUID(watchlist_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="watchlist not found")

    row = db.get(db_models.Watchlist, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="watchlist not found")

    row.symbols = payload.symbols
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.delete("/watchlists/{watchlist_id}", status_code=204)
def delete_watchlist(watchlist_id: str, db: Session = Depends(get_db)):
    """Hard delete, unprotected - no FK from rules.underlying to this table
    (it's a plain name string, same as a 'universe' index key). A Rule
    still referencing this watchlist's name degrades exactly like an
    unresolvable 'universe' key already does (logged and skipped on the
    next engine tick, 502 on backtest) - see app/domain/engine.py's
    _target_symbols and app/api/routes/rules.py's _backtest_watchlist."""
    try:
        parsed_id = uuid.UUID(watchlist_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="watchlist not found")

    row = db.get(db_models.Watchlist, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="watchlist not found")

    db.delete(row)
    db.commit()
