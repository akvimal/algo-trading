import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.adapters.accounts.client import user_has_dhan_credentials
from app.adapters.db import models as db_models
from app.adapters.db.session import get_db
from app.adapters.quotes.client import get_ltp_batch
from app.adapters.signal_engine.client import NOT_FOUND, UNAVAILABLE, lookup_strategy
from app.auth import User, get_current_user, require_admin
from app.config import settings
from app.domain.equity_history import record_reset_point
from app.domain.live_gate import CONSENT_VERSION, format_problems, unmet_requirements
from app.domain.models import AccountUpdate, AdminResetAllConfirm, StrategyAccountCreate, StrategyAccountUpdate
from app.domain.position_manager import compute_unrealized_pnl, get_live_trading_status, load_account

router = APIRouter()

_SEGMENTS = ("NSE", "MCX", "CRYPTO")


def _as_float(v) -> Optional[float]:
    return float(v) if v is not None else None


def _apply_live_fields(
    row,
    update,
    *,
    segment: str,
    token: str,
    check_credentials: bool,
    extra_transition_problems: Optional[list] = None,
) -> None:
    """Applies live_trading_enabled / max_order_value / max_daily_loss to
    `row` through the live-trading gate (app/domain/live_gate.py), records
    consent on the off->on transition, and raises a 422 listing EVERYTHING
    that is unmet. Mutates `row` but never commits, so a rejected request
    leaves nothing behind (the caller's session is discarded).

    Used by the personal-account and strategy-account routes. The caps are
    applied first because the gate judges the EFFECTIVE state after this
    update (so a request that enables live and sets the caps in one go
    works, and one that blanks the caps on a live account does not)."""
    was_live = bool(row.live_trading_enabled)
    will_be_live = was_live if update.live_trading_enabled is None else bool(update.live_trading_enabled)
    if "max_order_value" in update.model_fields_set:
        row.max_order_value = update.max_order_value
    if "max_daily_loss" in update.model_fields_set:
        row.max_daily_loss = update.max_daily_loss

    if will_be_live:
        transition = not was_live
        has_creds = user_has_dhan_credentials(token) if (transition and check_credentials) else True
        problems = unmet_requirements(
            segment=segment,
            max_order_value=_as_float(row.max_order_value),
            max_daily_loss=_as_float(row.max_daily_loss),
            kill_switch_on=settings.live_trading_kill_switch,
            is_transition_to_live=transition,
            consent_given=bool(update.live_trading_consent),
            has_broker_credentials=has_creds,
            check_credentials=check_credentials,
        )
        if transition and extra_transition_problems:
            problems.extend(extra_transition_problems)
        if problems:
            raise HTTPException(status_code=422, detail=format_problems(problems))
        if transition:
            row.live_trading_consent_at = datetime.now(timezone.utc)
            row.live_trading_consent_version = CONSENT_VERSION
    row.live_trading_enabled = will_be_live


def _unrealized_pnl(db: Session, open_positions: list) -> float:
    """Live mark-to-market sum across `open_positions` (already filtered to
    status='OPEN' by the caller) - 0.0 for none, or if every quote fetch
    fails (compute_unrealized_pnl silently drops those, same convention
    the Positions grid's own with_live_pnl already uses). Includes option
    legs too (each Position row, spot/future/option alike, carries its own
    action/entry_price/quantity that compute_pnl works off generically) -
    a simplification for an account-level summary figure: it sums each
    leg's own mark-to-market independently rather than netting a spread's
    combined premium the way OptionPositionGroup's own SL/target
    monitoring does, so it can differ slightly from what a 2-leg group's
    own live P&L shows elsewhere."""
    if not open_positions:
        return 0.0
    mtm = compute_unrealized_pnl(open_positions, get_ltp_batch)
    return sum(pnl for _, pnl in mtm.values())


def _to_out(db: Session, row: db_models.Account) -> dict:
    open_positions = db.query(db_models.Position).filter_by(user_id=row.user_id, segment=row.segment, status="OPEN").all()
    return {
        "segment": row.segment,
        "starting_balance": float(row.starting_balance),
        "current_balance": float(row.current_balance),
        # Realized P&L is just current_balance vs. where it started - no
        # separate ledger, matches the delta the Dedicated strategy
        # accounts table already computes client-side today.
        "realized_pnl": float(row.current_balance) - float(row.starting_balance),
        "unrealized_pnl": _unrealized_pnl(db, open_positions),
        "capital_per_trade": float(row.capital_per_trade),
        "risk_per_trade_pct": float(row.risk_per_trade_pct),
        "min_reward_risk_ratio": float(row.min_reward_risk_ratio),
        "enforce_risk_based_lots": row.enforce_risk_based_lots,
        "leverage": float(row.leverage),
        "leverage_buffer_pct": float(row.leverage_buffer_pct),
        "mtf_annual_interest_rate_pct": float(row.mtf_annual_interest_rate_pct) if row.mtf_annual_interest_rate_pct is not None else None,
        "square_off_time": row.square_off_time.isoformat() if row.square_off_time is not None else None,
        "live_trading_enabled": row.live_trading_enabled,
        "live_trading_consent_at": row.live_trading_consent_at.isoformat() if row.live_trading_consent_at is not None else None,
        "require_stop_loss": bool(row.require_stop_loss),
        "apply_charges": bool(row.apply_charges),
        "slippage_bps": float(row.slippage_bps),
        "max_order_value": float(row.max_order_value) if row.max_order_value is not None else None,
        "max_daily_loss": float(row.max_daily_loss) if row.max_daily_loss is not None else None,
        # A user's own declared execution timeframe for this segment + its
        # higher-TF pairing - see app/domain/models.py's AccountOut.
        "default_interval": row.default_interval,
        "default_higher_interval": row.default_higher_interval,
        "updated_at": row.updated_at.isoformat(),
    }


@router.get("/accounts")
def list_accounts(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """One row per segment - always exactly NSE/MCX/CRYPTO, one per SaaS
    user (created lazily with sensible defaults - see load_account - the
    first time each is touched, so a brand-new signup always sees all 3
    immediately rather than 404ing until they've placed a trade)."""
    rows = {seg: load_account(db, user.id, seg) for seg in _SEGMENTS}
    return [_to_out(db, rows[s]) for s in _SEGMENTS if rows[s] is not None]


@router.put("/accounts/{segment}")
def update_account(segment: str, update: AccountUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """starting_balance/capital_per_trade/risk_per_trade_pct/
    min_reward_risk_ratio/enforce_risk_based_lots/leverage/
    leverage_buffer_pct/mtf_annual_interest_rate_pct/square_off_time are
    editable here. Setting starting_balance also re-baselines
    current_balance to match (see AccountUpdate's own docstring) - use
    POST /accounts/{segment}/reset instead if you just want
    current_balance restored to whatever starting_balance ALREADY is,
    a deliberately separate action so it's never a side effect of a
    sizing tweak. square_off_time is the one field where `null` is itself
    a meaningful value (never force-close, e.g. CRYPTO), not just "leave
    unchanged" - model_fields_set distinguishes an explicit
    {"square_off_time": null} from the key being omitted entirely, same
    pattern signal-generation's update_strategy uses for fixed_lots.
    default_interval/default_higher_interval follow the same
    model_fields_set-distinguished pattern - an explicit null clears a
    previously-set default rather than leaving it unchanged. Personal
    account only - see app/domain/models.py's AccountUpdate."""
    row = load_account(db, user.id, segment.upper())
    if row is None:
        raise HTTPException(status_code=404, detail=f"no account for segment {segment}")
    if update.starting_balance is not None:
        row.starting_balance = update.starting_balance
        row.current_balance = update.starting_balance
        # Re-baselining starts a new equity curve (app/domain/equity_history.py).
        record_reset_point(db, row)
    if update.capital_per_trade is not None:
        row.capital_per_trade = update.capital_per_trade
    if update.risk_per_trade_pct is not None:
        row.risk_per_trade_pct = update.risk_per_trade_pct
    if update.min_reward_risk_ratio is not None:
        row.min_reward_risk_ratio = update.min_reward_risk_ratio
    if update.enforce_risk_based_lots is not None:
        row.enforce_risk_based_lots = update.enforce_risk_based_lots
    if update.leverage is not None:
        row.leverage = update.leverage
    if update.leverage_buffer_pct is not None:
        row.leverage_buffer_pct = update.leverage_buffer_pct
    if "mtf_annual_interest_rate_pct" in update.model_fields_set:
        row.mtf_annual_interest_rate_pct = update.mtf_annual_interest_rate_pct
    if "square_off_time" in update.model_fields_set:
        row.square_off_time = update.square_off_time
    # Real-money order placement goes through the live-trading gate
    # (app/domain/live_gate.py): consent, caps and broker credentials.
    _apply_live_fields(row, update, segment=segment.upper(), token=user.token, check_credentials=True)
    if update.require_stop_loss is not None:
        row.require_stop_loss = update.require_stop_loss
    if update.apply_charges is not None:
        row.apply_charges = update.apply_charges
    if update.slippage_bps is not None:
        row.slippage_bps = update.slippage_bps
    if "default_interval" in update.model_fields_set:
        row.default_interval = update.default_interval
    if "default_higher_interval" in update.model_fields_set:
        row.default_higher_interval = update.default_higher_interval
    db.commit()
    db.refresh(row)
    return _to_out(db, row)


@router.get("/accounts/platform")
def list_platform_accounts(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Admin-only view of the platform-wide (user_id IS NULL) accounts -
    the rows the automated Strategy-driven flow actually reads (see
    load_account's own docstring). Distinct from GET /accounts above,
    which always returns the CALLER's own per-user rows - there was
    previously no route at all that could read or write these, forcing a
    raw `make psql` UPDATE to configure e.g. NSE MTF leverage/interest.
    See docs/architecture.md's "Positional spot holding + NSE MTF" section."""
    rows = {seg: load_account(db, None, seg) for seg in _SEGMENTS}
    return [_to_out(db, rows[s]) for s in _SEGMENTS if rows[s] is not None]


@router.put("/accounts/platform/{segment}")
def update_platform_account(
    segment: str, update: AccountUpdate, admin: User = Depends(require_admin), db: Session = Depends(get_db)
):
    """Same field-by-field update as PUT /accounts/{segment} above
    (including the starting_balance re-baselining behavior - see
    AccountUpdate's own docstring), just against the platform-wide row
    (user_id IS NULL) instead of the caller's own - the only route that
    can write it. Admin-gated since this is broker/platform config
    (leverage, MTF interest rate, etc.), not a per-SaaS-user setting -
    see the per-Strategy use_margin field (signal-generation) for how a
    strategy opts into it."""
    row = load_account(db, None, segment.upper())
    if row is None:
        raise HTTPException(status_code=404, detail=f"no platform account for segment {segment}")
    if update.starting_balance is not None:
        row.starting_balance = update.starting_balance
        row.current_balance = update.starting_balance
    if update.capital_per_trade is not None:
        row.capital_per_trade = update.capital_per_trade
    if update.risk_per_trade_pct is not None:
        row.risk_per_trade_pct = update.risk_per_trade_pct
    if update.min_reward_risk_ratio is not None:
        row.min_reward_risk_ratio = update.min_reward_risk_ratio
    if update.enforce_risk_based_lots is not None:
        row.enforce_risk_based_lots = update.enforce_risk_based_lots
    if update.leverage is not None:
        row.leverage = update.leverage
    if update.leverage_buffer_pct is not None:
        row.leverage_buffer_pct = update.leverage_buffer_pct
    if "mtf_annual_interest_rate_pct" in update.model_fields_set:
        row.mtf_annual_interest_rate_pct = update.mtf_annual_interest_rate_pct
    if "square_off_time" in update.model_fields_set:
        row.square_off_time = update.square_off_time
    # The platform (user_id IS NULL) account can never place real orders: the
    # automated live path needs a live_trading_user_id, which only a dedicated
    # strategy account has (see position_manager's capital_account handling),
    # so enabling the flag here would be misleading at best. Turning it OFF
    # (or leaving it) is always fine; the caps stay editable.
    if update.live_trading_enabled:
        raise HTTPException(
            status_code=422,
            detail="the platform account cannot trade live - opt a dedicated strategy account into live trading instead",
        )
    if update.live_trading_enabled is not None:
        row.live_trading_enabled = False
    if "max_order_value" in update.model_fields_set:
        row.max_order_value = update.max_order_value
    if "max_daily_loss" in update.model_fields_set:
        row.max_daily_loss = update.max_daily_loss
    db.commit()
    db.refresh(row)
    return _to_out(db, row)


@router.get("/live-trading/status")
def live_trading_status(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Live-broker-adapter status-check helper (see docs/architecture.md) -
    "is X actually live right now, and if not, why not" across every
    account and strategy_accounts row, without placing an order or calling
    out to market-data/Dhan at all. Admin-gated: this spans every user's
    own accounts plus the platform-wide one, same reasoning
    GET /accounts/platform above is admin-only rather than per-user
    scoped. See get_live_trading_status's own docstring for the exact
    "effectively_live"/"reason" semantics."""
    return get_live_trading_status(db)


@router.post("/admin/users/{user_id}/reset-all")
def reset_user_accounts_and_trades(
    user_id: str, payload: AdminResetAllConfirm, admin: User = Depends(require_admin), db: Session = Depends(get_db)
):
    """Wipes every position/option group (open and closed) belonging to
    ONE user, or the platform's own Strategy-driven rows if `user_id` is
    the literal "platform" (same special path-segment convention as
    GET/PUT /accounts/platform and DELETE /positions/platform) - never
    another user's data. Also resets that scope's account balances
    (current_balance) back to starting_balance. Leaves account CONFIG
    (capital_per_trade, leverage, square_off_time, etc.) untouched -
    only trade data + balances.

    broker_orders/trade_images are deleted first since they reference
    positions/option_position_groups without ON DELETE CASCADE
    (position_pnl_snapshots/option_group_pnl_snapshots DO cascade
    automatically once positions/option_position_groups themselves are
    deleted). trade_images has no user_id of its own - scoped via
    whichever position/group it's attached to instead.

    Requires the literal {"confirm": "RESET"} body (AdminResetAllConfirm)
    - a 422 on anything else, given the blast radius even at single-user
    scope. strategy_accounts (per-strategy capital pools) has no user_id
    of its own - only reset when user_id == "platform", since a strategy
    isn't owned by any one SaaS user."""
    if user_id == "platform":
        target_id: Optional[uuid.UUID] = None
    else:
        try:
            target_id = uuid.UUID(user_id)
        except ValueError:
            raise HTTPException(status_code=404, detail=f"no such user '{user_id}'")

    position_ids = db.query(db_models.Position.id).filter_by(user_id=target_id)
    group_ids = db.query(db_models.OptionPositionGroup.id).filter_by(user_id=target_id)

    broker_orders_deleted = db.query(db_models.BrokerOrder).filter_by(user_id=target_id).delete(synchronize_session=False)
    trade_images_deleted = (
        db.query(db_models.TradeImage)
        .filter(db_models.TradeImage.position_id.in_(position_ids) | db_models.TradeImage.option_group_id.in_(group_ids))
        .delete(synchronize_session=False)
    )
    positions_deleted = db.query(db_models.Position).filter_by(user_id=target_id).delete(synchronize_session=False)
    option_groups_deleted = (
        db.query(db_models.OptionPositionGroup).filter_by(user_id=target_id).delete(synchronize_session=False)
    )

    accounts_reset = (
        db.query(db_models.Account)
        .filter_by(user_id=target_id)
        .update({db_models.Account.current_balance: db_models.Account.starting_balance}, synchronize_session=False)
    )
    if target_id is not None:
        # A reset starts a new equity curve for each of that user's accounts.
        for reset_account_row in db.query(db_models.Account).filter_by(user_id=target_id).all():
            record_reset_point(db, reset_account_row)
    strategy_accounts_reset = 0
    if target_id is None:
        strategy_accounts_reset = db.query(db_models.StrategyAccount).update(
            {db_models.StrategyAccount.current_balance: db_models.StrategyAccount.starting_balance},
            synchronize_session=False,
        )

    db.commit()
    return {
        "user_id": user_id,
        "broker_orders_deleted": broker_orders_deleted,
        "trade_images_deleted": trade_images_deleted,
        "positions_deleted": positions_deleted,
        "option_groups_deleted": option_groups_deleted,
        "accounts_reset": accounts_reset,
        "strategy_accounts_reset": strategy_accounts_reset,
    }


@router.post("/accounts/{segment}/reset")
def reset_account(segment: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Resets current_balance back to starting_balance - does not touch
    capital_per_trade/risk_per_trade_pct or any positions. A manual reset
    for testing, same spirit as DELETE /positions but decoupled from it."""
    row = load_account(db, user.id, segment.upper())
    if row is None:
        raise HTTPException(status_code=404, detail=f"no account for segment {segment}")
    row.current_balance = row.starting_balance
    record_reset_point(db, row)
    db.commit()
    db.refresh(row)
    return _to_out(db, row)


# --- Optional per-strategy account override (execution.strategy_accounts) -
# see that table's own comment in infra/postgres/init/02-execution.sql and
# app/domain/position_manager.py's load_capital_account for the full
# design: a strategy with a row here sizes/tracks P&L against it instead of
# its segment's shared account above; every strategy without one keeps
# sharing the segment account exactly as before this existed. -----------


def _strategy_account_to_out(db: Session, row: db_models.StrategyAccount) -> dict:
    open_positions = db.query(db_models.Position).filter_by(strategy_id=row.strategy_id, segment=row.segment, status="OPEN").all()
    return {
        "strategy_id": str(row.strategy_id),
        "segment": row.segment,
        "starting_balance": float(row.starting_balance),
        "current_balance": float(row.current_balance),
        "realized_pnl": float(row.current_balance) - float(row.starting_balance),
        "unrealized_pnl": _unrealized_pnl(db, open_positions),
        "capital_per_trade": float(row.capital_per_trade),
        "risk_per_trade_pct": float(row.risk_per_trade_pct),
        "live_trading_user_id": str(row.live_trading_user_id) if row.live_trading_user_id is not None else None,
        "live_trading_enabled": row.live_trading_enabled,
        "live_trading_consent_at": row.live_trading_consent_at.isoformat() if row.live_trading_consent_at is not None else None,
        "max_order_value": float(row.max_order_value) if row.max_order_value is not None else None,
        "max_daily_loss": float(row.max_daily_loss) if row.max_daily_loss is not None else None,
        "updated_at": row.updated_at.isoformat(),
    }


def _can_see_strategy_account(row, user: User) -> bool:
    """Admins see every dedicated account; anyone else sees the ones they own
    (the strategy's creator) or are named as the live-trading user on. A row
    with no owner (platform/legacy) is therefore admin-only, plus its live
    user if it has one."""
    return user.is_admin or user.id == row.owner_user_id or user.id == row.live_trading_user_id


def _strategy_account_or_404(db: Session, strategy_id: str, user: User) -> db_models.StrategyAccount:
    """One 404 for "no such account" and "not yours", so the existence of
    someone else's account is not disclosed (same rule as signal-engine's
    ownership scoping)."""
    not_found = HTTPException(status_code=404, detail=f"no dedicated account for strategy {strategy_id}")
    try:
        strategy_uuid = uuid.UUID(strategy_id)
    except ValueError:
        raise not_found
    row = db.get(db_models.StrategyAccount, strategy_uuid)
    if row is None or not _can_see_strategy_account(row, user):
        raise not_found
    return row


@router.get("/accounts/strategy")
def list_strategy_accounts(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(db_models.StrategyAccount)
    if not user.is_admin:
        q = q.filter(or_(db_models.StrategyAccount.owner_user_id == user.id, db_models.StrategyAccount.live_trading_user_id == user.id))
    return [_strategy_account_to_out(db, r) for r in q.all()]


@router.get("/accounts/strategy/{strategy_id}")
def get_strategy_account(strategy_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _strategy_account_to_out(db, _strategy_account_or_404(db, strategy_id, user))


@router.post("/accounts/strategy/{strategy_id}")
def create_strategy_account(
    strategy_id: str, create: StrategyAccountCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """starting_balance seeds current_balance too, same as
    execution.accounts' own seed INSERT does for the segment accounts.
    409s on an existing row - PUT is how you edit one, this is create-only,
    same split GET/POST/PUT has for the segment routes above.

    A dedicated account changes how a strategy's trades are sized, so it may
    only be created for a strategy the caller can see - checked with
    signal-engine using the caller's own token (never a client-supplied
    claim). The row is owned by the strategy's creator; fails closed (503)
    when signal-engine cannot be asked."""
    try:
        strategy_uuid = uuid.UUID(strategy_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="strategy not found")
    lookup = lookup_strategy(strategy_id, user.token)
    if lookup.status == UNAVAILABLE:
        raise HTTPException(status_code=503, detail="could not verify the strategy with signal-engine - try again shortly")
    if lookup.status == NOT_FOUND:
        raise HTTPException(status_code=404, detail="strategy not found")
    # A platform strategy has no creator: an admin's account for it stays
    # unowned (admin-only), anyone else who could see it becomes the owner so
    # they can still reach what they just created.
    owner = uuid.UUID(lookup.created_by) if lookup.created_by else (None if user.is_admin else user.id)
    if db.get(db_models.StrategyAccount, strategy_uuid) is not None:
        raise HTTPException(status_code=409, detail=f"strategy {strategy_id} already has a dedicated account")
    row = db_models.StrategyAccount(
        strategy_id=strategy_uuid,
        owner_user_id=owner,
        segment=create.segment,
        starting_balance=create.starting_balance,
        current_balance=create.starting_balance,
        capital_per_trade=create.capital_per_trade,
        risk_per_trade_pct=create.risk_per_trade_pct,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _strategy_account_to_out(db, row)


@router.put("/accounts/strategy/{strategy_id}")
def update_strategy_account(
    strategy_id: str,
    update: StrategyAccountUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Live-broker-adapter P3 item 14 (see docs/architecture.md) -
    live_trading_user_id/live_trading_enabled/max_order_value/
    max_daily_loss are the only way to opt an automated Strategy into
    placing REAL orders; every other strategy stays paper-only forever
    (the shared platform account has no such fields at all). Enforces the
    DB's own "live_trading_enabled requires live_trading_user_id" CHECK
    here too, with a clean 422 - considers both what's already stored AND
    what this same request is changing, so either order (set the user id
    first, or in the same call as enabling) works."""
    row = _strategy_account_or_404(db, strategy_id, user)
    if update.capital_per_trade is not None:
        row.capital_per_trade = update.capital_per_trade
    if update.risk_per_trade_pct is not None:
        row.risk_per_trade_pct = update.risk_per_trade_pct
    previous_live_user = row.live_trading_user_id
    if "live_trading_user_id" in update.model_fields_set:
        row.live_trading_user_id = uuid.UUID(update.live_trading_user_id) if update.live_trading_user_id else None
    will_be_live = row.live_trading_enabled if update.live_trading_enabled is None else bool(update.live_trading_enabled)
    turning_on = will_be_live and not row.live_trading_enabled
    retargeting = row.live_trading_user_id is not None and row.live_trading_user_id != previous_live_user
    live_edit = will_be_live and any(
        k in update.model_fields_set for k in ("live_trading_enabled", "live_trading_user_id", "max_order_value", "max_daily_loss")
    )
    # Real orders on someone's broker account: only that person (or, for
    # edits to an ALREADY-live account, an admin) may touch the live settings.
    # And turning live ON, or pointing it at a different person, must be done
    # by that person themselves - only they can consent, and only their own
    # saved broker credentials can be verified from here.
    if (turning_on or retargeting) and row.live_trading_user_id != user.id:
        raise HTTPException(
            status_code=403,
            detail="real orders can only be pointed at your own broker account - the person named as live_trading_user_id must enable live trading themselves",
        )
    if live_edit and not turning_on and not user.is_admin and row.live_trading_user_id != user.id:
        raise HTTPException(status_code=403, detail="only the live trading user or an admin can change live-trading settings on this account")
    if will_be_live and row.live_trading_user_id is None:
        raise HTTPException(status_code=422, detail="live_trading_enabled requires live_trading_user_id to be set")
    _apply_live_fields(row, update, segment=row.segment, token=user.token, check_credentials=True)
    db.commit()
    db.refresh(row)
    return _strategy_account_to_out(db, row)


@router.delete("/accounts/strategy/{strategy_id}")
def delete_strategy_account(strategy_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Removing the override doesn't touch any already-open position/group
    - they keep resolving against whatever account they were opened
    against (load_capital_account is called fresh at open/close time, not
    stored on the position) only going forward does the strategy fall back
    to sharing its segment account again."""
    row = _strategy_account_or_404(db, strategy_id, user)
    db.delete(row)
    db.commit()
    return {"status": "deleted", "strategy_id": strategy_id}


@router.post("/accounts/strategy/{strategy_id}/reset")
def reset_strategy_account(strategy_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _strategy_account_or_404(db, strategy_id, user)
    row.current_balance = row.starting_balance
    db.commit()
    db.refresh(row)
    return _strategy_account_to_out(db, row)
