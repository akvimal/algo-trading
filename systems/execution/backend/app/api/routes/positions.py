import functools
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.adapters.quotes.client import get_candle_history, get_ltp_batch, get_previous_candle, resolve_underlying
from app.auth import User, get_current_user, require_admin
from app.domain.models import ManualPositionCreate, ReviewSubmit, SquareOffTimeUpdate, StopLossUpdate
from app.domain.position_manager import (
    check_exits,
    compute_unrealized_pnl,
    find_missing_daily_checklist,
    load_settings,
    open_manual_position,
    square_off_all_open,
    square_off_due_positions,
    square_off_position,
    submit_position_review,
    update_square_off_time,
    update_stop_loss,
    validate_plan_checklist,
)

router = APIRouter()


def _authorized_owner_id(row_user_id: Optional[uuid.UUID], user: User) -> uuid.UUID | None:
    """A per-position action route (square-off, stop-loss edit, etc.) may
    act on the caller's own row (user_id=user.id), or - since every caller
    of this frontend is already an admin (AuthGate.tsx gates the whole app
    behind one) - on a platform-wide row (user_id IS NULL) the automated
    Strategy-driven flow itself owns, same reasoning as GET/DELETE
    /positions/platform. Returns the actual owner to re-pass into the
    domain function (None for a platform row, so load_settings/
    load_capital_account etc. keep reading the platform's own account, not
    the admin's personal one) - never the caller's own id when the row
    belongs to the platform instead. Raises 404 for anything else,
    including a genuinely unknown id or one owned by a DIFFERENT user
    (never possible today, no second real user exists, but this is the
    right behavior if one ever does). Confirmed live 2026-08-27: a
    Strategy-driven position's per-row 'Square off' button silently 404'd
    even though the position was visible (post-GET/positions/platform fix)
    and genuinely OPEN, because this authorization check still only ever
    accepted user.id."""
    if row_user_id == user.id:
        return user.id
    if row_user_id is None and user.is_admin:
        return None
    raise HTTPException(status_code=404, detail="position not found")


def _position_to_out(row: db_models.Position, live_price: Optional[float] = None, unrealized_pnl: Optional[float] = None) -> dict:
    return {
        "id": str(row.id),
        "signal_id": str(row.signal_id),
        # None for manually-opened positions (Manual tab) - no Strategy at all, see docs/architecture.md.
        "strategy_id": str(row.strategy_id) if row.strategy_id is not None else None,
        "symbol": row.symbol,
        "exchange": row.exchange,
        "segment": row.segment,
        "action": row.action,
        "horizon": row.horizon,
        "instrument_type": row.instrument_type,
        "quantity": float(row.quantity) if row.quantity is not None else None,
        "entry_price": float(row.entry_price),
        "entry_time": row.entry_time.isoformat(),
        "exit_price": float(row.exit_price) if row.exit_price is not None else None,
        "exit_time": row.exit_time.isoformat() if row.exit_time else None,
        "pnl": float(row.pnl) if row.pnl is not None else None,
        "live_price": live_price,
        "unrealized_pnl": unrealized_pnl,
        "status": row.status,
        "rejection_reason": row.rejection_reason,
        "stop_loss_price": float(row.stop_loss_price) if row.stop_loss_price is not None else None,
        "target_price": float(row.target_price) if row.target_price is not None else None,
        "trailing_stop_enabled": row.trailing_stop_enabled,
        "stop_loss_method": row.stop_loss_method,
        "stop_loss_interval": row.stop_loss_interval,
        "stop_loss_percent": float(row.stop_loss_percent) if row.stop_loss_percent is not None else None,
        "stop_loss_indicator_type": row.stop_loss_indicator_type,
        "stop_loss_indicator_params": row.stop_loss_indicator_params,
        "exit_reason": row.exit_reason,
        "square_off_time": row.square_off_time.isoformat() if row.square_off_time is not None else None,
        "option_group_id": str(row.option_group_id) if row.option_group_id is not None else None,
        # Delta Exchange fee/liquidation simulation (app/domain/delta_fees.py)
        # - CRYPTO + instrument_type='future' only, null for every other
        # position.
        "open_fee": float(row.open_fee) if row.open_fee is not None else None,
        "close_fee": float(row.close_fee) if row.close_fee is not None else None,
        "margin_posted": float(row.margin_posted) if row.margin_posted is not None else None,
        "liquidation_price": float(row.liquidation_price) if row.liquidation_price is not None else None,
        # NSE MTF only - null for every other position. See
        # infra/postgres/init/02-execution.sql's own comment.
        "mtf_interest_rate_pct": float(row.mtf_interest_rate_pct) if row.mtf_interest_rate_pct is not None else None,
        "interest_charged": float(row.interest_charged) if row.interest_charged is not None else None,
        # Trade discipline checklist (Manual tab only) - null for every
        # Strategy-driven position, see infra/postgres/init/
        # 02-execution.sql's own comment on these 4 columns.
        "plan_checklist": row.plan_checklist,
        "reviewed_at": row.reviewed_at.isoformat() if row.reviewed_at is not None else None,
        "review_violation": row.review_violation,
        "review_notes": row.review_notes,
        "review_checklist": row.review_checklist,
        # 'market' | 'limit' | null - see execution.positions.order_type's own comment.
        "order_type": row.order_type,
    }


def _query_positions(
    db: Session,
    user_id: Optional[uuid.UUID],
    status: Optional[str],
    signal_id: Optional[str],
    symbol: Optional[str],
    segment: Optional[str],
    manual_only: bool,
    limit: int,
    with_live_pnl: bool,
):
    """Shared by GET /positions (user_id=caller) and GET /positions/platform
    (user_id=None) - identical filtering/serialization, only the ownership
    scope differs. See both routes' own docstrings for what each filter
    means."""
    q = db.query(db_models.Position).filter_by(user_id=user_id)
    if status:
        q = q.filter_by(status=status.upper())
    if signal_id:
        try:
            q = q.filter_by(signal_id=uuid.UUID(signal_id))
        except ValueError:
            return []  # not a valid UUID - no match rather than a 500
    if symbol:
        q = q.filter_by(symbol=symbol)
    if segment:
        q = q.filter_by(segment=segment)
    if manual_only:
        q = q.filter(db_models.Position.strategy_id.is_(None))
    rows = q.order_by(db_models.Position.entry_time.desc()).limit(limit).all()

    mtm = compute_unrealized_pnl(rows, get_ltp_batch) if with_live_pnl else {}

    return [
        _position_to_out(r, live_price=mtm[r.id][0] if r.id in mtm else None, unrealized_pnl=mtm[r.id][1] if r.id in mtm else None)
        for r in rows
    ]


@router.get("/positions")
def list_positions(
    status: Optional[str] = Query(default=None),
    signal_id: Optional[str] = Query(default=None),
    symbol: Optional[str] = Query(default=None),
    segment: Optional[str] = Query(default=None),
    manual_only: bool = Query(default=False),
    limit: int = 100,
    with_live_pnl: bool = Query(default=False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Always scoped to the caller's own positions (user_id=user.id) - the
    automated Strategy-driven flow's positions (user_id IS NULL) are never
    visible via this route regardless of any other filter, same isolation
    every other route in this file now has (see GET /positions/platform
    below for how to actually see those). signal_id: exact match, for
    cross-system deep links (?signal_id=... from signal-processing's
    frontend to this position's outcome). symbol/segment: exact match -
    backs ManualTab.tsx's own per-row trade-history backfill (a row has no
    persisted identity beyond symbol+segment+instrument_type, so this is
    how it re-finds its own past trades after a reload, rather than only
    ever seeing closes detected live during the current session).
    manual_only: strategy_id IS NULL - always true in practice now that
    this route is user-scoped (every one of a user's own positions is
    already manual), kept for backward-compatible query-param shape.
    with_live_pnl: mark-to-market OPEN positions in this response against
    a fresh quote (one batched call per distinct exchange) - off by
    default since it means extra Dhan calls on every request; the
    frontend opts in for its own polling, other callers (cross-links,
    other systems) don't pay for it unless they ask."""
    return _query_positions(db, user.id, status, signal_id, symbol, segment, manual_only, limit, with_live_pnl)


@router.get("/positions/platform")
def list_platform_positions(
    status: Optional[str] = Query(default=None),
    signal_id: Optional[str] = Query(default=None),
    symbol: Optional[str] = Query(default=None),
    segment: Optional[str] = Query(default=None),
    manual_only: bool = Query(default=False),
    limit: int = 100,
    with_live_pnl: bool = Query(default=False),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """The platform-wide (user_id IS NULL) positions GET /positions above
    can never return - the ones the automated Strategy-driven flow (Chartink
    webhooks, in-house engine) actually opens, since a Strategy isn't owned
    by any SaaS user (see position_manager.open_position's own comment).
    Admin-gated like GET /accounts/platform, not user-scoped at all - there
    is only one platform, not one per caller. Confirmed live 2026-08-27: a
    Strategy-driven signal resolved and opened a real OPEN position, but it
    was invisible on the Positions page because GET /positions is
    unconditionally user_id=user.id - this route is what makes it visible."""
    return _query_positions(db, None, status, signal_id, symbol, segment, manual_only, limit, with_live_pnl)


@router.get("/positions/{position_id}/pnl-history")
def get_position_pnl_history(position_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Oldest-first unrealized-P&L time series recorded by the exit-monitor
    tick (see position_manager.record_position_pnl_snapshots) - lets the
    frontend chart how this position's P&L actually moved while OPEN, not
    just its entry/exit endpoints. Empty list (not 404) once the position
    closes and its snapshot rows are still there - only a genuinely
    unknown position_id (or one belonging to another user) 404s."""
    try:
        parsed_id = uuid.UUID(position_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="position not found")
    owner = db.get(db_models.Position, parsed_id)
    if owner is None:
        raise HTTPException(status_code=404, detail="position not found")
    _authorized_owner_id(owner.user_id, user)
    rows = (
        db.query(db_models.PositionPnlSnapshot)
        .filter_by(position_id=parsed_id)
        .order_by(db_models.PositionPnlSnapshot.recorded_at)
        .all()
    )
    return [
        {"recorded_at": r.recorded_at.isoformat(), "cmp": float(r.cmp), "unrealized_pnl": float(r.unrealized_pnl)} for r in rows
    ]


@router.post("/positions/manual")
def open_manual(payload: ManualPositionCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The Manual tab (signal-generation's frontend) - spot/future only,
    bypasses signal-generation/signal-processing entirely (no Strategy, no
    resolution pipeline). Options go through the real pipeline instead via
    an auto-provisioned Strategy - see docs/architecture.md. Always
    200/201 regardless of whether the result is OPEN or REJECTED, matching
    the existing pipeline's own convention - a rejection is a legitimate
    persisted outcome, not an HTTP error.

    Two discipline-checklist gates run BEFORE any of that, and are real
    HTTP errors (not a persisted REJECTED row) since they're not a trade
    attempt at all: 409 if today's 'day'-phase checklist hasn't been
    submitted yet for this segment (find_missing_daily_checklist), 422 if
    the submitted plan_checklist doesn't fully cover the currently-active
    'plan'-phase items scoped to this segment (validate_plan_checklist).
    See docs/architecture.md § 'Trade discipline checklist'. A THIRD gate
    - 409 while any manual position/group sat CLOSED but unreviewed -
    used to block here too; removed 2026-08-26 at the user's explicit
    request ("don't need to restrict to complete review") - GET
    /manual-trades/pending-review (find_pending_manual_review) still
    surfaces the same trade as a reminder banner in the frontend, it just
    no longer blocks placing a new one."""
    settings = load_settings(db, user.id)
    daily_error = find_missing_daily_checklist(db, user.id, settings, payload.segment)
    if daily_error is not None:
        raise HTTPException(status_code=409, detail=daily_error)
    checklist_error = validate_plan_checklist(db, user.id, payload.plan_checklist, payload.segment)
    if checklist_error is not None:
        raise HTTPException(status_code=422, detail=checklist_error)

    row = open_manual_position(
        user.id,
        payload.segment,
        payload.symbol,
        payload.action,
        payload.instrument_type,
        payload.price,
        payload.quantity,
        payload.stop_loss_price,
        settings,
        db,
        resolve_underlying,
        functools.partial(get_previous_candle, token=user.token),
        functools.partial(get_candle_history, token=user.token),
        payload.stop_loss_method,
        payload.stop_loss_interval,
        payload.stop_loss_percent,
        payload.stop_loss_indicator_type,
        payload.stop_loss_indicator_params,
        payload.trailing_stop_enabled,
        [a.model_dump() for a in payload.plan_checklist],
        payload.order_type,
        payload.square_off_time,
    )
    return _position_to_out(row)


@router.put("/positions/{position_id}/review")
def review_position(position_id: str, payload: ReviewSubmit, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The Complete step of the discipline checklist - submitted once a
    manually-opened position closes. 404 if missing, 409 if it's not a
    CLOSED manual position or is already reviewed, 422 if it closed at a
    loss and `accepted_loss` wasn't set. Clears this trade from GET
    /manual-trades/pending-review (find_pending_manual_review), which the
    frontend's own reminder banner reads - no longer a hard gate on new
    orders (see POST /positions/manual's own docstring)."""
    try:
        parsed_id = uuid.UUID(position_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="position not found")

    row, reject_reason = submit_position_review(
        db, user.id, parsed_id, payload.violation, payload.notes, payload.accepted_loss, [a.model_dump() for a in payload.checklist]
    )
    if reject_reason == "position not found":
        raise HTTPException(status_code=404, detail=reject_reason)
    if reject_reason == "must accept the loss before submitting this review":
        raise HTTPException(status_code=422, detail=reject_reason)
    if reject_reason is not None:
        raise HTTPException(status_code=409, detail=reject_reason)
    return _position_to_out(row)


@router.put("/positions/{position_id}/stop-loss")
def edit_stop_loss(position_id: str, payload: StopLossUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Generically useful, not manual-only - editing SL on any already-open
    position, including attaching/replacing a trailing, method-based
    stop-loss after the fact (percent/previous_candle/indicator - see
    StopLossUpdate/update_stop_loss). 404 if missing or owned by another
    user, 409 if not OPEN, 422 if a stop_loss_method was given but
    couldn't be computed (not enough history yet, wrong side of entry,
    etc - the position's existing stop-loss is left untouched in that
    case)."""
    try:
        parsed_id = uuid.UUID(position_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="position not found")

    row = db.get(db_models.Position, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="position not found")
    owner_id = _authorized_owner_id(row.user_id, user)
    if row.status != "OPEN":
        raise HTTPException(status_code=409, detail=f"position is {row.status}, not OPEN")

    row, reject_reason = update_stop_loss(
        db,
        owner_id,
        parsed_id,
        payload.stop_loss_price,
        payload.stop_loss_method,
        payload.stop_loss_interval,
        payload.stop_loss_percent,
        payload.stop_loss_indicator_type,
        payload.stop_loss_indicator_params,
        payload.trailing_stop_enabled,
        functools.partial(get_previous_candle, token=user.token),
        functools.partial(get_candle_history, token=user.token),
    )
    if reject_reason is not None:
        raise HTTPException(status_code=422, detail=reject_reason)
    return _position_to_out(row)


@router.put("/positions/{position_id}/square-off-time")
def edit_square_off_time(
    position_id: str, payload: SquareOffTimeUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Edits an already-open position's own square_off_time - lets a
    position be closed ahead of (or, given a later time, past) its
    segment's usual cutoff, e.g. squaring an MCX position out before
    18:00's volatility-regime change without touching MCX's own
    execution.accounts.square_off_time or any other open MCX position.
    404 if missing or owned by another user, 409 if not OPEN. `null`
    clears it (never force-closed by time, same as CRYPTO's own segment
    default)."""
    try:
        parsed_id = uuid.UUID(position_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="position not found")

    row = db.get(db_models.Position, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="position not found")
    owner_id = _authorized_owner_id(row.user_id, user)
    if row.status != "OPEN":
        raise HTTPException(status_code=409, detail=f"position is {row.status}, not OPEN")

    row = update_square_off_time(db, owner_id, parsed_id, payload.square_off_time)
    return _position_to_out(row)


@router.post("/positions/square-off")
def square_off_now(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Manual override - closes EVERY open position BELONGING TO the
    caller immediately, regardless of each one's own square_off_time.
    Useful for squaring off early or testing without waiting for the
    clock."""
    return square_off_all_open(db, user.id, functools.partial(get_ltp_batch, token=user.token))


@router.post("/positions/square-off-due")
def square_off_due_now(db: Session = Depends(get_db)):
    """Manual trigger - same logic the scheduled square-off job runs
    (only closes positions whose own square_off_time has passed, not
    everything). Useful for testing without waiting on the poll interval.
    KNOWN GAP: deliberately NOT user-scoped (mirrors the cross-tenant
    scheduler job exactly, since that's what this exists to let you
    manually re-trigger) - any authenticated user can currently fire this
    for every user's due positions. Fine for solo/personal use; needs a
    platform-admin role before this SaaS has more than one real user."""
    return square_off_due_positions(db, get_ltp_batch)


@router.post("/positions/check-exits")
def check_exits_now(db: Session = Depends(get_db)):
    """Manual trigger - same logic the exit-monitor job runs on its
    interval. Useful for testing without waiting on the poll interval.
    Same KNOWN GAP as /positions/square-off-due above (cross-tenant,
    not scoped to the caller)."""
    return check_exits(db, get_ltp_batch, get_previous_candle, get_candle_history)


@router.post("/positions/{position_id}/square-off")
def square_off_one(
    position_id: str,
    quantity: Optional[float] = Query(default=None, gt=0),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Closes exactly one OPEN position - the frontend's per-row
    'Square off' button on the Positions grid. 404 if the id doesn't
    exist or belongs to another user, 409 if it's not OPEN (already
    closed/rejected), 502 if a CMP couldn't be fetched (position is left
    OPEN, same as the bulk paths). `quantity` (optional) partially closes -
    see square_off_position's own docstring; omitted behaves exactly as
    before this parameter existed."""
    try:
        parsed_id = uuid.UUID(position_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="position not found")

    pos = db.get(db_models.Position, parsed_id)
    if pos is None:
        raise HTTPException(status_code=404, detail="position not found")
    owner_id = _authorized_owner_id(pos.user_id, user)

    result = square_off_position(db, owner_id, parsed_id, functools.partial(get_ltp_batch, token=user.token), quantity)
    if result["status"] == "not_found":
        raise HTTPException(status_code=404, detail="position not found")
    if result["status"] == "not_open":
        raise HTTPException(status_code=409, detail=f"position is {result['position_status']}, not OPEN")
    if result["status"] == "invalid_quantity":
        raise HTTPException(status_code=422, detail=f"quantity must be > 0 and <= {result['held_quantity']} held")
    if result["status"] == "quote_unavailable":
        raise HTTPException(status_code=502, detail="could not fetch a live quote for this position - still OPEN")
    return result


@router.delete("/positions")
def clear_positions(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Wipes THIS USER'S OWN positions (OPEN/CLOSED/REJECTED) AND option
    position groups (execution.option_position_groups) - a manual reset
    for testing, not something the pipeline itself ever calls. Scoped to
    user_id=user.id (changed when this route became multi-tenant - was
    previously an unscoped platform-wide wipe, which would otherwise let
    any signed-in user delete every other user's trade history). Both
    tables cleared in one transaction so an OPEN option group never
    survives without its own legs - a group whose legs were deleted but
    which itself wasn't stays OPEN forever (square-off can't quote it,
    duplicate_signal_policy=skip blocks every future signal on that
    symbol) since nothing else ever revisits it. Positions deleted first
    since they FK-reference groups. Settings and the Redis stream/consumer
    group are untouched. Signals in signal-processing and strategies in
    signal-generation are untouched too - each system only ever clears its
    own schema, see docs/architecture.md."""
    positions_deleted = db.query(db_models.Position).filter_by(user_id=user.id).delete()
    option_groups_deleted = db.query(db_models.OptionPositionGroup).filter_by(user_id=user.id).delete()
    db.commit()
    return {"positions_deleted": positions_deleted, "option_groups_deleted": option_groups_deleted}


@router.delete("/positions/platform")
def clear_platform_positions(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Platform-wide (user_id IS NULL) counterpart to DELETE /positions
    above - the automated Strategy-driven flow's own positions/groups,
    which the user-scoped route can never touch (same reason GET /positions
    can't see them - see GET /positions/platform's own docstring). Without
    this there was no way to clear a Strategy-driven test position at all:
    confirmed live 2026-08-27 - a user's "Clear positions" click reported
    success but a platform position kept reappearing on refresh, because it
    was never actually in scope to begin with. Same clear-both-tables-
    together reasoning as DELETE /positions."""
    positions_deleted = db.query(db_models.Position).filter_by(user_id=None).delete()
    option_groups_deleted = db.query(db_models.OptionPositionGroup).filter_by(user_id=None).delete()
    db.commit()
    return {"positions_deleted": positions_deleted, "option_groups_deleted": option_groups_deleted}
