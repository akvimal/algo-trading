"""Multi-leg option position lifecycle (Phase 4d of the options trading
module - see docs/architecture.md): opens a 1- or 2-leg option order
(signal-processing's fixed templates - bull_call_spread/bear_put_spread
for option_position_style='spread', naked_call/naked_put for 'naked') as
one execution.option_position_groups row plus 1 or 2 leg
execution.positions rows, sized against and monitored via a COMBINED
net-debit premium rather than either leg's own price. A naked (1-leg)
group is not a special case mathematically - see the trick below.

Deliberately a sibling to position_manager.py, not a modification of it -
position_manager.is_supported/open_position stay completely untouched
(zero regression risk to the existing spot/future path); every pure
function here that overlaps in shape (compute_pnl, the SL/target/
quantity formulas, _resolve_signal_conflicts, _accounts_by_segment,
_apply_realized_pnl, _quotes_by_exchange, load_account, load_settings,
is_within_intraday_window) is imported and reused as-is rather than
duplicated - same system, no cross-system-import concern.

Key trick, same one Phase 4c's option_backtest.py (signal-generation)
already established: a debit spread's combined premium (long leg price -
short leg price) behaves exactly like a single "BUY" position's price -
it rises as the position's own thesis plays out, regardless of which
template (bull_call_spread or bear_put_spread) produced it. A naked
position is the same identity with the short leg's price fixed at 0 (no
short leg at all) - combined premium = long leg's own price, so it's
still a "BUY" position throughout, no separate naked-specific math
anywhere below. Every group in this module always has exactly one BUY
leg (`legs_by_group()`'s 'BUY' key) and an OPTIONAL SELL leg (present for
'spread', absent for 'naked') - every function below treats the SELL leg
as Optional accordingly. So every combined SL/target/pnl calculation
reuses position_manager's existing BUY-direction formulas unchanged; the
group's own `action` field still records the REAL original signal
direction for reporting."""

import logging
import uuid
from datetime import datetime
from datetime import timezone as dt_timezone
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.domain.models import ExecutionSettings, ResolvedOrder
from app.domain.position_manager import (
    GetLotSize,
    GetLtpBatch,
    _accounts_by_segment,
    _apply_realized_pnl,
    _quotes_by_exchange,
    _resolve_signal_conflicts,
    compute_pnl,
    compute_quantity,
    compute_risk_based_quantity,
    compute_stop_loss_percent_price,
    compute_target_percent_price,
    is_within_intraday_window,
    load_account,
    load_settings,
)

logger = logging.getLogger(__name__)

# (exchange, security_id) -> trading symbol, or None if unresolvable -
# see market-data's GET /instruments/resolve-by-security-id.
ResolveSymbolBySecurityId = Callable[[str, str], Optional[str]]


def legs_by_group(db: Session, groups: list) -> dict:
    """group.id -> {'BUY': Position, 'SELL': Position} for every leg of
    every group in `groups`, one query regardless of how many groups -
    shared by every group-level function below and by the option-groups
    route (for listing legs alongside each group)."""
    if not groups:
        return {}
    group_ids = [g.id for g in groups]
    rows = db.query(db_models.Position).filter(db_models.Position.option_group_id.in_(group_ids)).all()
    result: dict = {}
    for pos in rows:
        result.setdefault(pos.option_group_id, {})[pos.action] = pos
    return result


def _reject_group(db: Session, order: ResolvedOrder, signal_id: uuid.UUID, reason: str) -> db_models.OptionPositionGroup:
    """No leg Position rows are created for a rejected group - mirrors
    position_manager._reject's 'never really opened' philosophy, just
    applied at the group level."""
    logger.info("rejecting option signal %s: %s", order.signal_id, reason)
    row = db_models.OptionPositionGroup(
        signal_id=signal_id,
        strategy_id=uuid.UUID(order.strategy_id),
        underlying_symbol=order.symbol,
        exchange=order.exchange,
        segment=order.segment,
        strategy_type=(order.strategy or {}).get("type", "unknown"),
        action=order.action,
        horizon=order.horizon,
        status="REJECTED",
        rejection_reason=reason,
    )
    db.add(row)
    return row


def open_option_group(
    order: ResolvedOrder,
    settings: ExecutionSettings,
    db: Session,
    get_ltp_batch: GetLtpBatch,
    resolve_symbol_by_security_id: ResolveSymbolBySecurityId,
    get_lot_size: GetLotSize,
) -> db_models.OptionPositionGroup:
    """Idempotent: a signal_id already processed (Redis redelivery) returns
    the existing group rather than double-opening. Rejects (own group row,
    status='REJECTED', no leg rows) for every unresolvable-at-open case -
    see the module docstring's scope notes and docs/architecture.md Phase
    4d for the full rejection list."""
    signal_id = uuid.UUID(order.signal_id)

    existing = db.query(db_models.OptionPositionGroup).filter_by(signal_id=signal_id).one_or_none()
    if existing is not None:
        logger.info("signal %s already processed (status=%s), skipping", order.signal_id, existing.status)
        return existing

    if order.horizon != "intraday":
        row = _reject_group(
            db, order, signal_id,
            f"unsupported horizon for options ({order.horizon}) - only intraday is handled in this phase",
        )
        db.commit()
        return row

    legs = (order.strategy or {}).get("legs") or []
    if len(legs) not in (1, 2):
        row = _reject_group(db, order, signal_id, f"expected 1 (naked) or 2 (spread) option legs, got {len(legs)}")
        db.commit()
        return row

    short_leg_dict: Optional[dict] = None
    if len(legs) == 1:
        if legs[0]["action"] != "BUY":
            # No margin/undefined-risk handling anywhere in this platform -
            # a naked SELL (writing/selling an uncovered option) is never a
            # valid template here, only naked BUY (long call/put).
            row = _reject_group(db, order, signal_id, "a single-leg (naked) option order must be a BUY leg")
            db.commit()
            return row
        long_leg_dict = legs[0]
    else:
        buy_legs = [leg for leg in legs if leg["action"] == "BUY"]
        sell_legs = [leg for leg in legs if leg["action"] == "SELL"]
        if len(buy_legs) != 1 or len(sell_legs) != 1:
            row = _reject_group(db, order, signal_id, "expected exactly one BUY leg and one SELL leg")
            db.commit()
            return row
        long_leg_dict, short_leg_dict = buy_legs[0], sell_legs[0]

    if order.square_off_time is None:
        row = _reject_group(db, order, signal_id, "intraday option order is missing square_off_time (contract violation)")
        db.commit()
        return row

    now = datetime.now(dt_timezone.utc)
    if not is_within_intraday_window(now, order.square_off_time, settings.timezone):
        row = _reject_group(
            db, order, signal_id, f"received outside intraday window (square-off is {order.square_off_time})"
        )
        db.commit()
        return row

    if order.stop_loss_method == "previous_candle":
        row = _reject_group(
            db, order, signal_id,
            "combined stop-loss only supports stop_loss_method='percent' for option strategies (got 'previous_candle')",
        )
        db.commit()
        return row

    account = load_account(db, order.segment)
    if account is None:
        row = _reject_group(db, order, signal_id, f"no paper-trading account configured for segment {order.segment}")
        db.commit()
        return row

    open_groups = db.query(db_models.OptionPositionGroup).filter_by(underlying_symbol=order.symbol, status="OPEN").all()
    groups_to_close, reject_reason = _resolve_signal_conflicts(open_groups, order)
    if reject_reason is not None:
        row = _reject_group(db, order, signal_id, reject_reason)
        db.commit()
        return row

    long_symbol = resolve_symbol_by_security_id(order.exchange, long_leg_dict["security_id"])
    short_symbol = resolve_symbol_by_security_id(order.exchange, short_leg_dict["security_id"]) if short_leg_dict else None
    if long_symbol is None or (short_leg_dict and short_symbol is None):
        row = _reject_group(db, order, signal_id, "could not resolve one or both option legs' security_id to a trading symbol")
        db.commit()
        return row

    symbols_to_quote = [long_symbol] + ([short_symbol] if short_symbol else [])
    quotes = get_ltp_batch(order.exchange, symbols_to_quote)
    long_premium = quotes.get(long_symbol)
    short_premium = quotes.get(short_symbol) if short_symbol else 0.0
    if long_premium is None or (short_symbol and short_premium is None):
        row = _reject_group(db, order, signal_id, "could not fetch a live quote for one or both option legs")
        db.commit()
        return row

    net_debit = long_premium - short_premium
    if net_debit <= 0:
        row = _reject_group(
            db, order, signal_id, f"combined net debit ({net_debit}) is not positive - can't size or monitor this spread"
        )
        db.commit()
        return row

    lot_size = get_lot_size(order.exchange, long_symbol)
    if lot_size is None:
        row = _reject_group(db, order, signal_id, f"could not determine lot size for {long_symbol} on {order.exchange}")
        db.commit()
        return row

    if groups_to_close:
        legs_to_close = legs_by_group(db, groups_to_close)
        for grp in groups_to_close:
            grp_legs = legs_to_close.get(grp.id)
            closed = (
                grp_legs is not None
                and "BUY" in grp_legs
                and _close_group_at_cmp(grp, grp_legs["BUY"], grp_legs.get("SELL"), get_ltp_batch, account, "counter_signal")
            )
            if not closed:
                row = _reject_group(
                    db, order, signal_id,
                    f"could not close conflicting option group {grp.id} (quote unavailable) - "
                    "counter_signal_policy='close_and_flip' requires closing it first",
                )
                db.commit()
                return row

    effective_capital = min(float(account.capital_per_trade), float(account.current_balance))
    if order.segment == "CRYPTO":
        # Same reasoning as position_manager.open_position - net_debit
        # (from Delta Exchange India) is raw USD, capital_per_trade/
        # current_balance are INR - convert the capital figure, never the
        # premiums, so long_premium/short_premium/net_debit stay in
        # native USD (still correctly comparable against future raw-USD
        # LTP fetches for exit-monitoring). settings.usdinr_rate is a
        # manually configured rate (GET/PUT /settings), not a live feed -
        # see docs/architecture.md.
        if settings.usdinr_rate is None:
            row = _reject_group(
                db, order, signal_id, "no USDINR rate configured - set one in Settings to size a CRYPTO option position"
            )
            db.commit()
            return row
        effective_capital = effective_capital / settings.usdinr_rate
    # option_fixed_lots (Strategy-level, options only) overrides auto-sizing
    # below entirely, but the balance check still runs against its real
    # cost, not a 1-lot minimum - a fixed count that's genuinely
    # unaffordable against current_balance still rejects cleanly, same
    # "paper trading still respects the simulated balance" reasoning every
    # other rejection case here already has.
    required_lots = order.option_fixed_lots if order.option_fixed_lots is not None else 1
    if effective_capital < net_debit * lot_size * required_lots:
        row = _reject_group(
            db, order, signal_id,
            f"insufficient account balance ({account.current_balance} left in {order.segment} account, "
            f"need at least {net_debit * lot_size * required_lots} for {required_lots} lot(s))",
        )
        db.commit()
        return row

    sl_scope = order.option_sl_scope or "combined"
    combined_stop_loss_price: Optional[float] = None
    combined_target_price: Optional[float] = None
    long_stop_loss_price: Optional[float] = None
    long_target_price: Optional[float] = None
    short_stop_loss_price: Optional[float] = None
    short_target_price: Optional[float] = None

    if order.stop_loss_method == "percent" and order.stop_loss_percent is not None:
        if sl_scope == "individual":
            long_stop_loss_price = compute_stop_loss_percent_price("BUY", long_premium, order.stop_loss_percent)
            if short_leg_dict:
                short_stop_loss_price = compute_stop_loss_percent_price("SELL", short_premium, order.stop_loss_percent)
        else:
            combined_stop_loss_price = compute_stop_loss_percent_price("BUY", net_debit, order.stop_loss_percent)

    if order.target_percent is not None:
        if sl_scope == "individual":
            long_target_price = compute_target_percent_price("BUY", long_premium, order.target_percent)
            if short_leg_dict:
                short_target_price = compute_target_percent_price("SELL", short_premium, order.target_percent)
        else:
            combined_target_price = compute_target_percent_price("BUY", net_debit, order.target_percent)

    # Position sizing risk-anchors on the PRIMARY leg's own stop distance in
    # individual mode (mirrors what a naked position already does
    # unconditionally, since net_debit == the long leg's own premium
    # there) - falls back to plain capital sizing when no SL is configured,
    # same as combined mode already does.
    sizing_price = long_premium if sl_scope == "individual" else net_debit
    sizing_stop_loss_price = long_stop_loss_price if sl_scope == "individual" else combined_stop_loss_price

    if order.option_fixed_lots is not None:
        # Strategy-level override (options only) - trades exactly this many
        # lots instead of auto-sizing off capital/risk% - takes precedence
        # over stop-loss-based sizing entirely, even when a stop-loss is
        # also configured. The stop-loss price above is still computed and
        # stored as normal; only its role in SIZING is bypassed here.
        quantity = order.option_fixed_lots * lot_size
    elif sizing_stop_loss_price is not None:
        stop_distance = abs(sizing_price - sizing_stop_loss_price)
        if stop_distance <= 0:
            row = _reject_group(
                db, order, signal_id,
                f"stop-loss price ({sizing_stop_loss_price}) equals entry price ({sizing_price}) - can't size by risk",
            )
            db.commit()
            return row
        quantity = compute_risk_based_quantity(
            effective_capital, float(account.risk_per_trade_pct), sizing_price, sizing_stop_loss_price, lot_size
        )
    else:
        quantity = compute_quantity(effective_capital, net_debit, lot_size)

    group_id = uuid.uuid4()
    group = db_models.OptionPositionGroup(
        id=group_id,
        signal_id=signal_id,
        strategy_id=uuid.UUID(order.strategy_id),
        underlying_symbol=order.symbol,
        exchange=order.exchange,
        segment=order.segment,
        strategy_type=(order.strategy or {}).get("type", "unknown"),
        action=order.action,
        horizon=order.horizon,
        quantity=quantity,
        net_debit=net_debit,
        combined_stop_loss_price=combined_stop_loss_price,
        combined_target_price=combined_target_price,
        sl_scope=sl_scope,
        status="OPEN",
        square_off_time=order.square_off_time,
    )
    db.add(group)

    legs_to_write = [(long_leg_dict, long_symbol, long_premium, long_stop_loss_price, long_target_price)]
    if short_leg_dict:
        legs_to_write.append((short_leg_dict, short_symbol, short_premium, short_stop_loss_price, short_target_price))
    for leg_dict, symbol, premium, leg_sl, leg_target in legs_to_write:
        db.add(
            db_models.Position(
                signal_id=signal_id,
                strategy_id=uuid.UUID(order.strategy_id),
                symbol=symbol,
                exchange=order.exchange,
                segment=order.segment,
                action=leg_dict["action"],
                horizon=order.horizon,
                instrument_type="option",
                quantity=quantity,
                entry_price=premium,
                status="OPEN",
                square_off_time=order.square_off_time,
                option_group_id=group_id,
                # Only set in sl_scope='individual' - combined mode leaves
                # these NULL, same as today, monitored via the group's own
                # combined_stop_loss_price/combined_target_price instead.
                stop_loss_price=leg_sl,
                initial_stop_loss_price=leg_sl,
                target_price=leg_target,
            )
        )
    db.commit()
    return group


def _close_group_at_cmp(group, long_leg, short_leg: Optional[object], get_ltp_batch: GetLtpBatch, account, exit_reason: str) -> bool:
    """Pure logic (no DB query/commit) - closes `group` and its 1-2 already-
    fetched legs at current market prices, mutating them in place. `short_leg`
    is None for a naked (1-leg) group - contributes 0 to the combined price,
    same identity the module docstring establishes. Returns False (leaves
    everything unchanged) if either leg's live quote is unavailable,
    mirroring square_off_all_open's per-position graceful degradation.
    Shared by counter-signal closes, manual square-off, and bulk
    square-off-all - each caller fetches `long_leg`/`short_leg` via
    legs_by_group first, same pure/impure split _evaluate_exits itself
    uses."""
    symbols = [long_leg.symbol] + ([short_leg.symbol] if short_leg else [])
    quotes = get_ltp_batch(group.exchange, symbols)
    long_cmp = quotes.get(long_leg.symbol)
    short_cmp = quotes.get(short_leg.symbol) if short_leg else 0.0
    if long_cmp is None or (short_leg and short_cmp is None):
        return False

    now = datetime.now(dt_timezone.utc)
    legs_to_close = [(long_leg, long_cmp)] + ([(short_leg, short_cmp)] if short_leg else [])
    for pos, cmp_price in legs_to_close:
        pos.exit_price = cmp_price
        pos.exit_time = now
        pos.pnl = compute_pnl(pos.action, float(pos.entry_price), cmp_price, float(pos.quantity))
        pos.status = "CLOSED"
        pos.exit_reason = exit_reason

    combined_price = long_cmp - short_cmp
    combined_pnl = (combined_price - float(group.net_debit)) * float(group.quantity)
    group.exit_time = now
    group.status = "CLOSED"
    group.exit_reason = exit_reason
    _apply_realized_pnl(group, account, combined_pnl)
    return True


def compute_group_unrealized_pnl(groups: list, legs: dict, get_ltp_batch: GetLtpBatch) -> dict:
    """Read-only mark-to-market for OPEN groups - mirrors
    position_manager.compute_unrealized_pnl. Returns {group.id:
    (combined_price, unrealized_pnl)}."""
    open_groups = [g for g in groups if g.status == "OPEN"]
    all_legs = [pos for g in open_groups for pos in legs.get(g.id, {}).values()]
    quotes = _quotes_by_exchange(all_legs, get_ltp_batch)

    result: dict = {}
    for group in open_groups:
        group_legs = legs.get(group.id)
        if not group_legs or "BUY" not in group_legs:
            continue
        long_leg, short_leg = group_legs["BUY"], group_legs.get("SELL")
        long_cmp = quotes.get((long_leg.exchange, long_leg.symbol))
        short_cmp = quotes.get((short_leg.exchange, short_leg.symbol)) if short_leg else 0.0
        if long_cmp is None or (short_leg and short_cmp is None):
            continue
        combined_price = long_cmp - short_cmp
        unrealized = (combined_price - float(group.net_debit)) * float(group.quantity)
        result[group.id] = (combined_price, unrealized)

    return result


def square_off_all_open_option_groups(db: Session, get_ltp_batch: GetLtpBatch) -> dict:
    open_groups = db.query(db_models.OptionPositionGroup).filter_by(status="OPEN").all()
    legs = legs_by_group(db, open_groups)
    accounts = _accounts_by_segment(db, open_groups)
    closed = 0
    failed = 0
    for group in open_groups:
        group_legs = legs.get(group.id)
        if (
            group_legs is not None
            and "BUY" in group_legs
            and _close_group_at_cmp(group, group_legs["BUY"], group_legs.get("SELL"), get_ltp_batch, accounts.get(group.segment), "square_off")
        ):
            closed += 1
        else:
            failed += 1
    db.commit()
    return {"closed": closed, "failed": failed, "total_open": len(open_groups)}


def square_off_option_group(db: Session, group_id: uuid.UUID, get_ltp_batch: GetLtpBatch) -> dict:
    group = db.get(db_models.OptionPositionGroup, group_id)
    if group is None:
        return {"status": "not_found"}
    if group.status != "OPEN":
        return {"status": "not_open", "group_status": group.status}

    group_legs = legs_by_group(db, [group]).get(group.id)
    account = load_account(db, group.segment)
    if (
        group_legs is None
        or "BUY" not in group_legs
        or not _close_group_at_cmp(group, group_legs["BUY"], group_legs.get("SELL"), get_ltp_batch, account, "manual")
    ):
        return {"status": "quote_unavailable"}
    db.commit()
    return {"status": "closed", "group_id": str(group.id), "underlying_symbol": group.underlying_symbol, "pnl": float(group.pnl)}


def update_group_stop_loss(db: Session, group_id: uuid.UUID, new_price: float) -> Optional[db_models.OptionPositionGroup]:
    """Generically useful, not manual-only - editing SL on any already-open
    option group. Scoped to sl_scope='combined' groups only - editing an
    individual leg's own stop_loss_price is out of scope here (would need
    a per-leg endpoint, not this group-level one). Returns the group
    unchanged (caller checks status/sl_scope separately) rather than
    silently no-op'ing on a mismatch."""
    row = db.get(db_models.OptionPositionGroup, group_id)
    if row is None:
        return None
    if row.sl_scope != "combined":
        return row
    row.combined_stop_loss_price = new_price
    db.commit()
    return row


def _evaluate_option_group_square_off_due(groups: list, legs: dict, get_ltp_batch: GetLtpBatch, now_local, accounts_by_segment: dict) -> dict:
    """Pure logic (no DB query/commit) - mirrors
    position_manager._evaluate_square_off_due at the group level."""
    due = [g for g in groups if g.square_off_time is not None and now_local >= g.square_off_time]
    if not due:
        return {"closed": 0, "failed": 0, "checked": 0}

    all_legs = [pos for g in due for pos in legs.get(g.id, {}).values()]
    quotes = _quotes_by_exchange(all_legs, get_ltp_batch)
    closed = 0
    failed = 0
    now = datetime.now(dt_timezone.utc)

    for group in due:
        group_legs = legs.get(group.id)
        if not group_legs or "BUY" not in group_legs:
            failed += 1
            continue
        long_leg, short_leg = group_legs["BUY"], group_legs.get("SELL")
        long_cmp = quotes.get((long_leg.exchange, long_leg.symbol))
        short_cmp = quotes.get((short_leg.exchange, short_leg.symbol)) if short_leg else 0.0
        if long_cmp is None or (short_leg and short_cmp is None):
            failed += 1
            continue

        legs_to_close = [(long_leg, long_cmp)] + ([(short_leg, short_cmp)] if short_leg else [])
        for pos, cmp_price in legs_to_close:
            pos.exit_price = cmp_price
            pos.exit_time = now
            pos.pnl = compute_pnl(pos.action, float(pos.entry_price), cmp_price, float(pos.quantity))
            pos.status = "CLOSED"
            pos.exit_reason = "square_off"

        combined_price = long_cmp - short_cmp
        combined_pnl = (combined_price - float(group.net_debit)) * float(group.quantity)
        group.exit_time = now
        group.status = "CLOSED"
        group.exit_reason = "square_off"
        _apply_realized_pnl(group, accounts_by_segment.get(group.segment), combined_pnl)
        closed += 1

    return {"closed": closed, "failed": failed, "checked": len(due)}


def square_off_due_option_groups(db: Session, get_ltp_batch: GetLtpBatch) -> dict:
    exec_settings = load_settings(db)
    now_local = datetime.now(dt_timezone.utc).astimezone(ZoneInfo(exec_settings.timezone)).time()
    open_groups = db.query(db_models.OptionPositionGroup).filter_by(status="OPEN").all()
    legs = legs_by_group(db, open_groups)
    accounts = _accounts_by_segment(db, open_groups)
    result = _evaluate_option_group_square_off_due(open_groups, legs, get_ltp_batch, now_local, accounts)
    db.commit()
    return result


def _evaluate_option_group_exits(groups: list, legs: dict, get_ltp_batch: GetLtpBatch, accounts_by_segment: dict) -> dict:
    """Pure logic (no DB query/commit) - mirrors position_manager
    ._evaluate_exits at the group level (no trailing, no previous_candle -
    see module docstring's scope notes). `legs`: group.id -> {'BUY':
    Position, 'SELL': Position}, pre-queried by the caller
    (check_option_group_exits).

    sl_scope='combined' (default) checks the group's own combined_stop_loss_price/
    combined_target_price against the combined (long-short) price, exactly
    as before. sl_scope='individual' instead checks EACH leg's own
    stop_loss_price/target_price (set at open time, see open_option_group)
    against that leg's own fresh quote, action-aware - whichever leg trips
    first still closes the WHOLE group together, same as combined mode;
    this only changes what triggers the close, never leaves one leg open.
    Either mode credits/debits the account off the same real combined P&L
    (combined_price - net_debit) * quantity - the trigger condition never
    changes what the position was actually worth at exit."""
    if not groups:
        return {"closed_stop_loss": 0, "closed_target": 0, "checked": 0}

    all_legs = [pos for g in groups for pos in legs.get(g.id, {}).values()]
    quotes = _quotes_by_exchange(all_legs, get_ltp_batch)
    closed_stop_loss = 0
    closed_target = 0
    now = datetime.now(dt_timezone.utc)

    for group in groups:
        group_legs = legs.get(group.id)
        if not group_legs or "BUY" not in group_legs:
            continue
        long_leg, short_leg = group_legs["BUY"], group_legs.get("SELL")
        long_cmp = quotes.get((long_leg.exchange, long_leg.symbol))
        short_cmp = quotes.get((short_leg.exchange, short_leg.symbol)) if short_leg else 0.0
        if long_cmp is None or (short_leg and short_cmp is None):
            continue

        combined_price = long_cmp - short_cmp
        if group.sl_scope == "individual":
            sl_hit = (
                (long_leg.stop_loss_price is not None and long_cmp <= float(long_leg.stop_loss_price))
                or (short_leg is not None and short_leg.stop_loss_price is not None and short_cmp >= float(short_leg.stop_loss_price))
            )
            target_hit = (
                (long_leg.target_price is not None and long_cmp >= float(long_leg.target_price))
                or (short_leg is not None and short_leg.target_price is not None and short_cmp <= float(short_leg.target_price))
            )
        else:
            sl_hit = group.combined_stop_loss_price is not None and combined_price <= float(group.combined_stop_loss_price)
            target_hit = group.combined_target_price is not None and combined_price >= float(group.combined_target_price)
        if not (sl_hit or target_hit):
            continue

        group_reason_prefix = "individual" if group.sl_scope == "individual" else "combined"
        group_reason = f"{group_reason_prefix}_stop_loss" if sl_hit else f"{group_reason_prefix}_target"
        # Leg-level exit_reason is the plain 'stop_loss'/'target' every
        # other position already uses (positions.exit_reason's own CHECK
        # constraint doesn't have 'combined_'/'individual_' variants at
        # all - only the group's own exit_reason does) - same value
        # regardless of sl_scope, since both legs close as a consequence
        # of the group's trigger either way, not independently.
        leg_reason = "stop_loss" if sl_hit else "target"
        legs_to_close = [(long_leg, long_cmp)] + ([(short_leg, short_cmp)] if short_leg else [])
        for pos, cmp_price in legs_to_close:
            pos.exit_price = cmp_price
            pos.exit_time = now
            pos.pnl = compute_pnl(pos.action, float(pos.entry_price), cmp_price, float(pos.quantity))
            pos.status = "CLOSED"
            pos.exit_reason = leg_reason

        combined_pnl = (combined_price - float(group.net_debit)) * float(group.quantity)
        group.exit_time = now
        group.status = "CLOSED"
        group.exit_reason = group_reason
        _apply_realized_pnl(group, accounts_by_segment.get(group.segment), combined_pnl)

        if sl_hit:
            closed_stop_loss += 1
        else:
            closed_target += 1

    return {"closed_stop_loss": closed_stop_loss, "closed_target": closed_target, "checked": len(groups)}


def check_option_group_exits(db: Session, get_ltp_batch: GetLtpBatch) -> dict:
    candidates = (
        db.query(db_models.OptionPositionGroup)
        .filter(db_models.OptionPositionGroup.status == "OPEN")
        .filter(
            (db_models.OptionPositionGroup.combined_stop_loss_price.isnot(None))
            | (db_models.OptionPositionGroup.combined_target_price.isnot(None))
            # sl_scope='individual' groups never set combined_stop_loss_price/
            # combined_target_price at all (see open_option_group) - would
            # otherwise never be selected as a candidate here.
            | (db_models.OptionPositionGroup.sl_scope == "individual")
        )
        .all()
    )
    legs = legs_by_group(db, candidates)
    accounts = _accounts_by_segment(db, candidates)
    result = _evaluate_option_group_exits(candidates, legs, get_ltp_batch, accounts)
    db.commit()
    return result
