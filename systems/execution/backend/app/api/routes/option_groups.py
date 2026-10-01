"""Multi-leg option position groups (Phase 4d of the options trading
module - see docs/architecture.md). Mirrors positions.py's route
shapes/status-code conventions 1:1 - see there for the spot/future
equivalents this parallels."""

import functools
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.adapters.quotes.client import (
    get_candle_history,
    get_expiry_list,
    get_ltp_batch,
    get_lot_size,
    get_option_chain,
    resolve_symbol_by_security_id,
    resolve_underlying,
)
from app.auth import User, get_current_user, require_admin
from app.domain import stop_rules
from app.domain.models import (
    AutoTrailUpdate,
    CombinedStopLossUpdate,
    CombinedTargetUpdate,
    ManualOptionPositionCreate,
    NotesUpdate,
    OptionLegPreview,
    ReviewSubmit,
    SpotStopLossUpdate,
    SpotTargetUpdate,
    SquareOffTimeUpdate,
    TradeTagsUpdate,
)
from app.domain.option_position_manager import (
    OptionLegPreviewError,
    check_option_group_exits,
    compute_group_unrealized_pnl,
    legs_by_group,
    open_manual_option_group,
    set_group_auto_trail,
    preview_option_legs,
    square_off_all_open_option_groups,
    square_off_due_option_groups,
    square_off_option_group,
    submit_option_group_review,
    update_group_notes,
    update_group_tags,
    update_group_spot_stop_loss,
    update_group_spot_target,
    update_group_square_off_time,
    update_group_stop_loss,
    update_group_target,
)
from app.domain.position_manager import load_settings

router = APIRouter()


def _authorized_owner_id(row_user_id: Optional[uuid.UUID], user: User) -> uuid.UUID | None:
    """Option-group counterpart to positions.py's identical helper - see
    that one's own docstring for the full reasoning."""
    if row_user_id == user.id:
        return user.id
    if row_user_id is None and user.is_admin:
        return None
    raise HTTPException(status_code=404, detail="option group not found")


def _group_to_out(
    row: db_models.OptionPositionGroup,
    legs: list[dict],
    live_combined_price: Optional[float] = None,
    unrealized_pnl: Optional[float] = None,
    live_spot_price: Optional[float] = None,
) -> dict:
    return {
        "id": str(row.id),
        "signal_id": str(row.signal_id),
        # None = manually opened (Manual tab, no auto-provisioned Strategy
        # as of 2026-08-14) - same as positions.py's _position_to_out.
        "strategy_id": str(row.strategy_id) if row.strategy_id is not None else None,
        "underlying_symbol": row.underlying_symbol,
        "exchange": row.exchange,
        "segment": row.segment,
        "strategy_type": row.strategy_type,
        "action": row.action,
        "horizon": row.horizon,
        "quantity": float(row.quantity) if row.quantity is not None else None,
        "net_debit": float(row.net_debit) if row.net_debit is not None else None,
        # The two legs' own strike difference, frozen at open - null for naked, and for any group
        # opened before this column existed (migrations/029-option-group-strike-width.sql). Lets
        # the frontend recover a spread's theoretical max profit/loss - see
        # option_position_manager's _spread_sizing_basis for the identical debit/credit split.
        "strike_width": float(row.strike_width) if row.strike_width is not None else None,
        "combined_stop_loss_price": float(row.combined_stop_loss_price) if row.combined_stop_loss_price is not None else None,
        "combined_target_price": float(row.combined_target_price) if row.combined_target_price is not None else None,
        "sl_scope": row.sl_scope,
        "entry_spot_price": float(row.entry_spot_price) if row.entry_spot_price is not None else None,
        "spot_stop_loss_price": float(row.spot_stop_loss_price) if row.spot_stop_loss_price is not None else None,
        # Server-enforced take-profit on the underlying's own price (the
        # Live Chart panel's Target field for an option order) - sibling of
        # spot_stop_loss_price, see _evaluate_option_group_exits.
        "spot_target_price": float(row.spot_target_price) if row.spot_target_price is not None else None,
        # Non-null only for an auto-computed (stop_loss_method='indicator')
        # spot_stop_loss_price - see open_option_group/
        # _evaluate_option_group_exits. A user-set one (PUT
        # /option-groups/{id}/stop-loss) leaves all of these null and stays
        # checked against the underlying's own spot LTP instead.
        "spot_stop_loss_trailing_enabled": row.spot_stop_loss_trailing_enabled,
        "spot_stop_loss_indicator_type": row.spot_stop_loss_indicator_type,
        "stop_loss_future_symbol": row.stop_loss_future_symbol,
        "live_combined_price": live_combined_price,
        # Fresh underlying LTP (with_live_pnl=true only) - distinct from
        # entry_spot_price (frozen at open) - lets the UI show "how far is
        # spot from my stop" while setting/reviewing spot_stop_loss_price.
        "live_spot_price": live_spot_price,
        "unrealized_pnl": unrealized_pnl,
        "status": row.status,
        "rejection_reason": row.rejection_reason,
        "exit_reason": row.exit_reason,
        "pnl": float(row.pnl) if row.pnl is not None else None,
        "square_off_time": row.square_off_time.isoformat() if row.square_off_time is not None else None,
        # Named entry_time/exit_time (not created_at) to match
        # positions.py's _position_to_out - the frontend's date filter and
        # Orders-grid sort reuse the same field names across both.
        "entry_time": row.created_at.isoformat() if row.created_at is not None else None,
        "exit_time": row.exit_time.isoformat() if row.exit_time is not None else None,
        # Delta Exchange trading-fee simulation (app/domain/delta_fees.py) -
        # CRYPTO only, null for NSE/MCX groups.
        "open_fee": float(row.open_fee) if row.open_fee is not None else None,
        "close_fee": float(row.close_fee) if row.close_fee is not None else None,
        # Indian brokerage/STT/exchange/SEBI/stamp/GST netted into pnl at close (NSE/MCX, when the
        # account has apply_charges): the total and its breakdown + schedule version. None = none applied.
        "charges": float(row.charges) if row.charges is not None else None,
        "charges_detail": row.charges_detail,
        "slippage_cost": float(row.slippage_cost) if row.slippage_cost is not None else None,
        # Trade discipline checklist (Manual tab only) - null for every
        # Strategy-driven group, see infra/postgres/init/02-execution.sql's
        # own comment on these 4 columns.
        "plan_checklist": row.plan_checklist,
        "reviewed_at": row.reviewed_at.isoformat() if row.reviewed_at is not None else None,
        "review_violation": row.review_violation,
        "review_notes": row.review_notes,
        "review_checklist": row.review_checklist,
        # Free-text journal note (PUT /option-groups/{id}/notes) - editable
        # any time from the Live Chart panel's History list. Not review_notes.
        "notes": row.notes,
        # Structured trade journal (PUT /option-groups/{id}/tags).
        "setup_tag": row.setup_tag,
        "confidence": row.confidence,
        # Immutable entry snapshot + auto-trade flag - see positions.py's
        # _position_to_out.
        "entry_setup_tag": row.entry_setup_tag,
        "entry_confidence": row.entry_confidence,
        "auto_traded": bool(row.auto_traded),
        # Chart interval this trade was placed on - see positions.py's
        # identical field on _position_to_out.
        "entry_interval": row.entry_interval,
        # 'market' | 'limit' | null - see execution.option_position_groups.order_type's own comment.
        "order_type": row.order_type,
        # Live Chart trade panel discipline flags - null for every
        # Strategy-driven group. See infra/postgres/init/02-execution.sql.
        "trend_followed": row.trend_followed,
        "risk_managed": row.risk_managed,
        "legs": legs,
    }


def _leg_dict(
    pos: db_models.Position, live_price: Optional[float] = None, live_unrealized_pnl: Optional[float] = None
) -> dict:
    return {
        "id": str(pos.id),
        "symbol": pos.symbol,
        "action": pos.action,
        "quantity": float(pos.quantity) if pos.quantity is not None else None,
        "entry_price": float(pos.entry_price),
        "exit_price": float(pos.exit_price) if pos.exit_price is not None else None,
        "pnl": float(pos.pnl) if pos.pnl is not None else None,
        "status": pos.status,
        # Only set when the group's own sl_scope='individual' - null (as
        # for every other option leg) in 'combined' mode.
        "stop_loss_price": float(pos.stop_loss_price) if pos.stop_loss_price is not None else None,
        "target_price": float(pos.target_price) if pos.target_price is not None else None,
        # with_live_pnl=true only - this leg's own live premium/P&L, not
        # just the group's combined figure. See compute_group_unrealized_pnl.
        "live_price": live_price,
        "unrealized_pnl": live_unrealized_pnl,
    }


def _query_option_groups(
    db: Session,
    user_id: Optional[uuid.UUID],
    status: Optional[str],
    signal_id: Optional[str],
    symbol: Optional[str],
    segment: Optional[str],
    manual_only: bool,
    limit: int,
    with_live_pnl: bool,
    token: Optional[str] = None,
    strategy_id: Optional[uuid.UUID] = None,
):
    """Shared by GET /option-groups (user_id=caller) and GET
    /option-groups/platform (user_id=None) - see positions.py's identical
    _query_positions for the reasoning (including `strategy_id`)."""
    q = db.query(db_models.OptionPositionGroup)
    q = q.filter_by(strategy_id=strategy_id) if strategy_id is not None else q.filter_by(user_id=user_id)
    if status:
        q = q.filter_by(status=status.upper())
    if signal_id:
        try:
            q = q.filter_by(signal_id=uuid.UUID(signal_id))
        except ValueError:
            return []
    if symbol:
        q = q.filter_by(underlying_symbol=symbol)
    if segment:
        q = q.filter_by(segment=segment)
    if manual_only:
        q = q.filter(db_models.OptionPositionGroup.strategy_id.is_(None))
    rows = q.order_by(db_models.OptionPositionGroup.created_at.desc()).limit(limit).all()

    legs = legs_by_group(db, rows)
    # A browser is polling this: value the caller's groups on THEIR OWN Dhan keys (their token).
    quote = functools.partial(get_ltp_batch, token=token) if token else get_ltp_batch
    mtm = compute_group_unrealized_pnl(rows, legs, quote) if with_live_pnl else {}

    result = []
    for r in rows:
        group_mtm = mtm.get(r.id)
        leg_mtm = group_mtm["legs"] if group_mtm else {}
        leg_dicts = [_leg_dict(pos, *leg_mtm.get(pos.id, (None, None))) for pos in legs.get(r.id, {}).values()]
        result.append(
            _group_to_out(
                r,
                leg_dicts,
                live_combined_price=group_mtm["combined_price"] if group_mtm else None,
                unrealized_pnl=group_mtm["unrealized_pnl"] if group_mtm else None,
                live_spot_price=group_mtm["spot_price"] if group_mtm else None,
            )
        )
    return result


@router.get("/option-groups")
def list_option_groups(
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
    """Always scoped to the caller's own groups (user_id=user.id), same
    isolation reasoning as GET /positions' own identical change (see
    GET /option-groups/platform below for how to see the automated
    Strategy-driven flow's own groups, user_id IS NULL).
    signal_id: exact match, for cross-system deep links, same as
    GET /positions. symbol (matched against underlying_symbol)/segment/
    manual_only: same ManualTab.tsx per-row trade-history backfill
    reasoning as GET /positions' own identical filters. with_live_pnl:
    mark-to-market OPEN groups against a fresh combined quote - off by
    default, same reasoning as GET /positions."""
    return _query_option_groups(db, user.id, status, signal_id, symbol, segment, manual_only, limit, with_live_pnl, token=user.token)


@router.get("/option-groups/platform")
def list_platform_option_groups(
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
    """Option-group counterpart to GET /positions/platform - see that
    route's own docstring for the full reasoning."""
    return _query_option_groups(db, None, status, signal_id, symbol, segment, manual_only, limit, with_live_pnl)


@router.get("/option-groups/{group_id}/pnl-history")
def get_option_group_pnl_history(group_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Oldest-first combined-premium unrealized-P&L time series - group-
    level counterpart to GET /positions/{id}/pnl-history, see that route's
    own docstring."""
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")
    owner = db.get(db_models.OptionPositionGroup, parsed_id)
    if owner is None:
        raise HTTPException(status_code=404, detail="option group not found")
    _authorized_owner_id(owner.user_id, user)
    rows = (
        db.query(db_models.OptionGroupPnlSnapshot)
        .filter_by(option_group_id=parsed_id)
        .order_by(db_models.OptionGroupPnlSnapshot.recorded_at)
        .all()
    )
    return [
        {"recorded_at": r.recorded_at.isoformat(), "combined_price": float(r.combined_price), "unrealized_pnl": float(r.unrealized_pnl)}
        for r in rows
    ]


@router.get("/option-groups/preview-legs", response_model=OptionLegPreview)
def preview_legs(
    segment: str,
    symbol: str,
    action: Literal["BUY", "SELL"],
    option_position_style: Literal["naked", "spread", "credit_spread"] = "spread",
    option_strike_moneyness: str = "ATM",
    expiry: Optional[str] = None,
    # Overrides the short/protection leg's own distance (in strikes) from
    # the primary leg - default (None) is option_templates.py's own
    # SPREAD_WIDTH_STRIKES. Ignored for option_position_style='naked'.
    spread_width: Optional[int] = None,
    # An explicit strike per leg, taking precedence over
    # option_strike_moneyness/spread_width entirely for its own leg - see
    # ManualOptionPositionCreate's identical fields.
    primary_strike: Optional[float] = None,
    second_strike: Optional[float] = None,
    user: User = Depends(get_current_user),
):
    """Read-only: the legs a real POST /option-groups/manual with these exact params would
    use, without placing anything - see option_position_manager.preview_option_legs's own
    docstring for why this can never drift from what actually gets placed. Backs the Scan
    page's bias-driven option panel: Bullish (action='BUY') or Bearish ('SELL') first, the
    real recommended strikes before committing to an order."""
    try:
        return preview_option_legs(
            segment, symbol, action, option_position_style, option_strike_moneyness, expiry,
            resolve_underlying,
            functools.partial(get_expiry_list, token=user.token),
            functools.partial(get_option_chain, token=user.token),
            resolve_symbol_by_security_id,
            functools.partial(get_ltp_batch, token=user.token),
            spread_width,
            primary_strike,
            second_strike,
        )
    except OptionLegPreviewError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/option-groups/manual")
def open_manual(payload: ManualOptionPositionCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The Manual tab (signal-generation's frontend) - option orders,
    bypassing signal-generation/signal-processing entirely (no
    auto-provisioned Strategy, unlike the pre-2026-08-14 design - see
    docs/architecture.md and open_manual_option_group's own docstring).
    Always 200/201 regardless of whether the result is OPEN or REJECTED,
    matching POST /positions/manual's own convention - a rejection is a
    legitimate persisted outcome, not an HTTP error.

    The discipline-checklist system is record-only here too - no daily-
    checklist 409 or plan-checklist 422 gate (removed 2026-09-03, same as
    POST /positions/manual - see that route's docstring)."""
    settings = load_settings(db, user.id)

    row = open_manual_option_group(
        user.id,
        payload.segment,
        payload.symbol,
        payload.action,
        payload.option_position_style,
        payload.option_strike_moneyness,
        payload.expiry,
        payload.sl_scope,
        payload.option_fixed_lots,
        settings,
        db,
        resolve_underlying,
        functools.partial(get_expiry_list, token=user.token),
        functools.partial(get_option_chain, token=user.token),
        functools.partial(get_ltp_batch, token=user.token),
        resolve_symbol_by_security_id,
        get_lot_size,
        payload.spread_width,
        payload.primary_strike,
        payload.second_strike,
        [a.model_dump() for a in payload.plan_checklist],
        payload.order_type,
        payload.square_off_time,
        payload.trend_followed,
        payload.risk_managed,
        payload.setup_tag,
        payload.confidence,
        payload.notes,
        payload.entry_interval,
        payload.auto_traded,
    )
    legs = legs_by_group(db, [row]).get(row.id, {})
    return _group_to_out(row, [_leg_dict(pos) for pos in legs.values()])


@router.put("/option-groups/{group_id}/review")
def review_group(group_id: str, payload: ReviewSubmit, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Option-group counterpart to PUT /positions/{id}/review - identical
    rules/status-codes, see that route's own docstring."""
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")

    row, reject_reason = submit_option_group_review(
        db, user.id, parsed_id, payload.violation, payload.notes, payload.accepted_loss, [a.model_dump() for a in payload.checklist]
    )
    if reject_reason == "option group not found":
        raise HTTPException(status_code=404, detail=reject_reason)
    if reject_reason == "must accept the loss before submitting this review":
        raise HTTPException(status_code=422, detail=reject_reason)
    if reject_reason is not None:
        raise HTTPException(status_code=409, detail=reject_reason)
    legs = legs_by_group(db, [row]).get(row.id, {})
    return _group_to_out(row, [_leg_dict(pos) for pos in legs.values()])


@router.put("/option-groups/{group_id}/stop-loss")
def edit_group_stop_loss(
    group_id: str, payload: CombinedStopLossUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Generically useful, not manual-only - editing combined SL on any
    already-open option group. 404 if missing or owned by another user,
    409 if not OPEN or not sl_scope='combined' (editing an individual
    leg's own SL isn't supported by this endpoint)."""
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")

    row = db.get(db_models.OptionPositionGroup, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="option group not found")
    owner_id = _authorized_owner_id(row.user_id, user)
    if row.status != "OPEN":
        raise HTTPException(status_code=409, detail=f"option group is {row.status}, not OPEN")
    if row.sl_scope != "combined":
        raise HTTPException(status_code=409, detail="only sl_scope='combined' groups support editing SL here")

    try:
        row = update_group_stop_loss(db, owner_id, parsed_id, payload.stop_loss_price)
    except stop_rules.StopWidenRefused as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    legs = legs_by_group(db, [row]).get(row.id, {})
    return _group_to_out(row, [_leg_dict(pos) for pos in legs.values()])


@router.put("/option-groups/{group_id}/target")
def edit_group_target(group_id: str, payload: CombinedTargetUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """edit_group_stop_loss's identical counterpart for combined_target_price - same
    404/409 shape. Backs the Scan page's %-of-max-profit target (see
    option_position_manager.update_group_target's own docstring) - attached right after a manual
    option order opens, the same post-open PUT pattern spot_stop_loss/spot_target already use."""
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")

    row = db.get(db_models.OptionPositionGroup, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="option group not found")
    owner_id = _authorized_owner_id(row.user_id, user)
    if row.status != "OPEN":
        raise HTTPException(status_code=409, detail=f"option group is {row.status}, not OPEN")
    if row.sl_scope != "combined":
        raise HTTPException(status_code=409, detail="only sl_scope='combined' groups support editing target here")

    row = update_group_target(db, owner_id, parsed_id, payload.target_price)
    legs = legs_by_group(db, [row]).get(row.id, {})
    return _group_to_out(row, [_leg_dict(pos) for pos in legs.values()])


@router.put("/option-groups/{group_id}/spot-stop-loss")
def edit_group_spot_stop_loss(
    group_id: str, payload: SpotStopLossUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """A stop on the UNDERLYING's own price - independent of sl_scope/the
    premium-based endpoint above, see update_group_spot_stop_loss's own
    docstring. 404/409 conventions match edit_group_stop_loss; no
    sl_scope restriction (a spot stop is orthogonal to how the premium
    side is monitored, so it's available regardless)."""
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")

    row = db.get(db_models.OptionPositionGroup, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="option group not found")
    owner_id = _authorized_owner_id(row.user_id, user)
    if row.status != "OPEN":
        raise HTTPException(status_code=409, detail=f"option group is {row.status}, not OPEN")

    atr_interval = payload.atr_interval or stop_rules.DEFAULT_ATR_INTERVAL
    context = stop_rules.fetch_context(
        functools.partial(get_ltp_batch, token=user.token),
        functools.partial(get_candle_history, token=user.token),
        row.stop_loss_future_exchange or row.exchange,
        row.stop_loss_future_symbol or row.underlying_symbol,
        atr_interval,
    )
    try:
        row = update_group_spot_stop_loss(db, owner_id, parsed_id, payload.spot_stop_loss_price, context=context, atr_interval=atr_interval)
    except stop_rules.StopWidenRefused as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    legs = legs_by_group(db, [row]).get(row.id, {})
    return _group_to_out(row, [_leg_dict(pos) for pos in legs.values()])


@router.put("/option-groups/{group_id}/auto-trail")
def edit_group_auto_trail(
    group_id: str, payload: AutoTrailUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """The one-tap auto-trail on an option group's spot stop - see set_group_auto_trail. 404 if missing or owned by another
    user, 409 if not OPEN, 422 if it cannot start (no spot stop yet, another trailing method, or no entry price recorded)."""
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")

    row = db.get(db_models.OptionPositionGroup, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="option group not found")
    owner_id = _authorized_owner_id(row.user_id, user)
    if row.status != "OPEN":
        raise HTTPException(status_code=409, detail=f"option group is {row.status}, not OPEN")

    row, reject_reason = set_group_auto_trail(db, owner_id, parsed_id, payload.enabled, payload.interval, payload.multiple)
    if reject_reason is not None:
        raise HTTPException(status_code=422, detail=reject_reason)
    legs = legs_by_group(db, [row]).get(row.id, {})
    return _group_to_out(row, [_leg_dict(pos) for pos in legs.values()])


@router.put("/option-groups/{group_id}/spot-target")
def edit_group_spot_target(
    group_id: str, payload: SpotTargetUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """A take-profit on the UNDERLYING's own price - the sibling of
    edit_group_spot_stop_loss above, same 404/409 conventions and same
    (lack of) sl_scope restriction. See update_group_spot_target."""
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")

    row = db.get(db_models.OptionPositionGroup, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="option group not found")
    owner_id = _authorized_owner_id(row.user_id, user)
    if row.status != "OPEN":
        raise HTTPException(status_code=409, detail=f"option group is {row.status}, not OPEN")

    row = update_group_spot_target(db, owner_id, parsed_id, payload.spot_target_price)
    legs = legs_by_group(db, [row]).get(row.id, {})
    return _group_to_out(row, [_leg_dict(pos) for pos in legs.values()])


@router.put("/option-groups/{group_id}/notes")
def edit_group_notes(
    group_id: str, payload: NotesUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Option-group counterpart to PUT /positions/{id}/notes - a free-text
    journal note shown/edited from the Live Chart panel's History list. No
    gate: OPEN or CLOSED, any number of edits, empty string clears it. 404
    if missing or owned by another user."""
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")

    row = db.get(db_models.OptionPositionGroup, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="option group not found")
    owner_id = _authorized_owner_id(row.user_id, user)

    row = update_group_notes(db, owner_id, parsed_id, payload.notes)
    if row is None:
        raise HTTPException(status_code=404, detail="option group not found")
    legs = legs_by_group(db, [row]).get(row.id, {})
    return _group_to_out(row, [_leg_dict(pos) for pos in legs.values()])


@router.put("/option-groups/{group_id}/tags")
def edit_group_tags(
    group_id: str, payload: TradeTagsUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Option-group counterpart to PUT /positions/{id}/tags - partial edit
    of setup_tag / confidence, no gate, OPEN or CLOSED. `setup_tag: ""`
    clears the tag. 404 if missing or owned by another user."""
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")

    row = db.get(db_models.OptionPositionGroup, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="option group not found")
    owner_id = _authorized_owner_id(row.user_id, user)

    sent = payload.model_dump(exclude_unset=True)
    row = update_group_tags(
        db,
        owner_id,
        parsed_id,
        setup_tag=payload.setup_tag,
        set_setup_tag="setup_tag" in sent,
        confidence=payload.confidence,
        set_confidence="confidence" in sent,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="option group not found")
    legs = legs_by_group(db, [row]).get(row.id, {})
    return _group_to_out(row, [_leg_dict(pos) for pos in legs.values()])


@router.put("/option-groups/{group_id}/square-off-time")
def edit_group_square_off_time(
    group_id: str, payload: SquareOffTimeUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Option-group counterpart to PUT /positions/{id}/square-off-time -
    identical rules/status-codes, see that route's own docstring."""
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")

    row = db.get(db_models.OptionPositionGroup, parsed_id)
    if row is None:
        raise HTTPException(status_code=404, detail="option group not found")
    owner_id = _authorized_owner_id(row.user_id, user)
    if row.status != "OPEN":
        raise HTTPException(status_code=409, detail=f"option group is {row.status}, not OPEN")

    row = update_group_square_off_time(db, owner_id, parsed_id, payload.square_off_time)
    legs = legs_by_group(db, [row]).get(row.id, {})
    return _group_to_out(row, [_leg_dict(pos) for pos in legs.values()])


@router.post("/option-groups/square-off")
def square_off_all_now(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Manual override - closes EVERY open option group BELONGING TO the
    caller immediately, same as POST /positions/square-off for spot/future."""
    return square_off_all_open_option_groups(db, user.id, functools.partial(get_ltp_batch, token=user.token))


@router.post("/option-groups/square-off-due")
def square_off_due_now(db: Session = Depends(get_db)):
    """Manual trigger - same logic the scheduled square-off job runs for
    option groups. Same KNOWN GAP as positions.py's identical route -
    deliberately cross-tenant, not scoped to the caller."""
    return square_off_due_option_groups(db, get_ltp_batch)


@router.post("/option-groups/check-exits")
def check_exits_now(db: Session = Depends(get_db)):
    """Manual trigger - same combined SL/target logic the exit-monitor
    job runs for option groups. Same KNOWN GAP as positions.py's
    identical route - deliberately cross-tenant."""
    return check_option_group_exits(db, get_ltp_batch, get_candle_history)


@router.post("/option-groups/{group_id}/square-off")
def square_off_one(group_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Closes exactly one OPEN option group (both legs) - 404/409/502
    conventions match POST /positions/{position_id}/square-off."""
    try:
        parsed_id = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="option group not found")

    group = db.get(db_models.OptionPositionGroup, parsed_id)
    if group is None:
        raise HTTPException(status_code=404, detail="option group not found")
    owner_id = _authorized_owner_id(group.user_id, user)

    result = square_off_option_group(db, owner_id, parsed_id, functools.partial(get_ltp_batch, token=user.token))
    if result["status"] == "not_found":
        raise HTTPException(status_code=404, detail="option group not found")
    if result["status"] == "not_open":
        raise HTTPException(status_code=409, detail=f"option group is {result['group_status']}, not OPEN")
    if result["status"] == "quote_unavailable":
        raise HTTPException(status_code=502, detail="could not fetch a live quote for one or both legs - still OPEN")
    return result
