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
from datetime import datetime, time
from datetime import timezone as dt_timezone
from types import SimpleNamespace
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.domain.delta_fees import compute_option_trading_fee
from app.domain.models import ExecutionSettings, ResolvedOrder
from app.domain.option_templates import bear_put_spread, bull_call_spread, naked_call, naked_put
from app.domain.position_manager import (
    GetCandleHistory,
    GetLotSize,
    GetLtpBatch,
    _accounts_by_segment,
    _apply_realized_pnl,
    _indicator_history_window,
    _quotes_by_exchange,
    _resolve_capital_account,
    _resolve_signal_conflicts,
    _strategy_accounts_by_id,
    _usdinr_rate_by_user,
    _STOP_LOSS_COMPUTE_FUNCS,
    _supertrend_stop_value,
    compute_pnl,
    compute_quantity,
    compute_risk_based_quantity,
    compute_stop_loss_percent_price,
    compute_target_percent_price,
    is_within_intraday_window,
    load_account,
    load_capital_account,
    load_settings,
)

logger = logging.getLogger(__name__)

# (exchange, security_id) -> trading symbol, or None if unresolvable -
# see market-data's GET /instruments/resolve-by-security-id.
ResolveSymbolBySecurityId = Callable[[str, str], Optional[str]]
# (segment, underlying) -> raw resolve dict (chart_symbol/chart_exchange/...),
# or None if unresolvable - see market-data's GET /instruments/resolve.
# Only used by open_manual_option_group below.
ResolveUnderlying = Callable[[str, str], Optional[dict]]
# (exchange, symbol) -> list of expiry date strings, or None if unresolvable.
GetExpiryList = Callable[[str, str], Optional[list]]
# (exchange, symbol, expiry) -> raw option chain dict, or None if unresolvable.
GetOptionChain = Callable[[str, str, str], Optional[dict]]


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


def _open_delta_option_fee(
    segment: str, entry_spot_price: Optional[float], quantity: float, long_premium: float, short_premium: float = 0.0
) -> Optional[float]:
    """Delta Exchange option trading-fee simulation (app/domain/delta_fees.py)
    - CRYPTO only, None for NSE/MCX (zero behavior change there). Summed
    per LEG (each leg is its own trade with its own premium/fee-cap, not
    one fee on the combined net debit) - short_premium<=0 is this module's
    existing "no short leg" sentinel (see open_option_group's own
    short_premium default). notional_value is the UNDERLYING's own notional
    (entry_spot_price * quantity), not the premium - matching Delta's real
    options fee methodology (a %-of-underlying-notional fee capped at
    %-of-premium; the cap would otherwise almost never bind, since the
    taker rate applied to the premium alone stays far below it). Falls back
    to premium-based notional if entry_spot_price is unavailable
    (best-effort - see entry_spot_price's own comment) rather than skipping
    the fee entirely."""
    if segment != "CRYPTO":
        return None
    underlying_notional = entry_spot_price * quantity if entry_spot_price is not None else None
    long_premium_amount = long_premium * quantity
    fee = compute_option_trading_fee(underlying_notional if underlying_notional is not None else long_premium_amount, long_premium_amount)
    if short_premium > 0:
        short_premium_amount = short_premium * quantity
        fee += compute_option_trading_fee(
            underlying_notional if underlying_notional is not None else short_premium_amount, short_premium_amount
        )
    return fee


def _close_delta_option_fee(segment: str, spot_price: Optional[float], quantity: float, long_price: float, short_price: float = 0.0) -> Optional[float]:
    """Close-time counterpart to _open_delta_option_fee - same formula,
    called with the legs' exit quotes instead of entry premiums. `spot_price`
    is whatever fresh underlying quote the caller already fetched for this
    close (None is handled the same "fall back to premium-based notional"
    way as at open)."""
    return _open_delta_option_fee(segment, spot_price, quantity, long_price, short_price)


def _reject_group(db: Session, order: ResolvedOrder, signal_id: uuid.UUID, reason: str) -> db_models.OptionPositionGroup:
    """No leg Position rows are created for a rejected group - mirrors
    position_manager._reject's 'never really opened' philosophy, just
    applied at the group level. Only the automated Strategy-driven flow
    calls this (see _reject_manual_group for the manual/SaaS counterpart).
    user_id mirrors order.owner_user_id, same reasoning as
    position_manager._reject's identical comment."""
    logger.info("rejecting option signal %s: %s", order.signal_id, reason)
    row = db_models.OptionPositionGroup(
        user_id=uuid.UUID(order.owner_user_id) if order.owner_user_id else None,
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
    resolve_underlying: ResolveUnderlying,
    get_candle_history: GetCandleHistory,
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

    if order.stop_loss_method == "previous_candle":
        row = _reject_group(
            db, order, signal_id,
            "combined stop-loss only supports stop_loss_method='percent' for option strategies (got 'previous_candle')",
        )
        db.commit()
        return row

    # stop_loss_method='indicator' - SuperTrend only today (see
    # docs/architecture.md). An option premium is too noisy/decaying a
    # series to run an indicator against directly, so this is computed off
    # the underlying's own nearest-expiry FUTURE contract instead (the
    # same "chart on the future, manage the option" convention traders
    # already use for index/stock options) and stored on
    # spot_stop_loss_price - the existing "a third, orthogonal stop,
    # independent of sl_scope" mechanism _evaluate_option_group_exits
    # already checks, just checked against the future's own LTP
    # (stop_loss_future_symbol/exchange) instead of the underlying spot LTP
    # a user-set spot_stop_loss_price uses. Any other stop_loss_method
    # (None, 'percent') leaves every field below at its default - unchanged
    # from before this feature existed.
    spot_stop_loss_price: Optional[float] = None
    spot_stop_loss_trailing_enabled = False
    spot_stop_loss_indicator_type: Optional[str] = None
    spot_stop_loss_indicator_params: Optional[dict] = None
    spot_stop_loss_interval: Optional[str] = None
    stop_loss_future_symbol: Optional[str] = None
    stop_loss_future_exchange: Optional[str] = None
    if order.stop_loss_method == "indicator" and order.stop_loss_indicator_type == "supertrend":
        resolved_future = resolve_underlying(order.segment, order.symbol)
        if resolved_future is None:
            row = _reject_group(
                db, order, signal_id,
                f"could not resolve underlying '{order.symbol}' future on {order.segment} for a SuperTrend stop-loss",
            )
            db.commit()
            return row
        stop_loss_future_symbol = resolved_future["trade_symbol"]
        stop_loss_future_exchange = resolved_future["trade_exchange"]

        warmup_from, warmup_to = _indicator_history_window(
            (order.stop_loss_indicator_params or {}).get("period", 20), order.stop_loss_interval
        )
        future_history = get_candle_history(
            stop_loss_future_exchange, stop_loss_future_symbol, order.stop_loss_interval, warmup_from, warmup_to
        )
        future_stop_candidate = _supertrend_stop_value(future_history, order.stop_loss_indicator_params or {})
        if future_stop_candidate is None:
            row = _reject_group(
                db, order, signal_id,
                f"stop_loss_method='indicator' (supertrend) but not enough {order.stop_loss_interval} history "
                f"available for future {stop_loss_future_symbol} yet",
            )
            db.commit()
            return row

        future_quotes = get_ltp_batch(stop_loss_future_exchange, [stop_loss_future_symbol])
        future_cmp = future_quotes.get(stop_loss_future_symbol)
        if future_cmp is None:
            row = _reject_group(
                db, order, signal_id, f"could not fetch a live quote for future {stop_loss_future_symbol}"
            )
            db.commit()
            return row
        # Same wrong-side guard as position_manager._resolve_stop_loss's
        # own indicator branch - a raw indicator value has no direction
        # concept, so one on the wrong side of the future's current price
        # isn't a protective stop at all.
        if (order.action == "BUY" and future_stop_candidate >= future_cmp) or (
            order.action == "SELL" and future_stop_candidate <= future_cmp
        ):
            row = _reject_group(
                db, order, signal_id,
                f"stop_loss_method='indicator' (supertrend) computed {future_stop_candidate} on future "
                f"{stop_loss_future_symbol} - not on the protective side of its current price ({future_cmp}) "
                f"for a {order.action}, not usable as a stop-loss",
            )
            db.commit()
            return row

        spot_stop_loss_price = future_stop_candidate
        spot_stop_loss_trailing_enabled = order.trailing_stop_enabled
        spot_stop_loss_indicator_type = order.stop_loss_indicator_type
        spot_stop_loss_indicator_params = order.stop_loss_indicator_params
        spot_stop_loss_interval = order.stop_loss_interval

    # owner_user_id=None (Strategy created before this field existed, or
    # with no bearer token) reads/writes the legacy platform-wide account,
    # same reasoning as position_manager.open_position's identical
    # comment.
    owner_user_id = uuid.UUID(order.owner_user_id) if order.owner_user_id else None
    account = load_account(db, owner_user_id, order.segment)
    if account is None:
        row = _reject_group(db, order, signal_id, f"no paper-trading account configured for segment {order.segment}")
        db.commit()
        return row

    # Sizing/balance uses the strategy's OWN dedicated account if it has
    # one, else the owner's (or the shared segment) `account` above -
    # leverage/square_off_time always stay segment-only (see
    # load_capital_account).
    capital_account = load_capital_account(db, owner_user_id, order.segment, order.strategy_id)

    # square_off_time is the SEGMENT's own configured cutoff now
    # (execution.accounts.square_off_time), not a per-Strategy value -
    # None (e.g. CRYPTO) means this segment never force-closes.
    now = datetime.now(dt_timezone.utc)
    if not is_within_intraday_window(now, account.square_off_time, settings.timezone):
        row = _reject_group(
            db, order, signal_id, f"received outside intraday window (square-off is {account.square_off_time})"
        )
        db.commit()
        return row

    open_groups = (
        db.query(db_models.OptionPositionGroup)
        .filter_by(user_id=owner_user_id, underlying_symbol=order.symbol, status="OPEN")
        .all()
    )
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

    # order.symbol (the underlying, e.g. "NIFTY") rides along in the SAME
    # batched quote call - one extra symbol, no extra provider round trip.
    # Best-effort only (see entry_spot_price's own comment in
    # infra/postgres/init/02-execution.sql) - a missing underlying quote
    # doesn't reject the group the way a missing LEG quote does below.
    symbols_to_quote = [long_symbol, order.symbol] + ([short_symbol] if short_symbol else [])
    quotes = get_ltp_batch(order.exchange, symbols_to_quote)
    long_premium = quotes.get(long_symbol)
    short_premium = quotes.get(short_symbol) if short_symbol else 0.0
    entry_spot_price = quotes.get(order.symbol)
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
                and _close_group_at_cmp(
                    grp, grp_legs["BUY"], grp_legs.get("SELL"), get_ltp_batch, capital_account, "counter_signal", settings.usdinr_rate
                )
            )
            if not closed:
                row = _reject_group(
                    db, order, signal_id,
                    f"could not close conflicting option group {grp.id} (quote unavailable) - "
                    "counter_signal_policy='close_and_flip' requires closing it first",
                )
                db.commit()
                return row

    effective_capital = min(float(capital_account.capital_per_trade), float(capital_account.current_balance))
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
    # fixed_lots (Strategy-level, every instrument_type) overrides
    # auto-sizing below entirely, but the balance check still runs against
    # its real cost, not a 1-lot minimum - a fixed count that's genuinely
    # unaffordable against current_balance still rejects cleanly, same
    # "paper trading still respects the simulated balance" reasoning every
    # other rejection case here already has.
    required_lots = order.fixed_lots if order.fixed_lots is not None else 1
    if effective_capital < net_debit * lot_size * required_lots:
        capital_unit = "USD" if order.segment == "CRYPTO" else "INR"
        row = _reject_group(
            db, order, signal_id,
            f"insufficient account balance ({effective_capital} {capital_unit} available for {order.segment}, "
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

    if order.fixed_lots is not None:
        # Strategy-level override (every instrument_type) - trades exactly
        # this many lots instead of auto-sizing off capital/risk% - takes
        # precedence over stop-loss-based sizing entirely, even when a
        # stop-loss is also configured. The stop-loss price above is still
        # computed and stored as normal; only its role in SIZING is
        # bypassed here.
        quantity = order.fixed_lots * lot_size
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
            effective_capital, float(capital_account.risk_per_trade_pct), sizing_price, sizing_stop_loss_price, lot_size
        )
    else:
        quantity = compute_quantity(effective_capital, net_debit, lot_size)

    open_fee = _open_delta_option_fee(order.segment, entry_spot_price, quantity, long_premium, short_premium)
    if open_fee is not None:
        # open_fee is raw USD (see _open_delta_option_fee's own docstring) -
        # current_balance is always INR-denominated, convert before
        # debiting (settings.usdinr_rate is guaranteed set here - CRYPTO
        # sizing above this point already rejects the whole order without
        # one).
        capital_account.current_balance = float(capital_account.current_balance) - open_fee * settings.usdinr_rate

    group_id = uuid.uuid4()
    group = db_models.OptionPositionGroup(
        id=group_id,
        user_id=owner_user_id,
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
        entry_spot_price=entry_spot_price,
        spot_stop_loss_price=spot_stop_loss_price,
        spot_stop_loss_trailing_enabled=spot_stop_loss_trailing_enabled,
        spot_stop_loss_indicator_type=spot_stop_loss_indicator_type,
        spot_stop_loss_indicator_params=spot_stop_loss_indicator_params,
        spot_stop_loss_interval=spot_stop_loss_interval,
        stop_loss_future_symbol=stop_loss_future_symbol,
        stop_loss_future_exchange=stop_loss_future_exchange,
        open_fee=open_fee,
        status="OPEN",
        square_off_time=account.square_off_time,
    )
    db.add(group)

    legs_to_write = [(long_leg_dict, long_symbol, long_premium, long_stop_loss_price, long_target_price)]
    if short_leg_dict:
        legs_to_write.append((short_leg_dict, short_symbol, short_premium, short_stop_loss_price, short_target_price))
    for leg_dict, symbol, premium, leg_sl, leg_target in legs_to_write:
        db.add(
            db_models.Position(
                user_id=owner_user_id,
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
                square_off_time=account.square_off_time,
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


def _reject_manual_group(
    db: Session, user_id: uuid.UUID, signal_id: uuid.UUID, symbol: str, segment: str, action: str, strategy_type: str, reason: str
) -> db_models.OptionPositionGroup:
    """Manual-option counterpart to _reject_group - no leg Position rows,
    strategy_id=None (never a real Strategy for this path at all, unlike
    _reject_group's signal-driven ResolvedOrder.strategy_id)."""
    logger.info("rejecting manual option order %s: %s", signal_id, reason)
    row = db_models.OptionPositionGroup(
        user_id=user_id,
        signal_id=signal_id,
        strategy_id=None,
        underlying_symbol=symbol,
        exchange=segment,
        segment=segment,
        strategy_type=strategy_type,
        action=action,
        horizon="intraday",
        status="REJECTED",
        rejection_reason=reason,
    )
    db.add(row)
    return row


def open_manual_option_group(
    user_id: uuid.UUID,
    segment: str,
    symbol: str,
    action: str,
    option_position_style: str,
    option_strike_moneyness: str,
    expiry: Optional[str],
    sl_scope: str,
    option_fixed_lots: Optional[float],
    settings: ExecutionSettings,
    db: Session,
    resolve_underlying: ResolveUnderlying,
    get_expiry_list: GetExpiryList,
    get_option_chain: GetOptionChain,
    get_ltp_batch: GetLtpBatch,
    resolve_symbol_by_security_id: ResolveSymbolBySecurityId,
    get_lot_size: GetLotSize,
    plan_checklist: Optional[list[dict]] = None,
    order_type: Optional[str] = None,
    square_off_time: Optional[time] = None,
    trend_followed: Optional[bool] = None,
    risk_managed: Optional[bool] = None,
    setup_tag: Optional[str] = None,
    confidence: Optional[int] = None,
) -> db_models.OptionPositionGroup:
    """Manual tab (signal-generation's frontend) - option orders, bypassing
    signal-generation/signal-processing entirely (no auto-provisioned
    Strategy, unlike the pre-2026-08-14 design - see docs/architecture.md).
    Deliberately a sibling to open_option_group, not a call into it - that
    function takes a ResolvedOrder (always a real strategy_id, legs already
    resolved by signal-engine's choose_option_strategy against an
    automatically-picked expiry); this one resolves its own legs directly,
    defaulting to the nearest currently-tradeable expiry itself when
    `expiry` is None (no dropdown in the frontend as of 2026-08-14 - it
    used to require an explicit, user-picked one, but GET /options/expiries
    proved slow/unreliable enough as a blocking frontend dependency that
    silent-auto-nearest, matching the pre-2026-08-14 Strategy-mediated
    path, won out) - an explicit `expiry` is still honored/validated if
    given, and never has a Strategy at all (strategy_id=None
    throughout, mirrors open_manual_position's spot/future precedent -
    option_position_groups.strategy_id is nullable for exactly this
    reason). Reuses every pure/impure helper open_option_group already
    established (account loading, conflict resolution, quoting, sizing,
    the combined-premium-as-BUY-price identity) - only leg SELECTION
    differs, via this module's own option_templates.py port instead of
    signal-processing's.

    `order_type` ('market'/'limit'/None) is stored as-is on the resulting
    group for future performance review, same "just a caller-resolved
    label" reasoning as open_manual_position's own copy of this
    docstring note - it never changes leg selection/pricing here, which
    is always resolved fresh from a live quote regardless."""
    signal_id = uuid.uuid4()
    strategy_type_for_rejection = f"{option_position_style}_{action.lower()}"  # best-effort label pre-leg-selection

    resolved = resolve_underlying(segment, symbol)
    if resolved is None:
        row = _reject_manual_group(
            db, user_id, signal_id, symbol, segment, action, strategy_type_for_rejection,
            f"could not resolve underlying '{symbol}' on {segment} for options",
        )
        db.commit()
        return row
    chart_symbol, chart_exchange = resolved["chart_symbol"], resolved["chart_exchange"]

    expiries = get_expiry_list(chart_exchange, chart_symbol)
    if not expiries:
        row = _reject_manual_group(
            db, user_id, signal_id, symbol, segment, action, strategy_type_for_rejection,
            f"no currently-tradeable expiry available for '{chart_symbol}'",
        )
        db.commit()
        return row
    if expiry is None:
        resolved_expiry = sorted(expiries)[0]  # nearest - see docstring above
    elif expiry not in expiries:
        row = _reject_manual_group(
            db, user_id, signal_id, symbol, segment, action, strategy_type_for_rejection,
            f"'{expiry}' is not a currently-tradeable expiry for '{chart_symbol}' - available: {expiries}",
        )
        db.commit()
        return row
    else:
        resolved_expiry = expiry

    chain = get_option_chain(chart_exchange, chart_symbol, resolved_expiry)
    if chain is None:
        row = _reject_manual_group(
            db, user_id, signal_id, symbol, segment, action, strategy_type_for_rejection,
            f"could not resolve option chain for '{chart_symbol}' ({expiry})",
        )
        db.commit()
        return row

    try:
        if option_position_style == "naked":
            if action == "BUY":
                strategy_type, legs = "naked_call", naked_call(chain, option_strike_moneyness)
            else:
                strategy_type, legs = "naked_put", naked_put(chain, option_strike_moneyness)
        elif action == "BUY":
            strategy_type, legs = "bull_call_spread", bull_call_spread(chain, option_strike_moneyness)
        else:
            strategy_type, legs = "bear_put_spread", bear_put_spread(chain, option_strike_moneyness)
    except ValueError as exc:
        row = _reject_manual_group(
            db, user_id, signal_id, symbol, segment, action, strategy_type_for_rejection,
            f"could not build an option strategy for '{symbol}': {exc}",
        )
        db.commit()
        return row

    # Template output order is always [long, short?] - see
    # option_templates.py's bull_call_spread/bear_put_spread/naked_*.
    long_leg_dict = legs[0]
    short_leg_dict = legs[1] if len(legs) == 2 else None

    account = load_account(db, user_id, segment)
    if account is None:
        row = _reject_manual_group(
            db, user_id, signal_id, symbol, segment, action, strategy_type, f"no paper-trading account configured for segment {segment}"
        )
        db.commit()
        return row

    now = datetime.now(dt_timezone.utc)
    if not is_within_intraday_window(now, account.square_off_time, settings.timezone):
        row = _reject_manual_group(
            db, user_id, signal_id, symbol, segment, action, strategy_type,
            f"received outside intraday window (square-off is {account.square_off_time})",
        )
        db.commit()
        return row

    # Manual orders always allow pyramiding, same fixed platform default as
    # open_manual_position (spot/future) - no Strategy exists here to carry
    # duplicate_signal_policy/counter_signal_policy.
    conflict_check = SimpleNamespace(action=action, duplicate_signal_policy="add_position", counter_signal_policy="close_and_flip")
    open_groups = db.query(db_models.OptionPositionGroup).filter_by(user_id=user_id, underlying_symbol=symbol, status="OPEN").all()
    groups_to_close, reject_reason = _resolve_signal_conflicts(open_groups, conflict_check)
    if reject_reason is not None:
        row = _reject_manual_group(db, user_id, signal_id, symbol, segment, action, strategy_type, reject_reason)
        db.commit()
        return row

    long_symbol = resolve_symbol_by_security_id(segment, long_leg_dict["security_id"])
    short_symbol = resolve_symbol_by_security_id(segment, short_leg_dict["security_id"]) if short_leg_dict else None
    if long_symbol is None or (short_leg_dict and short_symbol is None):
        row = _reject_manual_group(
            db, user_id, signal_id, symbol, segment, action, strategy_type,
            "could not resolve one or both option legs' security_id to a trading symbol",
        )
        db.commit()
        return row

    # symbol (the underlying) rides along in the same batched quote call -
    # see open_option_group's identical comment.
    symbols_to_quote = [long_symbol, symbol] + ([short_symbol] if short_symbol else [])
    quotes = get_ltp_batch(segment, symbols_to_quote)
    long_premium = quotes.get(long_symbol)
    short_premium = quotes.get(short_symbol) if short_symbol else 0.0
    entry_spot_price = quotes.get(symbol)
    if long_premium is None or (short_symbol and short_premium is None):
        row = _reject_manual_group(
            db, user_id, signal_id, symbol, segment, action, strategy_type, "could not fetch a live quote for one or both option legs"
        )
        db.commit()
        return row

    net_debit = long_premium - short_premium
    if net_debit <= 0:
        row = _reject_manual_group(
            db, user_id, signal_id, symbol, segment, action, strategy_type,
            f"combined net debit ({net_debit}) is not positive - can't size or monitor this spread",
        )
        db.commit()
        return row

    lot_size = get_lot_size(segment, long_symbol)
    if lot_size is None:
        row = _reject_manual_group(
            db, user_id, signal_id, symbol, segment, action, strategy_type, f"could not determine lot size for {long_symbol} on {segment}"
        )
        db.commit()
        return row

    if groups_to_close:
        legs_to_close = legs_by_group(db, groups_to_close)
        for grp in groups_to_close:
            grp_legs = legs_to_close.get(grp.id)
            closed = (
                grp_legs is not None
                and "BUY" in grp_legs
                and _close_group_at_cmp(
                    grp, grp_legs["BUY"], grp_legs.get("SELL"), get_ltp_batch, account, "counter_signal", settings.usdinr_rate
                )
            )
            if not closed:
                row = _reject_manual_group(
                    db, user_id, signal_id, symbol, segment, action, strategy_type,
                    f"could not close conflicting option group {grp.id} (quote unavailable) - "
                    "counter_signal_policy='close_and_flip' requires closing it first",
                )
                db.commit()
                return row

    effective_capital = min(float(account.capital_per_trade), float(account.current_balance))
    capital_unit = "USD" if segment == "CRYPTO" else "INR"
    if segment == "CRYPTO":
        if settings.usdinr_rate is None:
            row = _reject_manual_group(
                db, user_id, signal_id, symbol, segment, action, strategy_type,
                "no USDINR rate configured - set one in Settings to size a CRYPTO option position",
            )
            db.commit()
            return row
        effective_capital = effective_capital / settings.usdinr_rate

    required_lots = option_fixed_lots if option_fixed_lots is not None else 1
    if effective_capital < net_debit * lot_size * required_lots:
        row = _reject_manual_group(
            db, user_id, signal_id, symbol, segment, action, strategy_type,
            f"insufficient account balance ({effective_capital} {capital_unit} available for {segment}, "
            f"need at least {net_debit * lot_size * required_lots} for {required_lots} lot(s))",
        )
        db.commit()
        return row

    # No stop-loss at open time for manual option orders (matches the
    # pre-2026-08-14 auto-provisioned-Strategy path, which never set one
    # either) - use PUT /option-groups/{id}/stop-loss afterward, same as
    # any other already-open group.
    quantity = option_fixed_lots * lot_size if option_fixed_lots is not None else compute_quantity(effective_capital, net_debit, lot_size)

    open_fee = _open_delta_option_fee(segment, entry_spot_price, quantity, long_premium, short_premium)
    if open_fee is not None:
        # open_fee is raw USD - current_balance is always INR-denominated,
        # convert before debiting (same reasoning as open_option_group's
        # identical conversion).
        account.current_balance = float(account.current_balance) - open_fee * settings.usdinr_rate

    effective_square_off_time = square_off_time if square_off_time is not None else account.square_off_time
    group_id = uuid.uuid4()
    group = db_models.OptionPositionGroup(
        id=group_id,
        user_id=user_id,
        signal_id=signal_id,
        strategy_id=None,
        underlying_symbol=symbol,
        exchange=segment,
        segment=segment,
        strategy_type=strategy_type,
        action=action,
        horizon="intraday",
        quantity=quantity,
        net_debit=net_debit,
        sl_scope=sl_scope,
        entry_spot_price=entry_spot_price,
        status="OPEN",
        square_off_time=effective_square_off_time,
        open_fee=open_fee,
        plan_checklist=plan_checklist,
        order_type=order_type,
        trend_followed=trend_followed,
        risk_managed=risk_managed,
        setup_tag=setup_tag or None,
        confidence=confidence,
    )
    db.add(group)

    legs_to_write = [(long_leg_dict, long_symbol, long_premium)]
    if short_leg_dict:
        legs_to_write.append((short_leg_dict, short_symbol, short_premium))
    for leg_dict, leg_symbol, premium in legs_to_write:
        db.add(
            db_models.Position(
                user_id=user_id,
                signal_id=signal_id,
                strategy_id=None,
                symbol=leg_symbol,
                exchange=segment,
                segment=segment,
                action=leg_dict["action"],
                horizon="intraday",
                instrument_type="option",
                quantity=quantity,
                entry_price=premium,
                status="OPEN",
                square_off_time=effective_square_off_time,
                option_group_id=group_id,
            )
        )
    db.commit()
    return group


def submit_option_group_review(
    db: Session,
    user_id: uuid.UUID,
    group_id: uuid.UUID,
    violation: bool,
    notes: Optional[str],
    accepted_loss: bool,
    review_checklist: Optional[list[dict]] = None,
) -> tuple[Optional[db_models.OptionPositionGroup], Optional[str]]:
    """PUT /option-groups/{id}/review - option-group counterpart to
    position_manager.submit_position_review, identical rules/reasons."""
    row = db.get(db_models.OptionPositionGroup, group_id)
    if row is None or row.user_id != user_id:
        return None, "option group not found"
    if row.strategy_id is not None:
        return None, "only manually-opened option groups have a discipline review"
    if row.status != "CLOSED":
        return None, f"option group is {row.status}, not CLOSED"
    if row.reviewed_at is not None:
        return None, "option group already reviewed"
    if row.pnl is not None and float(row.pnl) < 0 and not accepted_loss:
        return None, "must accept the loss before submitting this review"
    row.reviewed_at = datetime.now(dt_timezone.utc)
    row.review_violation = violation
    row.review_notes = notes
    row.review_checklist = review_checklist
    db.commit()
    return row, None


def _close_group_at_cmp(
    group, long_leg, short_leg: Optional[object], get_ltp_batch: GetLtpBatch, account, exit_reason: str,
    usdinr_rate: Optional[float] = None,
) -> bool:
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
    raw_pnl = (combined_price - float(group.net_debit)) * float(group.quantity)
    # No fresh underlying-spot quote fetched here (would be a second
    # get_ltp_batch call just for the fee's notional basis) - falls back to
    # premium-based notional, same graceful degradation
    # _open_delta_option_fee already has for a missing entry_spot_price.
    close_fee = _close_delta_option_fee(group.segment, None, float(group.quantity), long_cmp, short_cmp)
    if close_fee is not None:
        group.close_fee = close_fee
    combined_pnl = raw_pnl - float(group.open_fee or 0) - (close_fee or 0)
    group.exit_time = now
    group.status = "CLOSED"
    group.exit_reason = exit_reason
    _apply_realized_pnl(group, account, combined_pnl, usdinr_rate)
    return True


def compute_group_unrealized_pnl(groups: list, legs: dict, get_ltp_batch: GetLtpBatch) -> dict:
    """Read-only mark-to-market for OPEN groups AND their individual legs -
    mirrors position_manager.compute_unrealized_pnl, extended with the
    underlying's own live spot price (context for setting
    spot_stop_loss_price - see update_group_spot_stop_loss) and each leg's
    own live premium/P&L (the frontend's collapsible legs detail shows
    these per-leg, not just the group's combined figure). One batched
    quote call covers legs + underlyings together, same
    _quotes_by_exchange dedup _evaluate_option_group_exits already uses.

    Returns {group.id: {"combined_price", "unrealized_pnl", "spot_price",
    "legs": {leg.id: (live_price, leg_unrealized_pnl)}}} - a group absent
    from the result had a failed/partial leg quote (spot_price alone can
    still be None even when present, if just the underlying's own quote
    failed - legs remain the authority for whether the group prices at all)."""
    open_groups = [g for g in groups if g.status == "OPEN"]
    all_legs = [pos for g in open_groups for pos in legs.get(g.id, {}).values()]
    underlying_probes = [SimpleNamespace(exchange=g.exchange, symbol=g.underlying_symbol) for g in open_groups]
    quotes = _quotes_by_exchange(all_legs + underlying_probes, get_ltp_batch)

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
        spot_price = quotes.get((group.exchange, group.underlying_symbol))

        leg_mtm = {
            long_leg.id: (long_cmp, compute_pnl(long_leg.action, float(long_leg.entry_price), long_cmp, float(long_leg.quantity)))
        }
        if short_leg is not None:
            leg_mtm[short_leg.id] = (
                short_cmp,
                compute_pnl(short_leg.action, float(short_leg.entry_price), short_cmp, float(short_leg.quantity)),
            )

        result[group.id] = {
            "combined_price": combined_price,
            "unrealized_pnl": unrealized,
            "spot_price": spot_price,
            "legs": leg_mtm,
        }

    return result


def record_option_group_pnl_snapshots(db: Session, get_ltp_batch: GetLtpBatch) -> dict:
    """Persists one OptionGroupPnlSnapshot row per OPEN group with a live
    combined price this tick - the write counterpart to
    compute_group_unrealized_pnl above (reused as-is, unchanged). See
    position_manager.record_position_pnl_snapshots' own docstring for the
    full design/scope notes - this is its group-level mirror, called from
    the same app/scheduler.py run_check_exits tick."""
    open_groups = db.query(db_models.OptionPositionGroup).filter_by(status="OPEN").all()
    legs = legs_by_group(db, open_groups)
    live = compute_group_unrealized_pnl(open_groups, legs, get_ltp_batch)
    for group_id, data in live.items():
        db.add(
            db_models.OptionGroupPnlSnapshot(
                option_group_id=group_id, combined_price=data["combined_price"], unrealized_pnl=data["unrealized_pnl"]
            )
        )
    db.commit()
    return {"recorded": len(live), "checked": len(open_groups)}


def square_off_all_open_option_groups(db: Session, user_id: uuid.UUID, get_ltp_batch: GetLtpBatch) -> dict:
    """Closes every OPEN option group BELONGING TO user_id - only ever
    reachable via the authenticated POST /option-groups/square-off route,
    same scoping reasoning as position_manager.square_off_all_open."""
    open_groups = db.query(db_models.OptionPositionGroup).filter_by(user_id=user_id, status="OPEN").all()
    legs = legs_by_group(db, open_groups)
    accounts = _accounts_by_segment(db, open_groups)
    strategy_accounts = _strategy_accounts_by_id(db, open_groups)
    usdinr_rate = load_settings(db, user_id).usdinr_rate
    closed = 0
    failed = 0
    for group in open_groups:
        group_legs = legs.get(group.id)
        if (
            group_legs is not None
            and "BUY" in group_legs
            and _close_group_at_cmp(
                group, group_legs["BUY"], group_legs.get("SELL"), get_ltp_batch,
                _resolve_capital_account(group, accounts, strategy_accounts), "square_off", usdinr_rate,
            )
        ):
            closed += 1
        else:
            failed += 1
    db.commit()
    return {"closed": closed, "failed": failed, "total_open": len(open_groups)}


def square_off_option_group(db: Session, user_id: uuid.UUID, group_id: uuid.UUID, get_ltp_batch: GetLtpBatch) -> dict:
    group = db.get(db_models.OptionPositionGroup, group_id)
    if group is None or group.user_id != user_id:
        return {"status": "not_found"}
    if group.status != "OPEN":
        return {"status": "not_open", "group_status": group.status}

    group_legs = legs_by_group(db, [group]).get(group.id)
    account = load_capital_account(db, user_id, group.segment, group.strategy_id)
    usdinr_rate = load_settings(db, user_id).usdinr_rate
    if (
        group_legs is None
        or "BUY" not in group_legs
        or not _close_group_at_cmp(group, group_legs["BUY"], group_legs.get("SELL"), get_ltp_batch, account, "manual", usdinr_rate)
    ):
        return {"status": "quote_unavailable"}
    db.commit()
    return {"status": "closed", "group_id": str(group.id), "underlying_symbol": group.underlying_symbol, "pnl": float(group.pnl)}


def update_group_stop_loss(
    db: Session, user_id: uuid.UUID, group_id: uuid.UUID, new_price: float
) -> Optional[db_models.OptionPositionGroup]:
    """Generically useful, not manual-only - editing SL on any already-open
    option group. Scoped to sl_scope='combined' groups only - editing an
    individual leg's own stop_loss_price is out of scope here (would need
    a per-leg endpoint, not this group-level one). Returns the group
    unchanged (caller checks status/sl_scope separately) rather than
    silently no-op'ing on a mismatch."""
    row = db.get(db_models.OptionPositionGroup, group_id)
    if row is None or row.user_id != user_id:
        return None
    if row.sl_scope != "combined":
        return row
    row.combined_stop_loss_price = new_price
    db.commit()
    return row


def update_group_spot_stop_loss(
    db: Session, user_id: uuid.UUID, group_id: uuid.UUID, new_price: float
) -> Optional[db_models.OptionPositionGroup]:
    """Sets the underlying-spot-price stop - independent of sl_scope and
    the premium-based combined_stop_loss_price/individual leg stops above;
    _evaluate_option_group_exits checks both, whichever trips first closes
    the group. Unlike update_group_stop_loss, not restricted to
    sl_scope='combined' - a spot-based stop is orthogonal to how the
    premium side is monitored. Turns off spot_stop_loss_trailing_enabled
    (if it was on) so this explicit edit sticks rather than getting
    silently overwritten by the next auto-trail tick - same "an explicit
    caller action wins" reasoning update_stop_loss (position_manager.py)
    doesn't need since it has no separate manual-edit endpoint at all.
    stop_loss_future_symbol/exchange (what the stop is checked against) is
    deliberately left as-is - this only changes the price, not the
    reference instrument."""
    row = db.get(db_models.OptionPositionGroup, group_id)
    if row is None or row.user_id != user_id:
        return None
    row.spot_stop_loss_price = new_price
    row.spot_stop_loss_trailing_enabled = False
    db.commit()
    return row


def update_group_spot_target(
    db: Session, user_id: uuid.UUID, group_id: uuid.UUID, new_price: float
) -> Optional[db_models.OptionPositionGroup]:
    """Sets the underlying-spot-price take-profit - the sibling of
    update_group_spot_stop_loss above. _evaluate_option_group_exits checks
    it against the same spot quote (whichever of spot stop / spot target /
    premium stop / premium target trips first closes the group). No
    trailing concept - a target never moves."""
    row = db.get(db_models.OptionPositionGroup, group_id)
    if row is None or row.user_id != user_id:
        return None
    row.spot_target_price = new_price
    db.commit()
    return row


def update_group_notes(
    db: Session, user_id: Optional[uuid.UUID], group_id: uuid.UUID, notes: str
) -> Optional[db_models.OptionPositionGroup]:
    """PUT /option-groups/{id}/notes - the option-group sibling of
    position_manager.update_position_notes. Free-text journal note, empty
    string clears it, no gate, OPEN or CLOSED. Not review_notes."""
    row = db.get(db_models.OptionPositionGroup, group_id)
    if row is None or row.user_id != user_id:
        return None
    row.notes = notes or None
    db.commit()
    return row


def update_group_tags(
    db: Session,
    user_id: Optional[uuid.UUID],
    group_id: uuid.UUID,
    *,
    setup_tag: Optional[str] = None,
    set_setup_tag: bool = False,
    confidence: Optional[int] = None,
    set_confidence: bool = False,
) -> Optional[db_models.OptionPositionGroup]:
    """PUT /option-groups/{id}/tags - option-group sibling of
    position_manager.update_position_tags. Partial: `set_*` say which
    fields the request carried; `setup_tag=""` clears the tag."""
    row = db.get(db_models.OptionPositionGroup, group_id)
    if row is None or row.user_id != user_id:
        return None
    if set_setup_tag:
        row.setup_tag = setup_tag or None
    if set_confidence:
        row.confidence = confidence
    db.commit()
    return row


def update_group_square_off_time(
    db: Session, user_id: uuid.UUID, group_id: uuid.UUID, square_off_time: Optional[time]
) -> Optional[db_models.OptionPositionGroup]:
    """PUT /option-groups/{id}/square-off-time - see position_manager.
    update_square_off_time's own comment, identical meaning here.
    square_off_due_option_groups only ever reads the GROUP's own field
    (not its legs'), but the legs' copies are kept in sync anyway - same
    reasoning open_manual_option_group already keeps them in sync at
    create time, for consistency if anything else ever reads a leg's own
    value."""
    row = db.get(db_models.OptionPositionGroup, group_id)
    if row is None or row.user_id != user_id or row.status != "OPEN":
        return None
    row.square_off_time = square_off_time
    db.query(db_models.Position).filter_by(option_group_id=group_id, status="OPEN").update({"square_off_time": square_off_time})
    db.commit()
    return row


def _evaluate_option_group_square_off_due(
    groups: list,
    legs: dict,
    get_ltp_batch: GetLtpBatch,
    now_local,
    accounts_by_segment: dict,
    strategy_accounts: Optional[dict] = None,
    usdinr_rate_by_user: Optional[dict] = None,
) -> dict:
    """Pure logic (no DB query/commit) - mirrors
    position_manager._evaluate_square_off_due at the group level.
    strategy_accounts/usdinr_rate_by_user are optional (default {}) - see
    that function's own docstring for why (a cross-tenant batch can mix
    groups from several users, each with their own configured rate)."""
    due = [g for g in groups if g.square_off_time is not None and now_local >= g.square_off_time]
    if not due:
        return {"closed": 0, "failed": 0, "checked": 0}

    all_legs = [pos for g in due for pos in legs.get(g.id, {}).values()]
    quotes = _quotes_by_exchange(all_legs, get_ltp_batch)
    rates = usdinr_rate_by_user or {}
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
        raw_pnl = (combined_price - float(group.net_debit)) * float(group.quantity)
        close_fee = _close_delta_option_fee(group.segment, None, float(group.quantity), long_cmp, short_cmp)
        if close_fee is not None:
            group.close_fee = close_fee
        combined_pnl = raw_pnl - float(group.open_fee or 0) - (close_fee or 0)
        group.exit_time = now
        group.status = "CLOSED"
        group.exit_reason = "square_off"
        _apply_realized_pnl(
            group, _resolve_capital_account(group, accounts_by_segment, strategy_accounts), combined_pnl, rates.get(group.user_id)
        )
        closed += 1

    return {"closed": closed, "failed": failed, "checked": len(due)}


def square_off_due_option_groups(db: Session, get_ltp_batch: GetLtpBatch) -> dict:
    """Background job (every user AND the automated flow) - see
    position_manager.square_off_due_positions' own comment on why
    now_local stays platform-wide while usdinr_rate is resolved per user."""
    exec_settings = load_settings(db)
    now_local = datetime.now(dt_timezone.utc).astimezone(ZoneInfo(exec_settings.timezone)).time()
    open_groups = db.query(db_models.OptionPositionGroup).filter_by(status="OPEN").all()
    legs = legs_by_group(db, open_groups)
    accounts = _accounts_by_segment(db, open_groups)
    strategy_accounts = _strategy_accounts_by_id(db, open_groups)
    usdinr_rates = _usdinr_rate_by_user(db, open_groups)
    result = _evaluate_option_group_square_off_due(
        open_groups, legs, get_ltp_batch, now_local, accounts, strategy_accounts, usdinr_rates
    )
    db.commit()
    return result


def _evaluate_option_group_exits(
    groups: list,
    legs: dict,
    get_ltp_batch: GetLtpBatch,
    accounts_by_segment: dict,
    strategy_accounts: Optional[dict] = None,
    get_candle_history: Optional[GetCandleHistory] = None,
    usdinr_rate_by_user: Optional[dict] = None,
) -> dict:
    """Pure logic (no DB query/commit) - mirrors position_manager
    ._evaluate_exits at the group level (no previous_candle - see module
    docstring's scope notes). `legs`: group.id -> {'BUY': Position,
    'SELL': Position}, pre-queried by the caller (check_option_group_exits).
    strategy_accounts is optional (default {}) - see position_manager.
    _evaluate_exits' own docstring for why.

    sl_scope='combined' (default) checks the group's own combined_stop_loss_price/
    combined_target_price against the combined (long-short) price, exactly
    as before. sl_scope='individual' instead checks EACH leg's own
    stop_loss_price/target_price (set at open time, see open_option_group)
    against that leg's own fresh quote, action-aware - whichever leg trips
    first still closes the WHOLE group together, same as combined mode;
    this only changes what triggers the close, never leaves one leg open.
    Either mode credits/debits the account off the same real combined P&L
    (combined_price - net_debit) * quantity - the trigger condition never
    changes what the position was actually worth at exit.

    spot_stop_loss_price is checked independently of all the above - a
    third, orthogonal way to trip the same close - against either the
    UNDERLYING's own fresh quote (a user-set stop, stop_loss_future_symbol
    is None) or the underlying's nearest FUTURE contract's fresh quote
    (an auto-computed SuperTrend stop, see open_option_group), whichever
    this group actually carries. group.action-aware, same direction
    convention compute_stop_loss_percent_price uses: BUY closes when the
    reference price falls to/through it, SELL when it rises to/through it.

    Trailing (only spot_stop_loss_trailing_enabled groups, mirrors
    position_manager._evaluate_exits' own trailing block) re-anchors
    spot_stop_loss_price to the future's latest SuperTrend line value each
    tick, only if the new candidate is MORE favorable than the stored
    value - it never loosens. get_candle_history is Optional (default
    None) purely so existing callers/tests that only ever exercise
    non-trailing groups don't need updating - a trailing-enabled group
    with no get_candle_history supplied is simply skipped for trailing,
    same as a candle fetch failure below."""
    if not groups:
        return {"closed_stop_loss": 0, "closed_target": 0, "trailed": 0, "checked": 0}

    all_legs = [pos for g in groups for pos in legs.get(g.id, {}).values()]
    underlying_probes = [SimpleNamespace(exchange=g.exchange, symbol=g.underlying_symbol) for g in groups]
    future_probes = [
        SimpleNamespace(exchange=g.stop_loss_future_exchange, symbol=g.stop_loss_future_symbol)
        for g in groups
        if g.stop_loss_future_symbol is not None
    ]
    quotes = _quotes_by_exchange(all_legs + underlying_probes + future_probes, get_ltp_batch)
    closed_stop_loss = 0
    closed_target = 0
    trailed = 0
    candle_history_cache: dict[tuple[str, str, str], list[dict]] = {}
    now = datetime.now(dt_timezone.utc)
    rates = usdinr_rate_by_user or {}

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

        if group.stop_loss_future_symbol is not None:
            spot_cmp = quotes.get((group.stop_loss_future_exchange, group.stop_loss_future_symbol))
        else:
            spot_cmp = quotes.get((group.exchange, group.underlying_symbol))
        spot_sl_hit = group.spot_stop_loss_price is not None and spot_cmp is not None and (
            (group.action == "BUY" and spot_cmp <= float(group.spot_stop_loss_price))
            or (group.action == "SELL" and spot_cmp >= float(group.spot_stop_loss_price))
        )
        # Sibling of spot_sl_hit - a take-profit on the underlying's own
        # price (the Live Chart panel's Target field for an option order),
        # checked against the same spot_cmp. Whichever of the four stop/
        # target mechanisms trips first closes the whole group.
        spot_target_hit = group.spot_target_price is not None and spot_cmp is not None and (
            (group.action == "BUY" and spot_cmp >= float(group.spot_target_price))
            or (group.action == "SELL" and spot_cmp <= float(group.spot_target_price))
        )
        if not (sl_hit or target_hit or spot_sl_hit or spot_target_hit):
            if (
                group.spot_stop_loss_trailing_enabled
                and group.spot_stop_loss_price is not None
                and group.spot_stop_loss_indicator_type is not None
                and group.stop_loss_future_symbol is not None
                and get_candle_history is not None
            ):
                key = (group.stop_loss_future_exchange, group.stop_loss_future_symbol, group.spot_stop_loss_interval)
                if key not in candle_history_cache:
                    try:
                        params = group.spot_stop_loss_indicator_params or {}
                        warmup_from, warmup_to = _indicator_history_window(params.get("period", 20), group.spot_stop_loss_interval)
                        candle_history_cache[key] = get_candle_history(
                            group.stop_loss_future_exchange,
                            group.stop_loss_future_symbol,
                            group.spot_stop_loss_interval,
                            warmup_from,
                            warmup_to,
                        )
                    except Exception:
                        logger.exception(
                            "failed to fetch trailing candle history for option group %s future %s",
                            group.id, group.stop_loss_future_symbol,
                        )
                        candle_history_cache[key] = []
                compute = _STOP_LOSS_COMPUTE_FUNCS.get(group.spot_stop_loss_indicator_type)
                # spot_cmp above is already the future's own fresh quote
                # whenever stop_loss_future_symbol is set (the same
                # condition gating this whole block).
                if compute is not None and candle_history_cache[key] and spot_cmp is not None:
                    raw_candidate = compute(candle_history_cache[key], group.spot_stop_loss_indicator_params or {})
                    # Same wrong-side guard as position_manager._evaluate_exits'
                    # own trailing block - discard a candidate that isn't on
                    # the protective side of the future's CURRENT price.
                    if raw_candidate is not None and (
                        (group.action == "BUY" and raw_candidate < spot_cmp) or (group.action == "SELL" and raw_candidate > spot_cmp)
                    ):
                        current_stop = float(group.spot_stop_loss_price)
                        more_favorable = raw_candidate > current_stop if group.action == "BUY" else raw_candidate < current_stop
                        if more_favorable:
                            group.spot_stop_loss_price = raw_candidate
                            trailed += 1
            continue

        if sl_hit:
            group_reason_prefix = "individual" if group.sl_scope == "individual" else "combined"
            group_reason = f"{group_reason_prefix}_stop_loss"
            leg_reason = "stop_loss"
        elif target_hit:
            group_reason_prefix = "individual" if group.sl_scope == "individual" else "combined"
            group_reason = f"{group_reason_prefix}_target"
            leg_reason = "target"
        elif spot_sl_hit:
            group_reason = "spot_stop_loss"
            # Leg-level exit_reason is the plain 'stop_loss'/'target' every
            # other position already uses (positions.exit_reason's own
            # CHECK constraint has no 'spot_'/'combined_'/'individual_'
            # variants at all - only the group's own exit_reason does).
            leg_reason = "stop_loss"
        else:
            group_reason = "spot_target"
            leg_reason = "target"

        legs_to_close = [(long_leg, long_cmp)] + ([(short_leg, short_cmp)] if short_leg else [])
        for pos, cmp_price in legs_to_close:
            pos.exit_price = cmp_price
            pos.exit_time = now
            pos.pnl = compute_pnl(pos.action, float(pos.entry_price), cmp_price, float(pos.quantity))
            pos.status = "CLOSED"
            pos.exit_reason = leg_reason

        raw_pnl = (combined_price - float(group.net_debit)) * float(group.quantity)
        close_fee = _close_delta_option_fee(group.segment, None, float(group.quantity), long_cmp, short_cmp)
        if close_fee is not None:
            group.close_fee = close_fee
        combined_pnl = raw_pnl - float(group.open_fee or 0) - (close_fee or 0)
        group.exit_time = now
        group.status = "CLOSED"
        group.exit_reason = group_reason
        _apply_realized_pnl(
            group, _resolve_capital_account(group, accounts_by_segment, strategy_accounts), combined_pnl, rates.get(group.user_id)
        )

        if sl_hit or spot_sl_hit:
            closed_stop_loss += 1
        else:
            closed_target += 1

    return {"closed_stop_loss": closed_stop_loss, "closed_target": closed_target, "trailed": trailed, "checked": len(groups)}


def check_option_group_exits(db: Session, get_ltp_batch: GetLtpBatch, get_candle_history: Optional[GetCandleHistory] = None) -> dict:
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
            # A spot-based stop OR target can be the ONLY thing armed on a
            # group (combined_stop_loss_price/target both NULL, sl_scope
            # stays 'combined') - same reasoning as the sl_scope=
            # 'individual' clause above.
            | (db_models.OptionPositionGroup.spot_stop_loss_price.isnot(None))
            | (db_models.OptionPositionGroup.spot_target_price.isnot(None))
        )
        .all()
    )
    legs = legs_by_group(db, candidates)
    accounts = _accounts_by_segment(db, candidates)
    strategy_accounts = _strategy_accounts_by_id(db, candidates)
    usdinr_rates = _usdinr_rate_by_user(db, candidates)
    result = _evaluate_option_group_exits(candidates, legs, get_ltp_batch, accounts, strategy_accounts, get_candle_history, usdinr_rates)
    db.commit()
    return result
