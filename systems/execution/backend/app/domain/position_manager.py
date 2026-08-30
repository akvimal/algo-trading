"""Position lifecycle: open on signal, close at square-off.

The pure decision functions (compute_pnl, compute_quantity, is_supported,
is_within_intraday_window) are kept free of DB/session state so they're
directly unit-testable; open_position/square_off_all_open wire them to
persistence.
"""

import logging
import uuid
from datetime import date, datetime, time, timedelta
from datetime import timezone as dt_timezone
from types import SimpleNamespace
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.config import settings as app_settings
from app.domain.delta_fees import compute_futures_liquidation_fee, compute_futures_trading_fee, compute_liquidation_price, compute_margin_posted
from app.domain.live_broker import (
    cancel_resting_order_scheduled,
    is_live_enabled,
    modify_resting_order_scheduled,
    submit_entry_order_scheduled,
    submit_exit_order_scheduled,
    submit_live_order,
    submit_resting_stop_loss,
    submit_resting_stop_loss_scheduled,
)
from app.domain.models import ChecklistAnswer, ExecutionSettings, ResolvedOrder

logger = logging.getLogger(__name__)

GetLtpBatch = Callable[[str, list[str]], dict[str, float]]  # (exchange, symbols) -> {symbol: price}
GetPreviousCandle = Callable[[str, str, str], Optional[dict]]  # (exchange, symbol, interval) -> candle dict or None
# (exchange, symbol, interval, from_date, to_date) -> oldest-first candle
# dicts (each with at least "close") - stop_loss_method='indicator' only,
# needs a full warm-up series, unlike GetPreviousCandle's single bar.
GetCandleHistory = Callable[[str, str, str, date, date], list[dict]]
GetLotSize = Callable[[str, str], Optional[float]]  # (exchange, symbol) -> lot size, or None if unknown
# (segment, underlying) -> {chart_symbol, chart_exchange, trade_symbol,
# trade_exchange, lot_size, expiry}, or None if unresolvable - same shape
# as option_position_manager.py's own ResolveUnderlying (not imported from
# there to avoid a circular import - that module already imports FROM this
# one).
ResolveUnderlying = Callable[[str, str], Optional[dict]]


def compute_pnl(action: str, entry_price: float, exit_price: float, quantity: float) -> float:
    if action == "BUY":
        return (exit_price - entry_price) * quantity
    return (entry_price - exit_price) * quantity  # SELL = intraday short


def compute_quantity(capital_per_trade: float, price: float, lot_size: float = 1) -> float:
    """Whole LOTS, returned as total units (lots * lot_size) - lot_size=1
    for instruments with no lot concept (NSE cash equity, and MCX
    commodity futures - Dhan's own lot-size convention there is already
    1), a real integer multiplier for NSE/MCX F&O (e.g. NIFTY futures=65,
    BANKNIFTY futures=30), and a real fractional multiplier for Delta
    Exchange India CRYPTO perpetuals (e.g. BTCUSD=0.001 - see
    market-data's DeltaProvider.get_lot_size). `lots` itself always stays
    a whole number (you can't buy a fractional NUMBER of lots) even
    though the returned total-units quantity is fractional for CRYPTO.
    Floors to a minimum of 1 lot even if capital_per_trade can't strictly
    afford it - a position always opens rather than being rejected for
    undersized capital. See docs/architecture.md."""
    lots = max(1, int(capital_per_trade // (price * lot_size)))
    return lots * lot_size


def compute_stop_loss_percent_price(action: str, entry_price: float, stop_loss_percent: float) -> float:
    if action == "BUY":
        return entry_price * (1 - stop_loss_percent / 100)
    return entry_price * (1 + stop_loss_percent / 100)  # SELL - stop is above entry


def compute_target_percent_price(action: str, entry_price: float, target_percent: float) -> float:
    if action == "BUY":
        return entry_price * (1 + target_percent / 100)
    return entry_price * (1 - target_percent / 100)  # SELL - target is below entry


def compute_ema(closes: list[float], period: int) -> list[Optional[float]]:
    """Standard EMA - direct port of signal-generation's
    app/domain/regime.py compute_ema. Duplicated, not imported: execution
    can't import signal-generation's code (systems/* self-contained, see
    docs/architecture.md) - same "duplicate, don't cross-import" precedent
    app/domain/option_templates.py already established for a different
    piece of signal-processing's logic."""
    n = len(closes)
    ema: list[Optional[float]] = [None] * n
    if n < period:
        return ema
    seed = sum(closes[:period]) / period
    ema[period - 1] = seed
    k = 2 / (period + 1)
    for i in range(period, n):
        ema[i] = closes[i] * k + ema[i - 1] * (1 - k)
    return ema


def compute_atr(candles: list[dict], period: int) -> list[Optional[float]]:
    """Wilder-smoothed true range - direct port of signal-generation's
    app/domain/regime.py compute_atr, operating on the raw candle dicts
    get_candle_history returns (each with at least high/low/close) rather
    than its CandleClose dataclass - same duplicate-not-import reasoning
    as compute_ema above."""
    n = len(candles)
    atr: list[Optional[float]] = [None] * n
    if n <= period:
        return atr

    true_ranges = [
        max(
            candles[i]["high"] - candles[i]["low"],
            abs(candles[i]["high"] - candles[i - 1]["close"]),
            abs(candles[i]["low"] - candles[i - 1]["close"]),
        )
        for i in range(1, n)
    ]

    avg_tr = sum(true_ranges[:period]) / period
    atr[period] = avg_tr
    for i in range(period, len(true_ranges)):
        avg_tr = (avg_tr * (period - 1) + true_ranges[i]) / period
        atr[i + 1] = avg_tr
    return atr


def compute_supertrend(candles: list[dict], period: int, multiplier: float) -> list[Optional[float]]:
    """Standard SuperTrend line - direct port of signal-generation's
    app/domain/regime.py compute_supertrend (see that function's own
    docstring for why this returns one flat scalar series rather than
    separate band/direction outputs). Duplicated, not imported - same
    reasoning as compute_ema/compute_atr above."""
    n = len(candles)
    atr = compute_atr(candles, period)
    supertrend: list[Optional[float]] = [None] * n
    final_upper: list[Optional[float]] = [None] * n
    final_lower: list[Optional[float]] = [None] * n
    direction: list[Optional[int]] = [None] * n

    for i in range(n):
        if atr[i] is None:
            continue
        mid = (candles[i]["high"] + candles[i]["low"]) / 2
        basic_upper = mid + multiplier * atr[i]
        basic_lower = mid - multiplier * atr[i]

        prev = i - 1
        if prev < 0 or final_upper[prev] is None:
            final_upper[i] = basic_upper
            final_lower[i] = basic_lower
            direction[i] = -1 if candles[i]["close"] <= basic_upper else 1
            supertrend[i] = final_upper[i] if direction[i] == -1 else final_lower[i]
            continue

        final_upper[i] = (
            basic_upper
            if (basic_upper < final_upper[prev] or candles[prev]["close"] > final_upper[prev])
            else final_upper[prev]
        )
        final_lower[i] = (
            basic_lower
            if (basic_lower > final_lower[prev] or candles[prev]["close"] < final_lower[prev])
            else final_lower[prev]
        )

        if direction[prev] == 1:
            if candles[i]["close"] < final_lower[i]:
                direction[i] = -1
                supertrend[i] = final_upper[i]
            else:
                direction[i] = 1
                supertrend[i] = final_lower[i]
        else:
            if candles[i]["close"] > final_upper[i]:
                direction[i] = 1
                supertrend[i] = final_lower[i]
            else:
                direction[i] = -1
                supertrend[i] = final_upper[i]

    return supertrend


def _ema_stop_value(candles: list[dict], params: dict) -> Optional[float]:
    ema = compute_ema([c["close"] for c in candles], params["period"])
    return ema[-1] if ema and ema[-1] is not None else None


def _supertrend_stop_value(candles: list[dict], params: dict) -> Optional[float]:
    st = compute_supertrend(candles, params["period"], params["multiplier"])
    return st[-1] if st and st[-1] is not None else None


# stop_loss_indicator_type -> (candles, params) -> candidate stop value.
# Takes the raw candle dicts (not just closes) since SuperTrend needs
# high/low too - EMA just ignores them. Mirrors signal-generation's own
# _STOP_LOSS_COMPUTE_FUNCS (app/domain/backtest.py) exactly - a deliberate
# duplicate registry, not shared, so live and backtest can never disagree
# about what a given indicator_type+params computes. Adding a second
# indicator type (e.g. SuperTrend) means a new entry here AND there, plus
# widening both systems' DB CHECK constraints and the contract's own enum
# - see signal-generation's app/domain/rule.py for the equivalent comment
# on its own params-validation registry.
_STOP_LOSS_COMPUTE_FUNCS: dict[str, Callable[[list[dict], dict], Optional[float]]] = {
    "ema": _ema_stop_value,
    "supertrend": _supertrend_stop_value,
}

# Rough over-estimate of calendar days needed to cover `bar_count` bars at
# `interval` - mirrors signal-generation's app/domain/engine.py
# history_window exactly (same bar-count-to-calendar-days shape,
# duplicated locally rather than imported). Extra empty days cost nothing
# but a wider market-data query.
_INDICATOR_INTERVAL_MINUTES = {"1min": 1, "3min": 3, "5min": 5, "15min": 15, "25min": 25, "30min": 30, "60min": 60}
_INDICATOR_MIN_HISTORY_DAYS = 5
_INDICATOR_MAX_HISTORY_DAYS = 30


def _indicator_history_window(period: int, interval: str) -> tuple[date, date]:
    # Must be IST's "today", not UTC's - market-data's candle history is
    # IST-calendar-dated, and UTC trails IST by up to a full calendar day
    # for 5h30m/day (18:30-24:00 UTC = 00:00-05:30 IST next day). Mirrors
    # the same fix in signal-generation's app/domain/engine.py
    # history_window - see that function's docstring for the reproduced
    # live bug (a CRYPTO strategy silently never saw candles during that
    # window because `to=` stayed frozen at the previous IST day).
    today = datetime.now(dt_timezone.utc).astimezone(ZoneInfo("Asia/Kolkata")).date()
    minutes = _INDICATOR_INTERVAL_MINUTES.get(interval, 5)
    bars_per_day = max(1, (6.25 * 60) // minutes)  # ~6h15m NSE session as a rough yardstick
    days_needed = max(_INDICATOR_MIN_HISTORY_DAYS, min(_INDICATOR_MAX_HISTORY_DAYS, int(period / bars_per_day) + 2))
    return today - timedelta(days=days_needed), today


def compute_risk_based_quantity(
    capital_per_trade: float, risk_per_trade_pct: float, entry_price: float, stop_loss_price: float, lot_size: float = 1
) -> float:
    """quantity = min(risk_amount / stop_distance, the existing
    capital_per_trade value cap), in whole LOTS - risk-based sizing never
    bypasses the capital ceiling, it can only size smaller than it. Same
    lot-size treatment as compute_quantity (whole lots, floors to a
    minimum of 1 lot rather than being rejected for undersized
    risk/capital). Caller must ensure stop_loss_price != entry_price
    first - a zero stop distance is a distinct rejection case (see
    open_position), not handled here."""
    stop_distance = abs(entry_price - stop_loss_price)
    risk_amount = capital_per_trade * risk_per_trade_pct / 100
    risk_based_lots = int(risk_amount // (stop_distance * lot_size))
    # Computed directly from capital/price/lot_size, NOT by calling
    # compute_quantity() and dividing back out by lot_size - that
    # multiply-then-divide round trip is exact for whole-number lot_size
    # (NSE/MCX F&O) but silently under-counts by 1 lot for many (capital,
    # price, lot_size) combinations once lot_size is a real CRYPTO
    # fraction (e.g. 0.001), since float division has no tolerance for
    # the representation error the earlier multiply introduced.
    capital_capped_lots = max(1, int(capital_per_trade // (entry_price * lot_size)))
    lots = max(1, min(risk_based_lots, capital_capped_lots))
    return lots * lot_size


def is_supported(horizon: str, instrument_type: str) -> bool:
    """Intraday spot or future positions are handled here - options remain
    rejected outside `horizon='intraday'` until that resolution/execution
    logic exists. `future` was added alongside the in-house RSI/SMA(RSI)
    engine (Phase 3) - a deliberate pull-forward of one piece of what was
    originally planned as Phase 4, so that engine's signals are actually
    tradeable rather than permanently REJECTED. `positional` + `spot` was
    added later for an external multi-day-hold strategy (optionally NSE
    MTF-leveraged, see the CRYPTO-leverage-style block in open_position) -
    `positional` + `future` stays unsupported (not asked for). See
    docs/architecture.md."""
    if horizon == "intraday":
        return instrument_type in ("spot", "future")
    return horizon == "positional" and instrument_type == "spot"


def is_within_intraday_window(now: datetime, square_off_time: Optional[time], tz_name: str) -> bool:
    """square_off_time is the position's SEGMENT's own configured cutoff
    (execution.accounts.square_off_time) now, not a per-Strategy value -
    None means that segment never force-closes (CRYPTO's default, since
    crypto trades 24/7) - always within window in that case."""
    if square_off_time is None:
        return True
    local_now = now.astimezone(ZoneInfo(tz_name))
    return local_now.time() < square_off_time


def _resolve_signal_conflicts(open_positions: list, order: ResolvedOrder) -> tuple[list, Optional[str]]:
    """open_positions: already filtered to this symbol/status=OPEN. Returns
    (positions_to_close, reject_reason). Opposite-direction positions are
    closed when counter_signal_policy='close_and_flip' - this takes effect
    synchronously in open_position(), before any later SL/square-off check
    ever runs, which is what gives it precedence over those. A
    same-direction position blocks the new order only when
    duplicate_signal_policy='skip'."""
    same_direction = [p for p in open_positions if p.action == order.action]
    opposite_direction = [p for p in open_positions if p.action != order.action]

    positions_to_close = (
        opposite_direction if (opposite_direction and order.counter_signal_policy == "close_and_flip") else []
    )

    if same_direction and order.duplicate_signal_policy == "skip":
        return (
            positions_to_close,
            "symbol already has an open position in the same direction and duplicate_signal_policy=skip",
        )
    return positions_to_close, None


_DEFAULT_ACCOUNT_DEFAULTS: dict[str, dict] = {
    "NSE": {"starting_balance": 200000, "square_off_time": time(15, 0)},
    "MCX": {"starting_balance": 200000, "square_off_time": time(22, 0)},
    "CRYPTO": {"starting_balance": 200000, "square_off_time": None},
}


def load_settings(db: Session, user_id: Optional[uuid.UUID] = None) -> ExecutionSettings:
    """user_id=None (default) loads the legacy platform-wide row, read by
    the automated Strategy-driven flow - always expected to already exist
    (seeded in infra/postgres/init/02-execution.sql). A SaaS user's own
    row (user_id set) is created lazily with sane defaults the first time
    it's needed, same pattern load_account uses below."""
    row = db.query(db_models.Settings).filter_by(user_id=user_id).one_or_none()
    if row is None and user_id is not None:
        row = db_models.Settings(user_id=user_id, timezone="Asia/Kolkata")
        db.add(row)
        db.commit()
    return ExecutionSettings(
        timezone=row.timezone, usdinr_rate=float(row.usdinr_rate) if row.usdinr_rate is not None else None
    )


def load_account(db: Session, user_id: Optional[uuid.UUID], segment: str) -> Optional[db_models.Account]:
    """user_id=None loads the legacy platform-wide account for `segment`
    (automated flow) - always expected to already exist, returns None if
    somehow missing, same as before this function took a user_id at all.
    A SaaS user's own account (user_id set) is created lazily, with the
    same starting defaults the platform seed uses, the first time it's
    needed - a new signup's first manual order shouldn't fail just
    because they haven't visited a Settings page yet."""
    row = db.query(db_models.Account).filter_by(user_id=user_id, segment=segment).one_or_none()
    if row is None and user_id is not None:
        defaults = _DEFAULT_ACCOUNT_DEFAULTS.get(segment)
        if defaults is None:
            return None
        row = db_models.Account(
            user_id=user_id,
            segment=segment,
            starting_balance=defaults["starting_balance"],
            current_balance=defaults["starting_balance"],
            capital_per_trade=50000,
            risk_per_trade_pct=1.0,
            square_off_time=defaults["square_off_time"],
        )
        db.add(row)
        db.commit()
    return row


def load_capital_account(db: Session, user_id: Optional[uuid.UUID], segment: str, strategy_id: Optional[str]):
    """The account to size against and credit/debit realized P&L on - a
    strategy_id with a execution.strategy_accounts row of its own gets
    THAT (isolated capital pool), everything else (no strategy_id at all -
    a manual order - or a strategy_id with no dedicated row, the default)
    falls back to the shared segment account, exactly as before this
    table existed. Deliberately separate from load_account: leverage/
    square_off_time are NEVER read off what this returns - those two stay
    segment-only, callers that need them call load_account too. See
    infra/postgres/init/02-execution.sql's own comment on
    execution.strategy_accounts. Only ever called from the automated
    Strategy-driven flow (open_position/open_option_group) - a manual
    order has no strategy_id at all, so it calls load_account directly -
    strategy_accounts itself carries no user_id at all for that reason."""
    if strategy_id is not None:
        strategy_account = db.get(db_models.StrategyAccount, uuid.UUID(str(strategy_id)))
        if strategy_account is not None:
            return strategy_account
    return load_account(db, user_id, segment)


def _strategy_accounts_by_id(db: Session, positions: list) -> dict[str, db_models.StrategyAccount]:
    """Batch counterpart to load_capital_account, for the closing paths
    that operate on many positions/groups at once (mirrors
    _accounts_by_segment's own shape/reasoning). Keyed by str(strategy_id)
    since positions.strategy_id is a UUID column but comparing/hashing as
    str avoids any UUID-vs-str equality surprises across the ORM boundary.
    Only strategy_ids that actually HAVE a dedicated row are present in
    the result - callers fall back to the segment account (via
    accounts_by_segment) for every key not found here, same optional-
    override semantics load_capital_account has for the single-lookup
    case."""
    strategy_ids = {pos.strategy_id for pos in positions if pos.strategy_id is not None}
    if not strategy_ids:
        return {}
    rows = db.query(db_models.StrategyAccount).filter(db_models.StrategyAccount.strategy_id.in_(strategy_ids)).all()
    return {str(row.strategy_id): row for row in rows}


def _resolve_capital_account(pos, accounts_by_segment: dict, strategy_accounts: Optional[dict]):
    """Same optional-override resolution load_capital_account does for a
    single lookup, applied to an already-fetched pair of batch dicts - the
    shared piece _evaluate_exits/_evaluate_square_off_due (and their
    option-group mirrors) each call per position/group in their loop."""
    if strategy_accounts and pos.strategy_id is not None:
        account = strategy_accounts.get(str(pos.strategy_id))
        if account is not None:
            return account
    return accounts_by_segment.get((pos.user_id, pos.segment))


def _accounts_by_segment(db: Session, positions: list) -> dict[tuple, db_models.Account]:
    """One query (two, if both the platform-wide and per-user accounts are
    both in play) for the distinct (user_id, segment) pairs among
    `positions` - mirrors _quotes_by_exchange's per-distinct-key batching
    shape. Used by the CROSS-TENANT closing paths (square_off_due_positions,
    check_exits) which iterate every OPEN position regardless of owner, so
    the pure logic functions can credit/debit balances without querying the
    DB themselves. Keyed by (user_id, segment), not segment alone -
    execution.accounts can now have several rows per segment (one per
    user, plus the legacy NULL one), so segment alone is no longer unique.
    Split into two queries (NULL user_id vs. real ones) since SQL tuple-IN
    comparisons don't match NULL members."""
    pairs = {(pos.user_id, pos.segment) for pos in positions}
    if not pairs:
        return {}
    null_segments = {segment for uid, segment in pairs if uid is None}
    user_pairs = {(uid, segment) for uid, segment in pairs if uid is not None}

    rows: list[db_models.Account] = []
    if null_segments:
        rows.extend(
            db.query(db_models.Account)
            .filter(db_models.Account.user_id.is_(None), db_models.Account.segment.in_(null_segments))
            .all()
        )
    if user_pairs:
        from sqlalchemy import tuple_

        rows.extend(
            db.query(db_models.Account).filter(tuple_(db_models.Account.user_id, db_models.Account.segment).in_(user_pairs)).all()
        )
    return {(row.user_id, row.segment): row for row in rows}


def _usdinr_rate_by_user(db: Session, positions: list) -> dict:
    """CROSS-TENANT batch counterpart to load_settings' own usdinr_rate -
    each position in a scheduler-job batch may belong to a different user
    with their own configured rate (or the automated flow's legacy
    platform-wide one), unlike load_settings' single-user call shape.
    Missing users fall back to None (same as load_settings returning a
    freshly-created blank row would) rather than raising."""
    user_ids = {pos.user_id for pos in positions}
    if not user_ids:
        return {}
    real_ids = {uid for uid in user_ids if uid is not None}
    rows: list[db_models.Settings] = []
    if None in user_ids:
        rows.extend(db.query(db_models.Settings).filter(db_models.Settings.user_id.is_(None)).all())
    if real_ids:
        rows.extend(db.query(db_models.Settings).filter(db_models.Settings.user_id.in_(real_ids)).all())
    by_user = {row.user_id: (float(row.usdinr_rate) if row.usdinr_rate is not None else None) for row in rows}
    return {uid: by_user.get(uid) for uid in user_ids}


def _net_pnl_with_costs(pos, exit_price: float, raw_pnl: float) -> float:
    """Nets every position-lifecycle cost out of the raw price-distance
    pnl, in place, for whichever of the two costs below (if either)
    applies to `pos` - a no-op returning raw_pnl unchanged for a plain
    position with neither. Every one of this function's callers is about
    to persist `pos` anyway, so both branches set their own field(s) as a
    side effect (audit trail). Shared by every close path EXCEPT the
    liquidation branch in _evaluate_exits, which uses its own Rule E
    total_cost formula instead (see that branch's own comment) - a
    liquidated position can't also be NSE MTF (CRYPTO-future only).

    Delta Exchange fee simulation, Rule F: nets pos.open_fee/close_fee for
    a CRYPTO-future position that went through _open_delta_fee_fields
    (pos.open_fee is not None). Zero behavior change from before this
    function had a second cost to net out.

    NSE MTF interest: for a positional NSE spot position opened with
    leverage > 1 (pos.margin_posted is not None and pos.segment == "NSE" -
    margin_posted is also set for a CRYPTO future, hence the segment
    check), computed once here at close - not accrued daily - as
    borrowed_amount * (annual rate / 365) * days_held, where borrowed_amount
    is the notional at entry minus the trader's own capital already
    frozen in margin_posted. days_held floors to 1 (an intraday-length MTF
    hold still owes at least one day's interest) using calendar days
    between entry_time/exit_time - a documented approximation, not
    trading-day-precise. pos.exit_time is already set by every caller
    before this function runs."""
    if pos.open_fee is not None:
        close_fee = compute_futures_trading_fee(exit_price * float(pos.quantity))
        pos.close_fee = close_fee
        raw_pnl = raw_pnl - float(pos.open_fee) - close_fee

    if pos.segment == "NSE" and pos.margin_posted is not None:
        notional_at_entry = float(pos.entry_price) * float(pos.quantity)
        borrowed_amount = notional_at_entry - float(pos.margin_posted)
        days_held = max(1, (pos.exit_time.date() - pos.entry_time.date()).days)
        interest = borrowed_amount * (float(pos.mtf_interest_rate_pct) / 100 / 365) * days_held
        pos.interest_charged = interest
        raw_pnl = raw_pnl - interest

    return raw_pnl


def _apply_realized_pnl(pos, account, pnl: float, usdinr_rate: Optional[float] = None) -> None:
    """Sets pos.pnl (always in the position's own native currency - raw
    USD for CRYPTO, INR for NSE/MCX, matching entry_price/exit_price so
    pnl stays a meaningful ratio against them for %-of-entry displays) and,
    if an account was found, credits/debits its current_balance - which is
    ALWAYS INR-denominated, every segment, unlike pnl itself - by the same
    amount, converted through usdinr_rate first for a CRYPTO position (the
    one segment priced in a foreign currency, see docs/architecture.md's
    USDINR section). account may be None (shouldn't happen - positions.
    segment is NOT NULL + FK-enforced - but defended rather than crashing a
    close over a bookkeeping gap).

    usdinr_rate is None for every non-CRYPTO caller (never read - a plain
    coincidental no-op) and should never be None for a CRYPTO one in
    practice (every CRYPTO open path already refuses to open at all
    without a configured rate) - defended anyway (logs and falls back to
    crediting the raw USD figure unconverted, same as this bug's pre-fix
    behavior) rather than leaving a position permanently stuck OPEN over a
    rate that was cleared out from under it after it opened."""
    pos.pnl = pnl
    if account is None:
        logger.error("no account found for segment %s - position %s closed without a balance update", pos.segment, pos.id)
        return
    credit = pnl
    if pos.segment == "CRYPTO":
        if usdinr_rate is None:
            logger.error("CRYPTO pnl credited without a usdinr_rate conversion for position %s - balance is in raw USD, not INR", pos.id)
        else:
            credit = pnl * usdinr_rate
    account.current_balance = float(account.current_balance) + credit


def _reject(db: Session, order: ResolvedOrder, signal_id: uuid.UUID, reason: str) -> db_models.Position:
    """quantity is left unset (NULL) - a rejected order was never sized,
    it's not a real position. user_id is always None here - only the
    automated Strategy-driven flow calls this (see _reject_manual for the
    manual/SaaS counterpart)."""
    logger.info("rejecting signal %s: %s", order.signal_id, reason)
    row = db_models.Position(
        user_id=None,
        signal_id=signal_id,
        strategy_id=uuid.UUID(order.strategy_id),
        symbol=order.symbol,
        exchange=order.exchange,
        segment=order.segment,
        action=order.action,
        horizon=order.horizon,
        instrument_type=order.instrument_type,
        entry_price=order.price,
        status="REJECTED",
        rejection_reason=reason,
    )
    db.add(row)
    return row


def _reject_manual(
    db: Session,
    user_id: uuid.UUID,
    signal_id: uuid.UUID,
    symbol: str,
    exchange: str,
    segment: str,
    action: str,
    instrument_type: str,
    price: float,
    reason: str,
) -> db_models.Position:
    """Manual-tab equivalent of _reject - no strategy_id at all (None, not
    a real Strategy), since a manual order never touches signal-generation.
    quantity is left unset (NULL), same "never sized" convention."""
    logger.info("rejecting manual order %s: %s", signal_id, reason)
    row = db_models.Position(
        user_id=user_id,
        signal_id=signal_id,
        strategy_id=None,
        symbol=symbol,
        exchange=exchange,
        segment=segment,
        action=action,
        horizon="intraday",
        instrument_type=instrument_type,
        entry_price=price,
        status="REJECTED",
        rejection_reason=reason,
    )
    db.add(row)
    return row


# --- Trade discipline checklist (Manual tab only) ---------------------
#
# list_checklist_items/create_checklist_item/update_checklist_item/
# delete_checklist_item back GET/POST/PUT/DELETE /checklist-items - the
# user-editable master list of pre-trade Plan items (see infra/postgres/
# init/02-execution.sql's own comment on execution.checklist_items).
# validate_plan_checklist/find_pending_manual_review/submit_position_review
# are the two enforcement halves: the former gates a fresh manual order
# (every active item must be answered `checked=true`), the latter gates
# the NEXT one (a manual position/group that's CLOSED but not yet
# reviewed blocks every future POST /positions/manual and
# POST /option-groups/manual with a 409, until PUT .../review is
# submitted for it) - see docs/architecture.md § 'Trade discipline
# checklist'.


def _ensure_user_checklist_items(db: Session, user_id: uuid.UUID) -> None:
    """Clones the platform default template (user_id IS NULL rows) into
    this user's own editable copies, the first time they have none of
    their own yet - mirrors load_account's identical lazy-seed-on-first-
    use pattern above. A no-op once the user has ANY row of their own
    (even if they've since deleted some/all of the originally-cloned
    items) - this only ever fires once per user, not "top up to match the
    template every time"."""
    has_own = db.query(db_models.ChecklistItem).filter_by(user_id=user_id).first() is not None
    if has_own:
        return
    templates = db.query(db_models.ChecklistItem).filter_by(user_id=None).all()
    for t in templates:
        db.add(
            db_models.ChecklistItem(
                user_id=user_id, label=t.label, phase=t.phase, segments=t.segments, sort_order=t.sort_order, active=t.active
            )
        )
    db.commit()


def list_checklist_items(
    db: Session, user_id: uuid.UUID, active_only: bool = False, phase: Optional[str] = None
) -> list[db_models.ChecklistItem]:
    _ensure_user_checklist_items(db, user_id)
    q = db.query(db_models.ChecklistItem).filter_by(user_id=user_id)
    if active_only:
        q = q.filter_by(active=True)
    if phase is not None:
        q = q.filter_by(phase=phase)
    return q.order_by(db_models.ChecklistItem.sort_order, db_models.ChecklistItem.created_at).all()


def create_checklist_item(
    db: Session, user_id: uuid.UUID, label: str, phase: str, segments: list[str], sort_order: Optional[int]
) -> db_models.ChecklistItem:
    if sort_order is None:
        # Sort after every existing item IN THE SAME PHASE (active or
        # not) by default - a freshly-added item shows up at the bottom
        # of its own list, not wherever sort_order=0 happens to land it,
        # and doesn't jump ahead of/behind items in the OTHER phase's
        # unrelated ordering.
        max_order = (
            db.query(db_models.ChecklistItem.sort_order)
            .filter_by(phase=phase, user_id=user_id)
            .order_by(db_models.ChecklistItem.sort_order.desc())
            .first()
        )
        sort_order = (max_order[0] + 10) if max_order else 10
    row = db_models.ChecklistItem(user_id=user_id, label=label, phase=phase, segments=segments, sort_order=sort_order)
    db.add(row)
    db.commit()
    return row


def update_checklist_item(
    db: Session,
    user_id: uuid.UUID,
    item_id: uuid.UUID,
    label: Optional[str],
    phase: Optional[str],
    segments: Optional[list[str]],
    sort_order: Optional[int],
    active: Optional[bool],
) -> Optional[db_models.ChecklistItem]:
    row = db.query(db_models.ChecklistItem).filter_by(id=item_id, user_id=user_id).one_or_none()
    if row is None:
        return None
    if label is not None:
        row.label = label
    if phase is not None:
        row.phase = phase
    if segments is not None:
        row.segments = segments
    if sort_order is not None:
        row.sort_order = sort_order
    if active is not None:
        row.active = active
    db.commit()
    return row


def delete_checklist_item(db: Session, user_id: uuid.UUID, item_id: uuid.UUID) -> bool:
    """Hard delete - past trades keep their own {label, checked} snapshot
    regardless (Position/OptionPositionGroup.plan_checklist), so removing
    the master row here never rewrites history. Returns False if the id
    didn't exist (or belongs to another user - the route 404s either way,
    never revealing which), True on success."""
    row = db.query(db_models.ChecklistItem).filter_by(id=item_id, user_id=user_id).one_or_none()
    if row is None:
        return False
    db.delete(row)
    db.commit()
    return True


def _today_in_tz(timezone: str) -> date:
    """Server-side "today", in execution.settings.timezone - same
    reference point is_within_intraday_window's own local-time check
    already uses, NOT the browser's own local date. The 'day'-phase
    checklist's whole point is a boundary that doesn't reset just because
    someone's laptop clock/timezone differs from the account's."""
    return datetime.now(ZoneInfo(timezone)).date()


def _today_realized_pnl(db: Session, user_id: uuid.UUID, segment: str, timezone: str) -> float:
    """Sum of pnl across every CLOSED position for this user+segment that
    exited today (server-side "today", same _today_in_tz reference point
    everything else here uses) - live-broker-adapter P2's max_daily_loss
    cap (see open_manual_position's own live-gate comment). Includes
    every exit_reason (stop_loss/target/square_off/manual/counter_signal),
    not just real-broker ones - a bad paper day and a bad live day both
    count against the same cap once live trading is what's actually at
    risk that day. 0.0 (not None) if nothing closed today, so callers
    never need a None-check of their own."""
    today = _today_in_tz(timezone)
    start_of_day = datetime.combine(today, time.min, tzinfo=ZoneInfo(timezone)).astimezone(dt_timezone.utc)
    rows = (
        db.query(db_models.Position)
        .filter(db_models.Position.user_id == user_id)
        .filter(db_models.Position.segment == segment)
        .filter(db_models.Position.status == "CLOSED")
        .filter(db_models.Position.exit_time >= start_of_day)
        .all()
    )
    return sum(float(p.pnl) for p in rows if p.pnl is not None)


def _today_realized_pnl_for_strategy(db: Session, strategy_id: str, timezone: str) -> float:
    """Same as _today_realized_pnl above, but for the automated Strategy-
    driven flow's own max_daily_loss cap (execution.strategy_accounts,
    live-broker-adapter P3 item 14) - those positions always carry
    user_id=NULL (see open_position's own comment), so the cap has to be
    scoped by strategy_id instead."""
    today = _today_in_tz(timezone)
    start_of_day = datetime.combine(today, time.min, tzinfo=ZoneInfo(timezone)).astimezone(dt_timezone.utc)
    rows = (
        db.query(db_models.Position)
        .filter(db_models.Position.strategy_id == uuid.UUID(str(strategy_id)))
        .filter(db_models.Position.status == "CLOSED")
        .filter(db_models.Position.exit_time >= start_of_day)
        .all()
    )
    return sum(float(p.pnl) for p in rows if p.pnl is not None)


def get_live_trading_status(db: Session) -> dict:
    """Live-broker-adapter status-check helper (see docs/architecture.md) -
    answers "is X actually live right now, and if not, why not" for every
    account/strategy that could conceivably place a real order, without
    placing one or calling out to market-data/Dhan at all (a pure DB read,
    deliberately - this is meant to be safe to call constantly, e.g. from
    an ops dashboard or a pre-flight script, never itself a side effect).

    `effectively_live` folds in the platform kill switch too - a row can
    have live_trading_enabled=true in the DB and still be non-live right
    now because the kill switch is on; this is what actually answers "will
    the next real signal on this account/strategy place a real order",
    not just what the raw flag says. today_realized_pnl is included
    whenever a max_daily_loss cap is set, so it's visible how close to
    tripping that cap an account/strategy already is."""
    kill_switch = app_settings.live_trading_kill_switch
    exec_timezone = load_settings(db).timezone

    accounts = []
    for row in db.query(db_models.Account).all():
        live_enabled = bool(row.live_trading_enabled)
        today_pnl = _today_realized_pnl(db, row.user_id, row.segment, exec_timezone) if row.max_daily_loss is not None else None
        daily_loss_tripped = today_pnl is not None and today_pnl <= -float(row.max_daily_loss)
        accounts.append(
            {
                "user_id": str(row.user_id) if row.user_id is not None else None,
                "segment": row.segment,
                "live_trading_enabled": live_enabled,
                "max_order_value": float(row.max_order_value) if row.max_order_value is not None else None,
                "max_daily_loss": float(row.max_daily_loss) if row.max_daily_loss is not None else None,
                "today_realized_pnl": today_pnl,
                "effectively_live": live_enabled and not kill_switch and not daily_loss_tripped,
                "reason": _live_status_reason(live_enabled, kill_switch, daily_loss_tripped, has_user=True),
            }
        )

    strategy_accounts = []
    for row in db.query(db_models.StrategyAccount).all():
        live_enabled = bool(row.live_trading_enabled)
        has_user = row.live_trading_user_id is not None
        today_pnl = (
            _today_realized_pnl_for_strategy(db, str(row.strategy_id), exec_timezone) if row.max_daily_loss is not None else None
        )
        daily_loss_tripped = today_pnl is not None and today_pnl <= -float(row.max_daily_loss)
        strategy_accounts.append(
            {
                "strategy_id": str(row.strategy_id),
                "segment": row.segment,
                "live_trading_user_id": str(row.live_trading_user_id) if has_user else None,
                "live_trading_enabled": live_enabled,
                "max_order_value": float(row.max_order_value) if row.max_order_value is not None else None,
                "max_daily_loss": float(row.max_daily_loss) if row.max_daily_loss is not None else None,
                "today_realized_pnl": today_pnl,
                "effectively_live": live_enabled and has_user and not kill_switch and not daily_loss_tripped,
                "reason": _live_status_reason(live_enabled, kill_switch, daily_loss_tripped, has_user),
            }
        )

    return {"kill_switch": kill_switch, "accounts": accounts, "strategy_accounts": strategy_accounts}


def _live_status_reason(live_enabled: bool, kill_switch: bool, daily_loss_tripped: bool, has_user: bool) -> Optional[str]:
    if not live_enabled:
        return "live_trading_enabled is false - paper only"
    if not has_user:
        return "live_trading_enabled but no live_trading_user_id set - can never go live"
    if kill_switch:
        return "would be live, but the platform-wide LIVE_TRADING_KILL_SWITCH is on"
    if daily_loss_tripped:
        return "would be live, but today's realized loss has reached its max_daily_loss cap"
    return None


def get_daily_checklist(
    db: Session, user_id: uuid.UUID, settings: ExecutionSettings, segment: str
) -> Optional[db_models.DailyChecklistLog]:
    """None if nothing has been submitted yet today for `segment` - the
    gate is still active in that case (see find_missing_daily_checklist)."""
    return db.get(db_models.DailyChecklistLog, (user_id, _today_in_tz(settings.timezone), segment))


def submit_daily_checklist(
    db: Session, user_id: uuid.UUID, settings: ExecutionSettings, segment: str, answers: list[dict], notes: Optional[str]
) -> db_models.DailyChecklistLog:
    """PUT /daily-checklist - upserts today's (server-computed date,
    segment) row; answered once, editable the rest of that same day (not
    an immutable journal entry) - see execution.daily_checklist_log's own
    comment. `notes` is ONE observation for the whole submission, not
    per item."""
    today = _today_in_tz(settings.timezone)
    row = db.get(db_models.DailyChecklistLog, (user_id, today, segment))
    if row is None:
        row = db_models.DailyChecklistLog(user_id=user_id, log_date=today, segment=segment, answers=answers, notes=notes)
        db.add(row)
    else:
        row.answers = answers
        row.notes = notes
        row.submitted_at = datetime.now(dt_timezone.utc)
    db.commit()
    return row


def _open_trading_session(db: Session, user_id: uuid.UUID, today, segment: str) -> Optional[db_models.TradingSession]:
    """The currently-open (checked_out_at IS NULL) session row for this
    user's today's (log_date, segment), if any - there can be at most
    one, since check_in_trading_session refuses to start a second one
    while this exists."""
    return (
        db.query(db_models.TradingSession)
        .filter_by(user_id=user_id, log_date=today, segment=segment, checked_out_at=None)
        .one_or_none()
    )


def check_in_trading_session(db: Session, user_id: uuid.UUID, settings: ExecutionSettings, segment: str) -> db_models.TradingSession:
    """POST /trading-sessions/check-in - starts a NEW session row for
    today (server-computed date), unless one's already open for this
    user's (log_date, segment), in which case that same open row is
    returned unchanged - a real trading day can have several sessions
    (checked in, broke for lunch, checked in again), but never two open
    at once. The route layer disables the Check In button while one's
    open, this is just the server-side mirror of that same gate."""
    today = _today_in_tz(settings.timezone)
    open_row = _open_trading_session(db, user_id, today, segment)
    if open_row is not None:
        return open_row
    row = db_models.TradingSession(user_id=user_id, log_date=today, segment=segment, checked_in_at=datetime.now(dt_timezone.utc))
    db.add(row)
    db.commit()
    return row


def check_out_trading_session(
    db: Session, user_id: uuid.UUID, settings: ExecutionSettings, segment: str
) -> Optional[db_models.TradingSession]:
    """POST /trading-sessions/check-out - closes today's currently-open
    session (sets its checked_out_at to now), or None if none is open
    (nothing to close - the route layer disables the Check Out button in
    that state, this mirrors it server-side rather than silently
    fabricating a row)."""
    today = _today_in_tz(settings.timezone)
    row = _open_trading_session(db, user_id, today, segment)
    if row is None:
        return None
    row.checked_out_at = datetime.now(dt_timezone.utc)
    db.commit()
    return row


def list_trading_sessions(db: Session, user_id: uuid.UUID, segment: Optional[str] = None) -> list[db_models.TradingSession]:
    """GET /trading-sessions - the whole table (for this user) is small
    (every check-in/check-out instance they've ever recorded), so this
    returns everything rather than needing a date-range param -
    ManualTab.tsx filters to today client-side for its own session bar,
    ManualStatsPage.tsx keys the rest by day for its own by-day/
    per-trade-day display."""
    q = db.query(db_models.TradingSession).filter_by(user_id=user_id)
    if segment:
        q = q.filter_by(segment=segment)
    return q.order_by(db_models.TradingSession.checked_in_at.desc()).all()


def find_missing_daily_checklist(db: Session, user_id: uuid.UUID, settings: ExecutionSettings, segment: str) -> Optional[str]:
    """None if `segment` has no active 'day'-phase items scoped to it (or
    'unscoped', i.e. every-segment) at all, or today's checklist has
    already been submitted for it; otherwise a reject reason (route layer
    turns it into a 409) - checked BEFORE validate_plan_checklist in
    open_manual/open_manual_option, same "not a trade attempt, no row
    persisted" reasoning as find_pending_manual_review."""
    active_day_items = [
        i for i in list_checklist_items(db, user_id, active_only=True, phase="day") if not i.segments or segment in i.segments
    ]
    if not active_day_items:
        return None
    if get_daily_checklist(db, user_id, settings, segment) is None:
        return f"complete today's day checklist for {segment} first"
    return None


def validate_plan_checklist(db: Session, user_id: uuid.UUID, answers: list[ChecklistAnswer], segment: str) -> Optional[str]:
    """None if `answers` is a valid, fully-checked submission against the
    CURRENTLY active 'plan'-phase checklist items SCOPED TO `segment`
    (empty `segments` on an item means every segment - e.g. OI change is
    NSE-only, so a CRYPTO/MCX order isn't required to answer it);
    otherwise a reject reason (route layer turns it into a 422). Matched
    by count, not by label text - the frontend always renders from a
    fresh GET /checklist-items immediately before showing the form (and
    applies the identical segment filter client-side), so a mismatch here
    means the list or `segment` changed since it was fetched, not a
    malicious/malformed request. 'review'/'day'-phase items are irrelevant
    here entirely - see ReviewSubmit.checklist/DailyChecklistSubmit's own
    comments for why those aren't validated the same way."""
    active_items = [
        i for i in list_checklist_items(db, user_id, active_only=True, phase="plan") if not i.segments or segment in i.segments
    ]
    if len(answers) != len(active_items):
        return "trade plan checklist is out of date - refresh and try again"
    if not all(a.checked for a in answers):
        return "complete every item in the trade plan checklist before placing this order"
    return None


def find_pending_manual_review(db: Session, user_id: uuid.UUID) -> Optional[dict]:
    """The earliest-closed manual (strategy_id IS NULL) position OR option
    group belonging to THIS user that's CLOSED but still has reviewed_at
    IS NULL, across BOTH tables - or None if there's nothing pending.
    `pending_count` is the TOTAL across both tables, not just this one -
    the frontend's own reminder banner shows only that count now (not
    this trade's own symbol/action/pnl - see ManualTab.tsx, changed
    2026-08-26 at the user's explicit request), this function still needs
    to identify the earliest one for its review icon to point at once a
    card is opened. This gate no longer blocks POST /positions/manual or
    POST /option-groups/manual at all (see those routes' own docstrings
    for why - removed the same day) - it's purely a reminder now."""
    pending: list[dict] = []
    pos = (
        db.query(db_models.Position)
        .filter_by(user_id=user_id, strategy_id=None, status="CLOSED", reviewed_at=None, option_group_id=None)
        .order_by(db_models.Position.exit_time)
        .first()
    )
    if pos is not None:
        pending.append(
            {
                "kind": "position",
                "id": str(pos.id),
                "symbol": pos.symbol,
                "segment": pos.segment,
                "action": pos.action,
                "pnl": float(pos.pnl) if pos.pnl is not None else None,
                "exit_time": pos.exit_time,
            }
        )
    group = (
        db.query(db_models.OptionPositionGroup)
        .filter_by(user_id=user_id, strategy_id=None, status="CLOSED", reviewed_at=None)
        .order_by(db_models.OptionPositionGroup.exit_time)
        .first()
    )
    if group is not None:
        pending.append(
            {
                "kind": "option_group",
                "id": str(group.id),
                "symbol": group.underlying_symbol,
                "segment": group.segment,
                "action": group.action,
                "pnl": float(group.pnl) if group.pnl is not None else None,
                "exit_time": group.exit_time,
            }
        )
    if not pending:
        return None
    pending.sort(key=lambda p: p["exit_time"] or datetime.min.replace(tzinfo=dt_timezone.utc))
    earliest = pending[0]
    earliest["exit_time"] = earliest["exit_time"].isoformat() if earliest["exit_time"] else None
    earliest["pending_count"] = (
        db.query(db_models.Position).filter_by(user_id=user_id, strategy_id=None, status="CLOSED", reviewed_at=None, option_group_id=None).count()
        + db.query(db_models.OptionPositionGroup).filter_by(user_id=user_id, strategy_id=None, status="CLOSED", reviewed_at=None).count()
    )
    return earliest


def submit_position_review(
    db: Session,
    user_id: uuid.UUID,
    position_id: uuid.UUID,
    violation: bool,
    notes: Optional[str],
    accepted_loss: bool,
    review_checklist: Optional[list[dict]] = None,
) -> tuple[Optional[db_models.Position], Optional[str]]:
    """PUT /positions/{id}/review - the Complete step. Returns (row, reject_
    reason); reject_reason is set (row left untouched) if the position
    isn't a CLOSED manual one OWNED BY user_id, is already reviewed, or is
    a loss that hasn't been accepted yet. `review_checklist` is the
    'review'-phase {label, checked} snapshot (see ReviewSubmit.checklist's
    own comment) - stored as-is, never validated for completeness."""
    row = db.get(db_models.Position, position_id)
    if row is None or row.user_id != user_id:
        return None, "position not found"
    if row.strategy_id is not None:
        return None, "only manually-opened positions have a discipline review"
    if row.option_group_id is not None:
        return None, "this is an option leg - review the option group instead (PUT /option-groups/{id}/review)"
    if row.status != "CLOSED":
        return None, f"position is {row.status}, not CLOSED"
    if row.reviewed_at is not None:
        return None, "position already reviewed"
    if row.pnl is not None and float(row.pnl) < 0 and not accepted_loss:
        return None, "must accept the loss before submitting this review"
    row.reviewed_at = datetime.now(dt_timezone.utc)
    row.review_violation = violation
    row.review_notes = notes
    row.review_checklist = review_checklist
    db.commit()
    return row, None


def _resolve_stop_loss(
    method: Optional[str],
    action: str,
    price: float,
    interval: Optional[str],
    percent: Optional[float],
    indicator_type: Optional[str],
    indicator_params: Optional[dict],
    exchange: str,
    symbol: str,
    get_previous_candle: GetPreviousCandle,
    get_candle_history: GetCandleHistory,
) -> tuple[Optional[float], Optional[str]]:
    """Computes a stop-loss price for `method` ('percent'/'previous_candle'/
    'indicator'/'breakeven') at open time - returns (price, None) on success
    or (None, reason) on failure (no completed candle yet, not enough
    indicator history yet, unrecognized indicator_type, or an indicator
    value that lands on the wrong side of entry). method=None returns
    (None, None) - no stop-loss requested at all.

    'breakeven' gets an identical initial stop to 'percent' (entry +/-
    percent%) - the only difference is what _evaluate_exits does with it
    afterward (snap-to-entry-then-freeze on the first favorable percent%
    move, instead of continuously re-trailing every tick).

    Shared by open_position (Strategy-driven, every field sourced from a
    ResolvedOrder already validated upstream in signal-generation) and
    open_manual_position (Manual tab, validated by ManualPositionCreate's
    own model_validator instead) so both compute a stop-loss identically -
    previously only open_position had this dispatch; open_manual_position
    took nothing but a raw caller-supplied price."""
    if method is None:
        return None, None

    if method in ("percent", "breakeven"):
        return compute_stop_loss_percent_price(action, price, percent), None

    if method == "previous_candle":
        candle = get_previous_candle(exchange, symbol, interval)
        if candle is None:
            return None, (
                f"stop_loss_method='previous_candle' but no completed {interval} candle available for {symbol} yet"
            )
        return (candle["low"] if action == "BUY" else candle["high"]), None

    # method == "indicator"
    compute = _STOP_LOSS_COMPUTE_FUNCS.get(indicator_type)
    if compute is None:
        return None, f"unrecognized stop_loss_indicator_type '{indicator_type}'"
    warmup_from, warmup_to = _indicator_history_window((indicator_params or {}).get("period", 20), interval)
    history = get_candle_history(exchange, symbol, interval, warmup_from, warmup_to)
    candidate = compute(history, indicator_params or {})
    if candidate is None:
        return None, (
            f"stop_loss_method='indicator' ({indicator_type}) but not enough {interval} history available "
            f"for {symbol} yet"
        )
    # A raw indicator value has no direction concept at all (unlike
    # previous_candle's own low/high split, which is directionally safe by
    # construction) - a value on the WRONG side of entry (e.g. a slow EMA
    # still above entry for a fresh BUY after a downtrend) isn't a
    # protective stop, it's a near-certain instant "stop-out" at a phantom
    # price the market may never trade at. Reject cleanly rather than open
    # an unprotected/nonsensical position - reproduced live via backtest
    # (EMA(400) ~415 points above a bullish entry).
    if (action == "BUY" and candidate >= price) or (action == "SELL" and candidate <= price):
        return None, (
            f"stop_loss_method='indicator' ({indicator_type}) computed {candidate} - not on the protective side "
            f"of entry ({price}) for a {action}, not usable as a stop-loss"
        )
    return candidate, None


def _open_delta_fee_fields(
    segment: str,
    instrument_type: str,
    horizon: str,
    action: str,
    price: float,
    quantity: float,
    account: db_models.Account,
    capital_account,
    usdinr_rate: Optional[float] = None,
    use_margin: bool = False,
) -> tuple[Optional[float], Optional[float], Optional[float], Optional[float]]:
    """Delta Exchange fee/liquidation simulation (app/domain/delta_fees.py) -
    CRYPTO + instrument_type='future' only, (None, None, None, None) for
    every other position (unaffected by this feature entirely). Debits the
    computed open_fee from capital_account.current_balance immediately - a
    real cash outflow, independent of realized P&L, the first time this
    codebase ever touches balance at OPEN time. account.leverage (used for
    margin_posted/liquidation_price) is always the SEGMENT account's own
    value even when capital_account is a strategy's own dedicated one -
    leverage stays segment-only, same as square_off_time (see
    load_capital_account's own docstring). Shared by open_position and
    open_manual_position so both compute this identically - the manual
    path always passes horizon='intraday' (Manual tab positions are always
    intraday), so it can never hit the NSE MTF branch below.

    open_fee/margin_posted/liquidation_price are all returned/stored in
    raw USD (matching entry_price, which never gets converted - see
    docs/architecture.md's USDINR section) - only the actual balance DEBIT
    below is converted through usdinr_rate first, since current_balance is
    always INR-denominated. Every caller already guarantees usdinr_rate is
    set before reaching here (CRYPTO sizing above this call already
    rejects the whole order if it's None) - None is only a defensive
    fallback (debits the raw USD figure unconverted, logged) that should
    never actually trigger.

    Also computes NSE MTF's margin_posted (reused, not a new column - same
    meaning either way: the trader's own capital actually posted,
    notional/leverage) + mtf_interest_rate_pct for a horizon='positional'
    NSE spot position opened with leverage > 1 - the caller (open_position)
    already rejected the order before reaching here if no rate was
    configured, so account.mtf_annual_interest_rate_pct is guaranteed
    non-None in that branch. No open_fee/liquidation_price for this case -
    MTF is a cash borrowing cost against a bought asset, not a leveraged
    derivative with liquidation risk, and its cost (interest) only becomes
    known at close (see _net_pnl_with_costs), unlike CRYPTO's point-in-time
    open_fee."""
    if segment == "CRYPTO" and instrument_type == "future":
        notional = price * quantity
        open_fee = compute_futures_trading_fee(notional)
        margin_posted = compute_margin_posted(notional, float(account.leverage))
        liquidation_price = compute_liquidation_price(action, price, float(account.leverage))
        if usdinr_rate is None:
            logger.error("CRYPTO open_fee debited without a usdinr_rate conversion - balance is in raw USD, not INR")
            debit = open_fee
        else:
            debit = open_fee * usdinr_rate
        capital_account.current_balance = float(capital_account.current_balance) - debit
        return open_fee, margin_posted, liquidation_price, None

    if segment == "NSE" and horizon == "positional" and instrument_type == "spot" and use_margin and float(account.leverage) > 1:
        notional = price * quantity
        margin_posted = notional / float(account.leverage)
        return None, margin_posted, None, float(account.mtf_annual_interest_rate_pct)

    return None, None, None, None


def open_position(
    order: ResolvedOrder,
    settings: ExecutionSettings,
    db: Session,
    get_previous_candle: GetPreviousCandle,
    get_lot_size: GetLotSize,
    get_candle_history: GetCandleHistory,
) -> db_models.Position:
    """Idempotent: a signal_id already processed (e.g. Redis redelivered
    the message after a crash) returns the existing row rather than
    double-opening a position."""
    signal_id = uuid.UUID(order.signal_id)

    existing = db.query(db_models.Position).filter_by(signal_id=signal_id).one_or_none()
    if existing is not None:
        logger.info("signal %s already processed (status=%s), skipping", order.signal_id, existing.status)
        return existing

    if not is_supported(order.horizon, order.instrument_type):
        row = _reject(
            db,
            order,
            signal_id,
            f"unsupported horizon/instrument_type ({order.horizon}/{order.instrument_type}) - "
            "only intraday spot/future, or positional spot, is handled in this phase",
        )
        db.commit()
        return row

    # user_id=None throughout this function - the automated Strategy-
    # driven flow has no per-user concept at all (signal-generation isn't
    # part of the manual-trading SaaS), so it always reads/writes the
    # legacy platform-wide account/settings rows. See load_account's own
    # comment and docs/architecture.md's "Manual Trading SaaS" section.
    account = load_account(db, None, order.segment)
    if account is None:
        row = _reject(db, order, signal_id, f"no paper-trading account configured for segment {order.segment}")
        db.commit()
        return row

    # Sizing/balance uses the strategy's OWN dedicated account if it has
    # one (execution.strategy_accounts), else the same shared segment
    # `account` above - leverage/square_off_time always stay segment-only
    # regardless (see load_capital_account's own docstring).
    capital_account = load_capital_account(db, None, order.segment, order.strategy_id)

    # square_off_time is the SEGMENT's own configured cutoff now
    # (execution.accounts.square_off_time), not a per-Strategy value -
    # None (e.g. CRYPTO) means this segment never force-closes, so a
    # signal is always within window regardless of time of day.
    now = datetime.now(dt_timezone.utc)
    if not is_within_intraday_window(now, account.square_off_time, settings.timezone):
        row = _reject(
            db, order, signal_id, f"received outside intraday window (square-off is {account.square_off_time})"
        )
        db.commit()
        return row

    open_positions = db.query(db_models.Position).filter_by(user_id=None, symbol=order.symbol, status="OPEN").all()
    positions_to_close, reject_reason = _resolve_signal_conflicts(open_positions, order)
    if reject_reason is not None:
        row = _reject(db, order, signal_id, reject_reason)
        db.commit()
        return row

    for pos in positions_to_close:
        pos.exit_price = order.price
        pos.exit_time = datetime.now(dt_timezone.utc)
        raw_pnl = compute_pnl(pos.action, float(pos.entry_price), order.price, float(pos.quantity))
        _apply_realized_pnl(pos, capital_account, _net_pnl_with_costs(pos, order.price, raw_pnl), settings.usdinr_rate)
        pos.status = "CLOSED"
        pos.exit_reason = "counter_signal"

    # Sizing is capped by whatever's actually left in the account, not
    # just the account's configured capital_per_trade - a depleted
    # account sizes smaller (or rejects outright below) rather than
    # opening a position it can't afford. See docs/architecture.md
    # § 'Why paper-trading accounts are per-segment, not per-strategy'.
    effective_capital = min(float(capital_account.capital_per_trade), float(capital_account.current_balance))
    if order.segment == "CRYPTO":
        # capital_per_trade/current_balance are INR-denominated like every
        # other segment, but order.price (from Delta Exchange India) is
        # raw USD - convert the capital figure into USD-equivalent before
        # comparing/sizing against it, rather than the price into INR, so
        # entry_price/stop_loss_price/target_price stored below stay in
        # native USD (still correctly comparable against future raw-USD
        # LTP fetches for exit-monitoring). settings.usdinr_rate is a
        # manually configured rate (GET/PUT /settings) rather than a live
        # feed - NSE's own currency-futures segment (which this would
        # otherwise source from) had no unexpired contract to quote as of
        # when this was built. See docs/architecture.md.
        if settings.usdinr_rate is None:
            row = _reject(db, order, signal_id, "no USDINR rate configured - set one in Settings to size a CRYPTO position")
            db.commit()
            return row
        effective_capital = effective_capital / settings.usdinr_rate
        # Delta Exchange India trades perpetual futures on margin -
        # account.leverage (default 1, GET/PUT /accounts/CRYPTO) scales the
        # USD-equivalent margin into buying power, so the same capital
        # affords proportionally more quantity. entry_price/stop_loss_price/
        # target_price are unaffected (PnL is still (exit-entry)*quantity
        # regardless of how much margin backed that quantity).
        effective_capital = effective_capital * float(account.leverage)
    elif order.segment == "NSE" and order.horizon == "positional" and order.use_margin and float(account.leverage) > 1:
        # Dhan MTF (margin trading facility) - borrows cash against NSE
        # spot equity, unlike CRYPTO's derivative-margin leverage above,
        # but the sizing math is the same shape: leverage scales
        # effective_capital directly (no USDINR step needed - NSE is
        # already INR-native). Requires an interest rate to be configured
        # first - see _net_pnl_with_costs for where that rate gets charged
        # back at close. account.mtf_annual_interest_rate_pct is a
        # manually configured rate (GET/PUT /accounts/NSE), not a live
        # feed - same "operator enters it" convention as
        # settings.usdinr_rate. Only ever applies to a positional order
        # with use_margin=True (Strategy-level opt-in) - an intraday NSE
        # order (Strategy-driven or Manual tab) never reads leverage at
        # all, and a positional order with use_margin=False always sizes
        # on cash regardless of how leverage/the rate are configured, so
        # this can't change behavior for either of those cases.
        if account.mtf_annual_interest_rate_pct is None:
            row = _reject(
                db,
                order,
                signal_id,
                "no MTF interest rate configured for NSE - set one in Accounts to use leverage > 1 on a positional order",
            )
            db.commit()
            return row
        effective_capital = effective_capital * float(account.leverage)

    # Only futures carry a lot concept - spot (NSE cash equity) keeps
    # lot_size=1 with no extra network call, so that path's latency is
    # unchanged from before this lookup existed. Resolved BEFORE the
    # balance check below so that check compares against the cost of the
    # smallest tradeable unit (1 lot), not 1 full underlying unit - for
    # CRYPTO futures lot_size is a real fraction (e.g. BTCUSD=0.001), so
    # checking against the unadjusted order.price would reject capital
    # that can actually afford dozens of real lots (reproduced live:
    # $555 available was rejected as insufficient for "1 share" at
    # order.price=$63,890, when 1 real BTCUSD lot only costs ~$63.89).
    lot_size = 1
    if order.instrument_type == "future":
        resolved_lot_size = get_lot_size(order.exchange, order.symbol)
        if resolved_lot_size is None:
            row = _reject(db, order, signal_id, f"could not determine lot size for {order.symbol} on {order.exchange}")
            db.commit()
            return row
        lot_size = resolved_lot_size

    # order.fixed_lots (Strategy-level, every instrument_type) overrides
    # auto-sizing below entirely, but the balance check still runs against
    # its real cost, not a 1-lot minimum - a fixed count that's genuinely
    # unaffordable against current_balance still rejects cleanly, same
    # "paper trading still respects the simulated balance" reasoning every
    # other rejection case here already has. Mirrors
    # option_position_manager.open_option_group's own identical handling.
    required_lots = order.fixed_lots if order.fixed_lots is not None else 1
    if effective_capital < order.price * lot_size * required_lots:
        capital_unit = "USD" if order.segment == "CRYPTO" else "INR"
        row = _reject(
            db,
            order,
            signal_id,
            f"insufficient account balance ({effective_capital} {capital_unit} available for {order.segment}, "
            f"need at least {order.price * lot_size * required_lots} for {required_lots} lot(s))",
        )
        db.commit()
        return row

    stop_loss_price, sl_reject_reason = _resolve_stop_loss(
        order.stop_loss_method,
        order.action,
        order.price,
        order.stop_loss_interval,
        order.stop_loss_percent,
        order.stop_loss_indicator_type,
        order.stop_loss_indicator_params,
        order.exchange,
        order.symbol,
        get_previous_candle,
        get_candle_history,
    )
    if sl_reject_reason is not None:
        row = _reject(db, order, signal_id, sl_reject_reason)
        db.commit()
        return row

    target_price: Optional[float] = None
    if order.target_percent is not None:
        target_price = compute_target_percent_price(order.action, order.price, order.target_percent)

    if order.fixed_lots is not None:
        # Strategy-level override (every instrument_type) - trades exactly
        # this many lots instead of auto-sizing off capital/risk% - takes
        # precedence over stop-loss-based sizing entirely, even when a
        # stop-loss is also configured. stop_loss_price above is still
        # computed and stored as normal; only its role in SIZING (including
        # the "stop equals entry, can't size by risk" rejection just below,
        # which only makes sense when actually sizing BY risk) is bypassed
        # here. Mirrors option_position_manager.open_option_group's own
        # identical handling.
        quantity = order.fixed_lots * lot_size
    elif stop_loss_price is not None:
        stop_distance = abs(order.price - stop_loss_price)
        if stop_distance <= 0:
            row = _reject(
                db,
                order,
                signal_id,
                f"stop-loss price ({stop_loss_price}) equals entry price ({order.price}) - can't size by risk",
            )
            db.commit()
            return row

        quantity = compute_risk_based_quantity(
            effective_capital, float(capital_account.risk_per_trade_pct), order.price, stop_loss_price, lot_size
        )
    else:
        quantity = compute_quantity(effective_capital, order.price, lot_size)

    # Live-broker-adapter P3 item 14 (see docs/architecture.md) - the ONLY
    # way an automated signal ever places a real order: capital_account
    # must be a dedicated execution.strategy_accounts row (the shared
    # platform account has no live_trading_user_id field at all, so
    # getattr always returns None for it) with live_trading_enabled AND a
    # live_trading_user_id explicitly set. entry_price/final_quantity are
    # local overridable copies of order.price/quantity, same pattern
    # open_manual_position's own live path uses - order itself is the
    # signal contract and is never mutated.
    entry_price = order.price
    final_quantity = quantity
    live_user_id = getattr(capital_account, "live_trading_user_id", None)
    broker_order = None
    if (
        live_user_id is not None
        and is_live_enabled(capital_account)
        and order.segment in ("NSE", "MCX")
        and order.instrument_type in ("spot", "future")
    ):
        order_value = entry_price * final_quantity
        if capital_account.max_order_value is not None and order_value > float(capital_account.max_order_value):
            row = _reject(
                db, order, signal_id,
                f"order value ({order_value}) exceeds this strategy's max_order_value cap ({capital_account.max_order_value})",
            )
            db.commit()
            return row
        if capital_account.max_daily_loss is not None:
            realized_today = _today_realized_pnl_for_strategy(db, order.strategy_id, settings.timezone)
            if realized_today <= -float(capital_account.max_daily_loss):
                row = _reject(
                    db, order, signal_id,
                    f"daily loss cap reached for this strategy ({realized_today:.2f} realized today, cap is "
                    f"{capital_account.max_daily_loss}) - live trading is paused for the rest of today",
                )
                db.commit()
                return row

        broker_order, live_error = submit_entry_order_scheduled(
            db, live_user_id, order.segment, order.symbol, order.action, final_quantity,
        )
        if live_error is not None:
            row = _reject(db, order, signal_id, live_error)
            db.commit()
            return row
        if broker_order.average_fill_price is not None:
            entry_price = float(broker_order.average_fill_price)
        if broker_order.filled_quantity:
            final_quantity = broker_order.filled_quantity

    open_fee, margin_posted, liquidation_price, mtf_interest_rate_pct = _open_delta_fee_fields(
        order.segment,
        order.instrument_type,
        order.horizon,
        order.action,
        entry_price,
        final_quantity,
        account,
        capital_account,
        settings.usdinr_rate,
        use_margin=order.use_margin,
    )

    row = db_models.Position(
        user_id=None,
        signal_id=signal_id,
        strategy_id=uuid.UUID(order.strategy_id),
        symbol=order.symbol,
        exchange=order.exchange,
        segment=order.segment,
        action=order.action,
        horizon=order.horizon,
        instrument_type=order.instrument_type,
        quantity=final_quantity,
        entry_price=entry_price,
        status="OPEN",
        is_live_broker_order=broker_order is not None,
        live_trading_user_id=live_user_id if broker_order is not None else None,
        stop_loss_price=stop_loss_price,
        initial_stop_loss_price=stop_loss_price,
        target_price=target_price,
        trailing_stop_enabled=order.trailing_stop_enabled,
        stop_loss_method=order.stop_loss_method,
        stop_loss_interval=order.stop_loss_interval,
        stop_loss_percent=order.stop_loss_percent,
        stop_loss_indicator_type=order.stop_loss_indicator_type,
        stop_loss_indicator_params=order.stop_loss_indicator_params,
        # NULL for a positional position - never force-closed by the
        # square-off scheduler (same "NULL means never force-closed"
        # convention CRYPTO's own square_off_time=None already relies on),
        # since it's meant to be held across multiple sessions rather than
        # closed same-day. Only intraday positions inherit the segment's
        # real cutoff.
        square_off_time=account.square_off_time if order.horizon == "intraday" else None,
        open_fee=open_fee,
        margin_posted=margin_posted,
        liquidation_price=liquidation_price,
        mtf_interest_rate_pct=mtf_interest_rate_pct,
    )
    db.add(row)
    db.commit()
    if broker_order is not None:
        broker_order.position_id = row.id
        db.commit()
        # Live-broker-adapter P3 item 14 - same best-effort resting
        # protection open_manual_position's own live path places; a
        # failure here just falls back to the in-app CMP monitor, see
        # submit_resting_stop_loss_scheduled's own docstring.
        if stop_loss_price is not None:
            closing_action = "SELL" if order.action == "BUY" else "BUY"
            _sl_order, sl_error = submit_resting_stop_loss_scheduled(
                db, live_user_id, row.id, order.segment, order.symbol, closing_action, final_quantity, stop_loss_price,
            )
            if sl_error is not None:
                logger.warning(
                    "resting stop-loss order failed for live automated position %s: %s - falling back to in-app monitoring only",
                    row.id, sl_error,
                )
    return row


def open_manual_position(
    user_id: uuid.UUID,
    segment: str,
    symbol: str,
    action: str,
    instrument_type: str,
    price: float,
    quantity: Optional[float],
    stop_loss_price: Optional[float],
    settings: ExecutionSettings,
    db: Session,
    resolve_underlying: ResolveUnderlying,
    get_previous_candle: Optional[GetPreviousCandle] = None,
    get_candle_history: Optional[GetCandleHistory] = None,
    stop_loss_method: Optional[str] = None,
    stop_loss_interval: Optional[str] = None,
    stop_loss_percent: Optional[float] = None,
    stop_loss_indicator_type: Optional[str] = None,
    stop_loss_indicator_params: Optional[dict] = None,
    trailing_stop_enabled: bool = False,
    plan_checklist: Optional[list[dict]] = None,
    order_type: Optional[str] = None,
    square_off_time: Optional[time] = None,
    token: Optional[str] = None,
) -> db_models.Position:
    """Manual tab (spot/future only - option orders go through the sibling
    open_manual_option_group in option_position_manager.py instead, which
    resolves its own legs directly rather than sharing this function's
    sizing/gates). Deliberately NOT a ResolvedOrder - that type
    represents the signal-processing contract, and a manual order never
    touches it. Mirrors open_position's gates/sizing exactly (read that
    function alongside this one); `quantity`, if given, bypasses
    auto-sizing entirely - same precedence pattern already used for
    Strategy.fixed_lots in open_position/open_option_group. square_off_time
    defaults to the segment's own account row (same as open_position) but,
    unlike open_position, can be overridden per-call - the Manual tab's own
    order form, not a Strategy - to close THIS position ahead of the
    segment's usual cutoff without changing the segment default itself.

    Stop-loss: the caller passes EITHER a raw `stop_loss_price` (fixed at
    entry, `stop_loss_method` left None - the original manual-tab
    behavior) OR `stop_loss_method` + its own sibling fields, computed via
    the same `_resolve_stop_loss` dispatch open_position uses (percent/
    previous_candle/indicator) - ManualPositionCreate's own model_validator
    is what actually enforces these are mutually exclusive and that a
    method's required siblings are present; this function trusts that's
    already been checked. `get_previous_candle`/`get_candle_history`
    default to None since most callers (a fixed stop_loss_price, or none
    at all) never need them - only stop_loss_method='previous_candle'/
    'indicator' do, and ManualPositionCreate can't set either of those
    without the interval/percent/indicator fields the validator requires,
    so a caller that reaches this branch without supplying them is a
    caller bug, not a runtime possibility from the real route.
    `trailing_stop_enabled` is stored as-is and picked up by the SAME
    exit-monitor trailing logic (_evaluate_exits) Strategy-driven
    positions already use - no separate mechanism needed, since that
    function has never cared whether strategy_id is set.

    `symbol` for instrument_type='future' is whatever the caller typed
    (e.g. "BANKNIFTY", the bare underlying) - it is NOT yet the actual
    tradeable contract. The signal-driven path (open_position) never has
    this problem because signal-processing already resolved the contract
    (resolved.trade_symbol) before publishing to orders.resolved; a manual
    order bypasses that pipeline entirely, so this function must do the
    same resolution itself, via resolve_underlying below, before EITHER
    sizing or persisting. Reproduced live 2026-08-14: a manual BANKNIFTY
    future order persisted symbol="BANKNIFTY" (not the real Aug-2026
    contract) and lot_size=1 (not the real ~30-35 futures multiplier) -
    "BANKNIFTY" bare IS a real, resolvable Dhan symbol (the index SPOT,
    lot_size=1 by definition), so the old get_lot_size(segment, symbol)
    call silently succeeded against the WRONG instrument instead of
    failing loudly.

    `order_type` ('market'/'limit'/None) is stored as-is on the resulting
    row for future performance review - it's purely a label the caller
    (ManualTab.tsx) already resolved before calling this function; `price`
    above is the same real number either way (a fresh live LTP for
    'market', the caller-typed trigger for 'limit').

    `token` (live-broker-adapter P1, see docs/architecture.md) - the
    caller's own bearer token, forwarded so market-data can resolve THIS
    user's own BYO Dhan credentials for a real order. Only used when the
    account has live_trading_enabled AND the platform-wide kill switch
    allows it AND segment is NSE/MCX (see app/domain/live_broker.py) -
    every other call behaves exactly as before this parameter existed. A
    live order is placed as a real MARKET/INTRADAY Dhan order and this
    function waits for its postback to confirm TRADED before creating any
    Position row at all - see submit_live_order's own docstring."""
    signal_id = uuid.uuid4()

    if not is_supported("intraday", instrument_type):
        row = _reject_manual(
            db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price,
            f"unsupported instrument_type ({instrument_type}) - only spot/future is handled here",
        )
        db.commit()
        return row

    lot_size = 1
    if instrument_type == "future":
        resolved = resolve_underlying(segment, symbol)
        if resolved is None:
            row = _reject_manual(
                db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price,
                f"could not resolve underlying '{symbol}' on {segment} for futures",
            )
            db.commit()
            return row
        # Everything below (conflict detection, sizing, persistence) uses
        # the REAL contract symbol from here on - not the bare underlying
        # the caller typed.
        symbol = resolved["trade_symbol"]
        lot_size = resolved["lot_size"]

    if stop_loss_method is not None:
        stop_loss_price, sl_reject_reason = _resolve_stop_loss(
            stop_loss_method,
            action,
            price,
            stop_loss_interval,
            stop_loss_percent,
            stop_loss_indicator_type,
            stop_loss_indicator_params,
            segment,
            symbol,
            get_previous_candle,
            get_candle_history,
        )
        if sl_reject_reason is not None:
            row = _reject_manual(db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price, sl_reject_reason)
            db.commit()
            return row

    account = load_account(db, user_id, segment)
    if account is None:
        row = _reject_manual(
            db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price,
            f"no paper-trading account configured for segment {segment}",
        )
        db.commit()
        return row

    now = datetime.now(dt_timezone.utc)
    if not is_within_intraday_window(now, account.square_off_time, settings.timezone):
        row = _reject_manual(
            db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price,
            f"received outside intraday window (square-off is {account.square_off_time})",
        )
        db.commit()
        return row

    # Manual orders always allow pyramiding ("add again" on the same
    # instrument while one's already open) - a fixed platform default
    # rather than a per-order toggle, since there's no Strategy to carry
    # duplicate_signal_policy. counter_signal_policy stays close_and_flip,
    # same as everywhere else.
    conflict_check = SimpleNamespace(action=action, duplicate_signal_policy="add_position", counter_signal_policy="close_and_flip")
    open_positions = db.query(db_models.Position).filter_by(user_id=user_id, symbol=symbol, status="OPEN").all()
    positions_to_close, reject_reason = _resolve_signal_conflicts(open_positions, conflict_check)
    if reject_reason is not None:
        row = _reject_manual(db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price, reject_reason)
        db.commit()
        return row

    for pos in positions_to_close:
        pos.exit_price = price
        pos.exit_time = datetime.now(dt_timezone.utc)
        raw_pnl = compute_pnl(pos.action, float(pos.entry_price), price, float(pos.quantity))
        _apply_realized_pnl(pos, account, _net_pnl_with_costs(pos, price, raw_pnl), settings.usdinr_rate)
        pos.status = "CLOSED"
        pos.exit_reason = "counter_signal"

    effective_capital = min(float(account.capital_per_trade), float(account.current_balance))
    if segment == "CRYPTO":
        if settings.usdinr_rate is None:
            row = _reject_manual(
                db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price,
                "no USDINR rate configured - set one in Settings to size a CRYPTO position",
            )
            db.commit()
            return row
        effective_capital = effective_capital / settings.usdinr_rate
        effective_capital = effective_capital * float(account.leverage)

    capital_unit = "USD" if segment == "CRYPTO" else "INR"
    if quantity is not None:
        # `quantity` here is the number of LOTS, not raw underlying units -
        # lot_size=1 for spot (no-op multiply, quantity stays raw BTC/share
        # units as before), a real multiplier for future (matches how the
        # auto-sized path below already interprets it via compute_quantity,
        # and Delta Exchange India's own "Lot" input on their real trading
        # UI - e.g. BTCUSD lot_size=0.001, so quantity=1 means 1 lot =
        # 0.001 BTC, not 1 whole BTC).
        required_cost = price * lot_size * quantity
        if effective_capital < required_cost:
            row = _reject_manual(
                db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price,
                f"insufficient account balance ({effective_capital} {capital_unit} available for {segment}, "
                f"need at least {required_cost} for {quantity} lot(s))",
            )
            db.commit()
            return row
        final_quantity = quantity * lot_size
    else:
        # Compare against 1 LOT's cost, not 1 full underlying unit - same
        # fix as open_position, needed for CRYPTO futures whose lot_size
        # is a real fraction (e.g. BTCUSD=0.001).
        if effective_capital < price * lot_size:
            row = _reject_manual(
                db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price,
                f"insufficient account balance ({effective_capital} {capital_unit} available for {segment}, "
                f"need at least {price * lot_size} for 1 lot)",
            )
            db.commit()
            return row
        if stop_loss_price is not None:
            stop_distance = abs(price - stop_loss_price)
            if stop_distance <= 0:
                row = _reject_manual(
                    db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price,
                    f"stop-loss price ({stop_loss_price}) equals entry price ({price}) - can't size by risk",
                )
                db.commit()
                return row
            final_quantity = compute_risk_based_quantity(
                effective_capital, float(account.risk_per_trade_pct), price, stop_loss_price, lot_size
            )
        else:
            final_quantity = compute_quantity(effective_capital, price, lot_size)

    # Live-broker-adapter P1 (see docs/architecture.md) - a hard money-safety
    # cap, opt-in per account (NULL = no cap), checked regardless of whether
    # this order actually goes live below - same "in the same place the
    # existing paper balance check already lives" placement as that check.
    order_value = price * final_quantity
    if account.max_order_value is not None and order_value > float(account.max_order_value):
        row = _reject_manual(
            db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price,
            f"order value ({order_value}) exceeds this account's max_order_value cap ({account.max_order_value})",
        )
        db.commit()
        return row

    # Live-broker-adapter P1 - only NSE/MCX spot/future (CRYPTO is a
    # different broker with no order API yet - see the plan's own P3 item
    # 16; options go through open_manual_option_group instead, untouched
    # by this function entirely). is_supported() at the top of this
    # function already guarantees instrument_type is spot/future here.
    broker_order = None
    if is_live_enabled(account) and segment in ("NSE", "MCX"):
        # Live-broker-adapter P2 (see docs/architecture.md) - trips the
        # kill-switch-equivalent for THIS account for the rest of today
        # once its realized loss reaches the configured cap. Only gates
        # live orders (a paper account hitting this has nothing real at
        # risk) - checked fresh every live submission, not cached, so it
        # self-clears at the next calendar day without any reset step.
        if account.max_daily_loss is not None:
            realized_today = _today_realized_pnl(db, user_id, segment, settings.timezone)
            if realized_today <= -float(account.max_daily_loss):
                row = _reject_manual(
                    db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price,
                    f"daily loss cap reached for this account ({realized_today:.2f} realized today, cap is "
                    f"{account.max_daily_loss}) - live trading is paused for the rest of today",
                )
                db.commit()
                return row
        if not token:
            row = _reject_manual(
                db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price,
                "live trading is enabled for this account but no authenticated bearer token was available to place the real order",
            )
            db.commit()
            return row
        broker_order, live_error = submit_live_order(
            db, user_id, token, position_id=None, purpose="entry",
            exchange=segment, symbol=symbol, action=action, quantity=final_quantity,
        )
        if live_error is not None:
            row = _reject_manual(db, user_id, signal_id, symbol, segment, segment, action, instrument_type, price, live_error)
            db.commit()
            return row
        # Real fill data from Dhan's postback, when present - see
        # internal.py's own caveat on why these fields are best-effort and
        # fall back to the originally computed price/quantity otherwise.
        if broker_order.average_fill_price is not None:
            price = float(broker_order.average_fill_price)
        if broker_order.filled_quantity:
            final_quantity = broker_order.filled_quantity

    # horizon="intraday" hardcoded - every Manual tab position is intraday
    # (see docs/architecture.md's Trade discipline checklist section), so
    # this can never hit the NSE MTF branch inside _open_delta_fee_fields.
    open_fee, margin_posted, liquidation_price, _mtf_interest_rate_pct = _open_delta_fee_fields(
        segment, instrument_type, "intraday", action, price, final_quantity, account, account, settings.usdinr_rate, use_margin=False
    )

    row = db_models.Position(
        user_id=user_id,
        signal_id=signal_id,
        strategy_id=None,
        symbol=symbol,
        exchange=segment,
        segment=segment,
        action=action,
        horizon="intraday",
        instrument_type=instrument_type,
        quantity=final_quantity,
        entry_price=price,
        status="OPEN",
        is_live_broker_order=broker_order is not None,
        live_trading_user_id=user_id if broker_order is not None else None,
        stop_loss_price=stop_loss_price,
        initial_stop_loss_price=stop_loss_price,
        trailing_stop_enabled=trailing_stop_enabled,
        stop_loss_method=stop_loss_method,
        stop_loss_interval=stop_loss_interval,
        stop_loss_percent=stop_loss_percent,
        stop_loss_indicator_type=stop_loss_indicator_type,
        stop_loss_indicator_params=stop_loss_indicator_params,
        square_off_time=square_off_time if square_off_time is not None else account.square_off_time,
        open_fee=open_fee,
        margin_posted=margin_posted,
        liquidation_price=liquidation_price,
        plan_checklist=plan_checklist,
        order_type=order_type,
    )
    db.add(row)
    db.commit()
    if broker_order is not None:
        broker_order.position_id = row.id
        db.commit()
        # Live-broker-adapter P2 - real, resting protection on the exchange
        # itself, placed immediately once the entry is confirmed TRADED.
        # Best-effort: a failure here does NOT reject/unwind the (already
        # real) entry - it just falls back to the existing in-app CMP-based
        # exit-monitor as the sole safety net, same as before this existed
        # (see submit_resting_stop_loss's own docstring, and
        # _settle_live_exit's reactive-market-exit fallback below).
        if stop_loss_price is not None:
            closing_action = "SELL" if action == "BUY" else "BUY"
            _sl_order, sl_error = submit_resting_stop_loss(
                db, user_id, token, position_id=row.id, exchange=segment, symbol=symbol,
                action=closing_action, quantity=final_quantity, trigger_price=stop_loss_price,
            )
            if sl_error is not None:
                logger.warning(
                    "resting stop-loss order failed for live position %s: %s - falling back to in-app monitoring only",
                    row.id, sl_error,
                )
    return row


def update_square_off_time(
    db: Session, user_id: uuid.UUID, position_id: uuid.UUID, square_off_time: Optional[time]
) -> Optional[db_models.Position]:
    """PUT /positions/{id}/square-off-time - edits an already-open
    position's own square_off_time (see ManualPositionCreate.
    square_off_time's own comment). Deliberately as small as
    SpotStopLossUpdate's own update_group_spot_stop_loss - a single-column
    write, no recompute needed (unlike update_stop_loss, which may
    re-derive a price from a method)."""
    row = db.get(db_models.Position, position_id)
    if row is None or row.user_id != user_id or row.status != "OPEN":
        return None
    row.square_off_time = square_off_time
    db.commit()
    return row


def update_stop_loss(
    db: Session,
    user_id: uuid.UUID,
    position_id: uuid.UUID,
    stop_loss_price: Optional[float],
    stop_loss_method: Optional[str] = None,
    stop_loss_interval: Optional[str] = None,
    stop_loss_percent: Optional[float] = None,
    stop_loss_indicator_type: Optional[str] = None,
    stop_loss_indicator_params: Optional[dict] = None,
    trailing_stop_enabled: bool = False,
    get_previous_candle: Optional[GetPreviousCandle] = None,
    get_candle_history: Optional[GetCandleHistory] = None,
) -> tuple[Optional[db_models.Position], Optional[str]]:
    """Generically useful, not manual-only - editing SL on any already-open
    position, including (new) attaching or replacing a trailing,
    method-based stop-loss AFTER the position is already open - the same
    percent/previous_candle/indicator choice ManualPositionCreate offers
    at order placement time (StopLossUpdate's own model_validator enforces
    the same mutual-exclusion/required-siblings rules before this is ever
    called). `stop_loss_method=None` sets a flat, fixed `stop_loss_price`
    directly (the original behavior) and clears any previously-armed
    trailing method. Never touches initial_stop_loss_price, an immutable
    audit column set once at open time.

    Returns (row, reject_reason) - reject_reason is only ever non-None for
    the method branch (not enough history yet, wrong side of the
    position's own entry_price, etc, via _resolve_stop_loss), in which
    case the position's stop-loss is left completely untouched rather than
    partially applied. Uses `row.entry_price` as the reference price for
    _resolve_stop_loss's own wrong-side guard (not a fresh CMP fetch) -
    same reference point open_position/open_manual_position already use
    at order-placement time; any staleness self-corrects on the very next
    check_exits tick once trailing_stop_enabled is on, same as a freshly-
    opened position's own indicator stop would."""
    row = db.get(db_models.Position, position_id)
    if row is None or row.user_id != user_id:
        return None, None

    if stop_loss_method is None:
        row.stop_loss_price = stop_loss_price
        row.stop_loss_method = None
        row.stop_loss_interval = None
        row.stop_loss_percent = None
        row.stop_loss_indicator_type = None
        row.stop_loss_indicator_params = None
        row.trailing_stop_enabled = False
        db.commit()
        return row, None

    resolved_price, reject_reason = _resolve_stop_loss(
        stop_loss_method,
        row.action,
        float(row.entry_price),
        stop_loss_interval,
        stop_loss_percent,
        stop_loss_indicator_type,
        stop_loss_indicator_params,
        row.exchange,
        row.symbol,
        get_previous_candle,
        get_candle_history,
    )
    if reject_reason is not None:
        return row, reject_reason

    row.stop_loss_price = resolved_price
    row.stop_loss_method = stop_loss_method
    row.stop_loss_interval = stop_loss_interval
    row.stop_loss_percent = stop_loss_percent
    row.stop_loss_indicator_type = stop_loss_indicator_type
    row.stop_loss_indicator_params = stop_loss_indicator_params
    row.trailing_stop_enabled = trailing_stop_enabled
    db.commit()
    return row, None


def _quotes_by_exchange(positions: list, get_ltp_batch: GetLtpBatch) -> dict[tuple[str, str], float]:
    """One get_ltp_batch call per distinct exchange among `positions`,
    covering every distinct symbol on that exchange - this is what turns
    N open positions into (at most) len(distinct exchanges) provider
    calls instead of N. A failed batch for one exchange doesn't affect
    others; its symbols are just absent from the result."""
    symbols_by_exchange: dict[str, set[str]] = {}
    for pos in positions:
        symbols_by_exchange.setdefault(pos.exchange, set()).add(pos.symbol)

    quotes: dict[tuple[str, str], float] = {}
    for exchange, symbols in symbols_by_exchange.items():
        try:
            prices = get_ltp_batch(exchange, list(symbols))
        except Exception:
            logger.exception("failed to fetch CMP batch for %s (%d symbols)", exchange, len(symbols))
            continue
        for symbol, price in prices.items():
            quotes[(exchange, symbol)] = price

    return quotes


def compute_unrealized_pnl(positions: list, get_ltp_batch: GetLtpBatch) -> dict:
    """Read-only mark-to-market for a batch of positions - no DB mutation,
    unlike square_off_all_open. Non-OPEN positions and positions whose
    quote fetch fails are simply absent from the result (already-realized
    P&L or a failed lookup, either way there's nothing live to report).
    Returns {position.id: (live_price, unrealized_pnl)}."""
    open_positions = [pos for pos in positions if pos.status == "OPEN"]
    quotes = _quotes_by_exchange(open_positions, get_ltp_batch)

    result: dict = {}
    for pos in open_positions:
        cmp_price = quotes.get((pos.exchange, pos.symbol))
        if cmp_price is None:
            continue

        unrealized = compute_pnl(pos.action, float(pos.entry_price), cmp_price, float(pos.quantity))
        result[pos.id] = (cmp_price, unrealized)

    return result


def record_position_pnl_snapshots(db: Session, get_ltp_batch: GetLtpBatch) -> dict:
    """Persists one PositionPnlSnapshot row per OPEN position with a live
    quote this tick - the write counterpart to compute_unrealized_pnl
    above (reused as-is, unchanged). Called from app/scheduler.py's
    run_check_exits, piggybacking on the exit-monitor's own 30s tick, but
    deliberately against EVERY open position (not just the stop-loss/
    target/liquidation-having subset check_exits itself scopes its own
    candidate query to) - a plain capital-sized position still gets a P&L
    history. See infra/postgres/init/02-execution.sql's own comment on
    position_pnl_snapshots for the full design/scope notes."""
    open_positions = db.query(db_models.Position).filter_by(status="OPEN").all()
    live = compute_unrealized_pnl(open_positions, get_ltp_batch)
    for position_id, (cmp_price, unrealized_pnl) in live.items():
        db.add(db_models.PositionPnlSnapshot(position_id=position_id, cmp=cmp_price, unrealized_pnl=unrealized_pnl))
    db.commit()
    return {"recorded": len(live), "checked": len(open_positions)}


def square_off_all_open(db: Session, user_id: uuid.UUID, get_ltp_batch: GetLtpBatch) -> dict:
    """Closes every OPEN position BELONGING TO user_id at CMP - only ever
    reachable via the authenticated POST /positions/square-off route, so
    always scoped to the caller's own positions (never the automated
    flow's, whose positions always have user_id=None). One quote fetch per
    distinct exchange among them. A position whose quote fetch fails is
    left OPEN (not rejected - it's a real paper position, just not
    closeable right now) so the next scheduled run or a manual retry can
    close it."""
    open_positions = db.query(db_models.Position).filter_by(user_id=user_id, status="OPEN").all()
    quotes = _quotes_by_exchange(open_positions, get_ltp_batch)
    accounts = _accounts_by_segment(db, open_positions)
    strategy_accounts = _strategy_accounts_by_id(db, open_positions)
    usdinr_rate = load_settings(db, user_id).usdinr_rate
    closed = 0
    failed = 0

    for pos in open_positions:
        cmp_price = quotes.get((pos.exchange, pos.symbol))
        if cmp_price is None:
            failed += 1
            continue

        pos.exit_price = cmp_price
        pos.exit_time = datetime.now(dt_timezone.utc)
        raw_pnl = compute_pnl(pos.action, float(pos.entry_price), cmp_price, float(pos.quantity))
        _apply_realized_pnl(
            pos, _resolve_capital_account(pos, accounts, strategy_accounts), _net_pnl_with_costs(pos, cmp_price, raw_pnl), usdinr_rate
        )
        pos.status = "CLOSED"
        pos.exit_reason = "square_off"
        closed += 1

    db.commit()
    return {"closed": closed, "failed": failed, "total_open": len(open_positions)}


def square_off_position(
    db: Session,
    user_id: uuid.UUID,
    position_id: uuid.UUID,
    get_ltp_batch: GetLtpBatch,
    quantity: Optional[float] = None,
    token: Optional[str] = None,
) -> dict:
    """Closes exactly one OPEN position by id - the per-row 'Square off'
    button in the frontend's Positions grid, as opposed to
    square_off_all_open (every open position) or square_off_due_positions
    (only those past their own square_off_time). exit_reason='manual'
    distinguishes this from the other two closing paths.

    `quantity` (optional) closes only part of the position - the rest
    stays OPEN with a reduced quantity, and the closed portion gets its
    own separate CLOSED Position row (a fresh signal_id, not the parent's -
    open_position's own idempotency lookup does
    filter_by(signal_id=...).one_or_none() and would break if two rows
    ever shared one) so each partial exit is a durable, queryable record
    rather than only living in whatever called this. Omitted or equal to
    the full held quantity behaves exactly as before this parameter
    existed.

    Live-broker-adapter P1 (see docs/architecture.md) - if `pos` was opened
    as a real broker order (pos.is_live_broker_order), this ALWAYS submits
    a real closing order via app/domain/live_broker.py before touching any
    DB state, regardless of the account's CURRENT live_trading_enabled
    (which may have changed since this position opened - a real position
    must always close through the same real path it opened through, never
    silently downgrade to a paper close). Only a FULL close is supported
    live for now - a partial close of a live position returns
    'live_partial_not_supported' rather than only paper-closing part of a
    real position. `token` is required whenever pos.is_live_broker_order is
    true; omitted for every paper position, unaffected."""
    pos = db.get(db_models.Position, position_id)
    if pos is None or pos.user_id != user_id:
        return {"status": "not_found"}
    if pos.status != "OPEN":
        return {"status": "not_open", "position_status": pos.status}

    held_quantity = float(pos.quantity)
    close_quantity = held_quantity if quantity is None else quantity
    if close_quantity <= 0 or close_quantity > held_quantity:
        return {"status": "invalid_quantity", "held_quantity": held_quantity}

    quotes = get_ltp_batch(pos.exchange, [pos.symbol])
    cmp_price = quotes.get(pos.symbol)
    if cmp_price is None:
        return {"status": "quote_unavailable"}

    if pos.is_live_broker_order:
        if close_quantity != held_quantity:
            return {"status": "live_partial_not_supported"}
        if not token:
            return {"status": "live_token_required"}
        closing_action = "SELL" if pos.action == "BUY" else "BUY"
        broker_order, live_error = submit_live_order(
            db, user_id, token, position_id=pos.id, purpose="exit",
            exchange=pos.segment, symbol=pos.symbol, action=closing_action, quantity=close_quantity,
        )
        if live_error is not None:
            return {"status": "live_order_failed", "reason": live_error}
        if broker_order.average_fill_price is not None:
            cmp_price = float(broker_order.average_fill_price)

    account = load_capital_account(db, user_id, pos.segment, pos.strategy_id)
    usdinr_rate = load_settings(db, user_id).usdinr_rate
    raw_pnl = compute_pnl(pos.action, float(pos.entry_price), cmp_price, close_quantity)

    if close_quantity == held_quantity:
        pos.exit_price = cmp_price
        pos.exit_time = datetime.now(dt_timezone.utc)
        _apply_realized_pnl(pos, account, _net_pnl_with_costs(pos, cmp_price, raw_pnl), usdinr_rate)
        pos.status = "CLOSED"
        pos.exit_reason = "manual"
        db.commit()
        return {
            "status": "closed",
            "position_id": str(pos.id),
            "symbol": pos.symbol,
            "exit_price": cmp_price,
            "pnl": float(pos.pnl),
            "closed_quantity": close_quantity,
            "remaining_quantity": 0.0,
        }

    remaining_quantity = held_quantity - close_quantity
    # open_fee/margin_posted were both computed off the FULL original
    # quantity at open time (_open_delta_fee_fields) - a partial close must
    # split them by the same ratio it splits quantity, or either portion
    # would double-count (or lose) part of the original figures.
    # liquidation_price is a PRICE level, not quantity-dependent, so it's
    # left as-is on `pos` and simply not copied onto closed_row (a CLOSED
    # row never needs one).
    close_fraction = close_quantity / held_quantity
    closed_open_fee = float(pos.open_fee) * close_fraction if pos.open_fee is not None else None
    if pos.open_fee is not None:
        pos.open_fee = float(pos.open_fee) - closed_open_fee
        pos.margin_posted = float(pos.margin_posted) * (1 - close_fraction)
    pos.quantity = remaining_quantity
    closed_row = db_models.Position(
        user_id=pos.user_id,
        signal_id=uuid.uuid4(),
        strategy_id=pos.strategy_id,
        symbol=pos.symbol,
        exchange=pos.exchange,
        segment=pos.segment,
        action=pos.action,
        horizon=pos.horizon,
        instrument_type=pos.instrument_type,
        quantity=close_quantity,
        entry_price=pos.entry_price,
        entry_time=pos.entry_time,
        exit_price=cmp_price,
        exit_time=datetime.now(dt_timezone.utc),
        status="CLOSED",
        exit_reason="manual",
        square_off_time=pos.square_off_time,
        open_fee=closed_open_fee,
    )
    _apply_realized_pnl(closed_row, account, _net_pnl_with_costs(closed_row, cmp_price, raw_pnl), usdinr_rate)
    db.add(closed_row)
    db.commit()
    return {
        "status": "closed",
        "position_id": str(closed_row.id),
        "symbol": pos.symbol,
        "exit_price": cmp_price,
        "pnl": float(closed_row.pnl),
        "closed_quantity": close_quantity,
        "remaining_quantity": remaining_quantity,
    }


def _evaluate_square_off_due(
    positions: list,
    get_ltp_batch: GetLtpBatch,
    now_local: time,
    accounts_by_segment: dict,
    strategy_accounts: Optional[dict] = None,
    usdinr_rate_by_user: Optional[dict] = None,
) -> dict:
    """Pure logic (no DB query/commit) - closes positions in place whose
    own square_off_time has already passed the given local time. Mirrors
    _evaluate_exits' split from its DB-querying wrapper, for the same
    testability reason (plain objects like FakePosition instead of a
    real Session). strategy_accounts is optional (defaults to {}, i.e.
    every position falls back to its segment account) so every existing
    caller/test that predates execution.strategy_accounts keeps working
    unchanged - see _resolve_capital_account. usdinr_rate_by_user is
    optional too (defaults to {}, i.e. no CRYPTO conversion for anyone) -
    keyed by pos.user_id, since a cross-tenant batch can mix positions
    from several users, each with their own configured rate (or the
    automated flow's legacy platform-wide one) - unlike a single-user
    call, which just passes one float."""
    due = [p for p in positions if p.square_off_time is not None and now_local >= p.square_off_time]
    if not due:
        return {"closed": 0, "failed": 0, "checked": 0, "live_square_offs_needed": []}

    quotes = _quotes_by_exchange(due, get_ltp_batch)
    rates = usdinr_rate_by_user or {}
    closed = 0
    failed = 0
    # Live-broker-adapter P2 - a live position due for square-off closes
    # through a real order (square_off_due_positions, the DB-committing
    # wrapper), never this paper write - see _evaluate_exits' identical
    # live_exits_needed pattern for the same "pure logic, no DB/HTTP here"
    # reasoning.
    live_square_offs_needed: list = []

    for pos in due:
        if getattr(pos, "is_live_broker_order", False):
            live_square_offs_needed.append(pos)
            continue
        cmp_price = quotes.get((pos.exchange, pos.symbol))
        if cmp_price is None:
            failed += 1
            continue

        pos.exit_price = cmp_price
        pos.exit_time = datetime.now(dt_timezone.utc)
        raw_pnl = compute_pnl(pos.action, float(pos.entry_price), cmp_price, float(pos.quantity))
        _apply_realized_pnl(
            pos, _resolve_capital_account(pos, accounts_by_segment, strategy_accounts), _net_pnl_with_costs(pos, cmp_price, raw_pnl),
            rates.get(pos.user_id),
        )
        pos.status = "CLOSED"
        pos.exit_reason = "square_off"
        closed += 1

    return {"closed": closed, "failed": failed, "checked": len(due), "live_square_offs_needed": live_square_offs_needed}


def square_off_due_positions(db: Session, get_ltp_batch: GetLtpBatch) -> dict:
    """Closes each OPEN position (across every user AND the automated
    flow - a background job, not a per-request one) once local time
    passes ITS OWN stored square_off_time - the periodic replacement for
    a single daily cron trigger, since square_off_time can now differ per
    position (a Strategy override, or whatever the platform default was
    at open time). This is what the scheduler's periodic job actually
    calls; square_off_all_open (unconditional, ignores each position's
    own time, and scoped to one authenticated user) remains for the
    manual 'square off everything now' button.

    now_local is computed from the platform's own legacy timezone setting
    for every position regardless of owner - a deliberate simplification
    (every segment trades on IST-based hours regardless of who's
    watching), unlike usdinr_rate below which genuinely can differ per
    user and does get resolved per-position."""
    exec_settings = load_settings(db)
    now_local = datetime.now(dt_timezone.utc).astimezone(ZoneInfo(exec_settings.timezone)).time()
    open_positions = db.query(db_models.Position).filter_by(status="OPEN").all()
    accounts = _accounts_by_segment(db, open_positions)
    strategy_accounts = _strategy_accounts_by_id(db, open_positions)
    usdinr_rates = _usdinr_rate_by_user(db, open_positions)
    result = _evaluate_square_off_due(open_positions, get_ltp_batch, now_local, accounts, strategy_accounts, usdinr_rates)
    db.commit()

    live_square_offs_needed = result.pop("live_square_offs_needed", [])
    for pos in live_square_offs_needed:
        _settle_live_exit(db, pos, "square_off")
    if live_square_offs_needed:
        db.commit()

    return result


def _evaluate_exits(
    positions: list,
    get_ltp_batch: GetLtpBatch,
    get_previous_candle: GetPreviousCandle,
    accounts_by_segment: dict,
    get_candle_history: Optional[GetCandleHistory] = None,
    strategy_accounts: Optional[dict] = None,
    usdinr_rate_by_user: Optional[dict] = None,
) -> dict:
    """Pure logic (no DB query/commit) - mutates the given position
    objects in place (closing them, or trailing stop_loss_price) and
    returns a summary. Split out from check_exits so it's directly
    unit-testable with plain objects (e.g. FakePosition), the same reason
    compute_unrealized_pnl takes a plain `positions: list` instead of a
    Session.

    Only positions with a stop_loss_price, target_price, or liquidation_price
    set should be passed in - plain capital-sized positions (none set)
    aren't monitored at all, no added overhead for them (check_exits filters
    before calling this). Liquidation takes priority over SL/target if
    multiple would fire in the same tick (a real exchange force-closes a
    liquidated position regardless of what stop-loss the strategy itself
    configured); SL takes priority over target if both would fire (gappy
    price).

    Trailing (only trailing_stop_enabled positions, stop-loss only, never
    the target - see docs/architecture.md) ratchets stop_loss_price using
    the same method the position was opened with, re-anchored to the
    current CMP (percent method), the latest completed candle
    (previous_candle method), or the latest indicator value (indicator
    method, via _STOP_LOSS_COMPUTE_FUNCS) - and only if the new candidate
    is MORE favorable than the stored value. It never loosens.
    stop_loss_method='breakeven' is the one exception to "continuous
    ratchet": it moves exactly once, snapping to entry_price the first
    time price moves stop_loss_percent% favorably, then freezes there for
    the rest of the position's life (breakeven_triggered records this).
    get_candle_history is Optional (default None) purely so existing
    callers/tests that only ever exercise percent/previous_candle
    positions don't need updating - a position with
    stop_loss_method='indicator' but no get_candle_history supplied is
    simply skipped for trailing, same as a candle fetch failure below."""
    if not positions:
        return {"closed_stop_loss": 0, "closed_target": 0, "trailed": 0, "checked": 0, "live_exits_needed": []}

    quotes = _quotes_by_exchange(positions, get_ltp_batch)
    closed_stop_loss = 0
    closed_target = 0
    trailed = 0
    # Live-broker-adapter P2 - (pos, reason) pairs a live position's own
    # sl_hit/target_hit flagged, for check_exits (the DB-committing
    # wrapper) to actually close for real - see the sl_hit/target_hit
    # branch below.
    live_exits_needed: list[tuple[object, str]] = []
    # Dedupe candle fetches within this run - several positions may share
    # the same (exchange, symbol, interval); market-data's own
    # interval-length TTL cache further dedupes across separate runs.
    candle_cache: dict[tuple[str, str, str], Optional[dict]] = {}
    candle_history_cache: dict[tuple[str, str, str], list[dict]] = {}
    rates = usdinr_rate_by_user or {}

    for pos in positions:
        cmp_price = quotes.get((pos.exchange, pos.symbol))
        if cmp_price is None:
            continue

        liquidated = pos.liquidation_price is not None and (
            (pos.action == "BUY" and cmp_price <= float(pos.liquidation_price))
            or (pos.action == "SELL" and cmp_price >= float(pos.liquidation_price))
        )
        if liquidated:
            # Delta Exchange liquidation simulation, Rule E - wipes the
            # FULL posted margin + a liquidation fee (which REPLACES the
            # normal close fee entirely, never both), not the more lenient
            # raw price-distance loss compute_pnl would give - see
            # delta_fees.compute_liquidation_price's own docstring on why.
            # Pre-empts stop-loss/target/trailing below for this tick, same
            # as a real exchange force-closing regardless of the strategy's
            # own configured stop.
            # leverage isn't stored directly on the position - back-derive
            # it from what IS stored (margin_posted = notional_at_open /
            # leverage, and notional_at_open = entry_price * quantity,
            # quantity never changing between open and a full liquidation).
            leverage = (float(pos.entry_price) * float(pos.quantity)) / float(pos.margin_posted)
            liquidation_fee = compute_futures_liquidation_fee(pos.symbol, cmp_price * float(pos.quantity), leverage)
            pos.exit_price = cmp_price
            pos.exit_time = datetime.now(dt_timezone.utc)
            pos.close_fee = liquidation_fee
            _apply_realized_pnl(
                pos, _resolve_capital_account(pos, accounts_by_segment, strategy_accounts), -float(pos.margin_posted) - liquidation_fee,
                rates.get(pos.user_id),
            )
            pos.status = "CLOSED"
            pos.exit_reason = "liquidation"
            closed_stop_loss += 1
            continue

        sl_hit = pos.stop_loss_price is not None and (
            (pos.action == "BUY" and cmp_price <= float(pos.stop_loss_price))
            or (pos.action == "SELL" and cmp_price >= float(pos.stop_loss_price))
        )
        target_hit = pos.target_price is not None and (
            (pos.action == "BUY" and cmp_price >= float(pos.target_price))
            or (pos.action == "SELL" and cmp_price <= float(pos.target_price))
        )

        if sl_hit or target_hit:
            if getattr(pos, "is_live_broker_order", False):
                # A live position's actual close must go through a real
                # broker order, never a paper write - see
                # position_manager._settle_live_exit (the DB-committing
                # wrapper, check_exits, handles this list; this pure
                # function only ever collects candidates, no DB/HTTP here).
                live_exits_needed.append((pos, "stop_loss" if sl_hit else "target"))
                continue
            pos.exit_price = cmp_price
            pos.exit_time = datetime.now(dt_timezone.utc)
            raw_pnl = compute_pnl(pos.action, float(pos.entry_price), cmp_price, float(pos.quantity))
            _apply_realized_pnl(
                pos, _resolve_capital_account(pos, accounts_by_segment, strategy_accounts), _net_pnl_with_costs(pos, cmp_price, raw_pnl),
                rates.get(pos.user_id),
            )
            pos.status = "CLOSED"
            if sl_hit:
                pos.exit_reason = "stop_loss"
                closed_stop_loss += 1
            else:
                pos.exit_reason = "target"
                closed_target += 1
            continue

        if pos.trailing_stop_enabled and pos.stop_loss_method is not None:
            candidate_stop: Optional[float] = None
            if pos.stop_loss_method == "percent":
                candidate_stop = compute_stop_loss_percent_price(pos.action, cmp_price, float(pos.stop_loss_percent))
            elif pos.stop_loss_method == "previous_candle":
                key = (pos.exchange, pos.symbol, pos.stop_loss_interval)
                if key not in candle_cache:
                    try:
                        candle_cache[key] = get_previous_candle(pos.exchange, pos.symbol, pos.stop_loss_interval)
                    except Exception:
                        logger.exception("failed to fetch trailing candle for %s:%s", pos.exchange, pos.symbol)
                        candle_cache[key] = None
                candle = candle_cache[key]
                if candle is not None:
                    candidate_stop = candle["low"] if pos.action == "BUY" else candle["high"]
            elif pos.stop_loss_method == "indicator" and get_candle_history is not None:
                key = (pos.exchange, pos.symbol, pos.stop_loss_interval)
                if key not in candle_history_cache:
                    try:
                        params = pos.stop_loss_indicator_params or {}
                        warmup_from, warmup_to = _indicator_history_window(params.get("period", 20), pos.stop_loss_interval)
                        candle_history_cache[key] = get_candle_history(
                            pos.exchange, pos.symbol, pos.stop_loss_interval, warmup_from, warmup_to
                        )
                    except Exception:
                        logger.exception("failed to fetch trailing candle history for %s:%s", pos.exchange, pos.symbol)
                        candle_history_cache[key] = []
                compute = _STOP_LOSS_COMPUTE_FUNCS.get(pos.stop_loss_indicator_type)
                if compute is not None and candle_history_cache[key]:
                    raw_candidate = compute(candle_history_cache[key], pos.stop_loss_indicator_params or {})
                    # Same wrong-side guard as open_position's own indicator
                    # branch - a candidate that isn't on the protective side
                    # of the CURRENT price isn't a real trailing update,
                    # discard it rather than let "only tighten" wave it
                    # through against the stored stop.
                    if raw_candidate is not None and (
                        (pos.action == "BUY" and raw_candidate < cmp_price) or (pos.action == "SELL" and raw_candidate > cmp_price)
                    ):
                        candidate_stop = raw_candidate
            elif pos.stop_loss_method == "breakeven" and not pos.breakeven_triggered:
                # One-shot: once price has moved stop_loss_percent%
                # favorably from entry, snap the stop to entry_price and
                # flag it triggered - every subsequent tick then falls
                # through this elif (breakeven_triggered is already True)
                # with candidate_stop staying None, so the stop stays
                # frozen at entry for good ("let it ride", not a
                # continuous trail like the 'percent' method above).
                entry_price = float(pos.entry_price)
                pct = float(pos.stop_loss_percent)
                moved_favorably = (
                    (pos.action == "BUY" and cmp_price >= entry_price * (1 + pct / 100))
                    or (pos.action == "SELL" and cmp_price <= entry_price * (1 - pct / 100))
                )
                if moved_favorably:
                    candidate_stop = entry_price
                    pos.breakeven_triggered = True

            if candidate_stop is not None:
                current_stop = float(pos.stop_loss_price)
                more_favorable = candidate_stop > current_stop if pos.action == "BUY" else candidate_stop < current_stop
                if more_favorable:
                    pos.stop_loss_price = candidate_stop
                    trailed += 1

    return {
        "closed_stop_loss": closed_stop_loss,
        "closed_target": closed_target,
        "trailed": trailed,
        "checked": len(positions),
        "live_exits_needed": live_exits_needed,
    }


def settle_live_position_exit(db: Session, pos: db_models.Position, exit_price: float, exit_reason: str) -> None:
    """Applies a REAL close to a live position's DB row - shared by every
    path that can learn a live position actually closed: the exit-monitor/
    square-off scheduler jobs below (once their own submitted order
    confirms TRADED) AND the Dhan postback handler (app/api/routes/
    internal.py, for a RESTING order Dhan's own engine fills on its own
    schedule, which neither scheduler job is watching for). Idempotent -
    a no-op if `pos` is no longer OPEN, since both of those paths can
    plausibly race to settle the same position (a postback arriving just
    after the scheduler's own synchronous wait already settled it, or
    vice versa)."""
    if pos.status != "OPEN":
        return
    account = load_capital_account(db, pos.user_id, pos.segment, pos.strategy_id)
    usdinr_rate = load_settings(db, pos.user_id).usdinr_rate
    raw_pnl = compute_pnl(pos.action, float(pos.entry_price), exit_price, float(pos.quantity))
    pos.exit_price = exit_price
    pos.exit_time = datetime.now(dt_timezone.utc)
    _apply_realized_pnl(pos, account, _net_pnl_with_costs(pos, exit_price, raw_pnl), usdinr_rate)
    pos.status = "CLOSED"
    pos.exit_reason = exit_reason


def _active_resting_stop_loss(db: Session, position_id: uuid.UUID) -> Optional[db_models.BrokerOrder]:
    return (
        db.query(db_models.BrokerOrder)
        .filter(db_models.BrokerOrder.position_id == position_id, db_models.BrokerOrder.purpose == "stop_loss")
        .filter(db_models.BrokerOrder.status == "pending")
        .order_by(db_models.BrokerOrder.requested_at.desc())
        .first()
    )


def _settle_live_exit(db: Session, pos: db_models.Position, reason: str) -> None:
    """Closes a live position for real - reason is 'stop_loss'/'target'
    (from check_exits' own CMP-based detection) or 'square_off' (from
    square_off_due_positions). If a resting stop-loss order is still
    resting on the exchange for this position, it's CANCELLED first - a
    real position must never have two independent real closing orders in
    flight at once (the resting SL and a fresh reactive market order could
    otherwise both eventually execute). A cancel failure skips this tick
    entirely (logged, not raised) rather than risk a duplicate real
    order - the position may already be filling on the resting order and
    will settle via its own postback, or this simply retries next tick."""
    resting = _active_resting_stop_loss(db, pos.id)
    if resting is not None:
        cancel_error = cancel_resting_order_scheduled(db, pos.live_trading_user_id, resting)
        if cancel_error is not None:
            logger.warning(
                "position %s: flagged for a real %s exit but could not cancel its resting stop-loss order first (%s) - "
                "skipping this tick to avoid a duplicate real order",
                pos.id, reason, cancel_error,
            )
            return

    closing_action = "SELL" if pos.action == "BUY" else "BUY"
    order, error = submit_exit_order_scheduled(
        db, pos.live_trading_user_id, pos.id, pos.segment, pos.symbol, closing_action, float(pos.quantity)
    )
    if error is not None:
        logger.warning("live %s exit failed for position %s, will retry next tick: %s", reason, pos.id, error)
        return

    if order.average_fill_price is not None:
        exit_price = float(order.average_fill_price)
    elif reason == "stop_loss":
        exit_price = float(pos.stop_loss_price)
    elif reason == "target":
        exit_price = float(pos.target_price)
    else:
        # square_off - no stop/target price to fall back to; the exit
        # order confirmed TRADED (submit_exit_order_scheduled only returns
        # error=None once it has), so raw_response should carry SOME price
        # even if average_fill_price's exact field name is still
        # unconfirmed - see internal.py's own caveat on that.
        exit_price = float(pos.entry_price)
    settle_live_position_exit(db, pos, exit_price, reason)


def _reconcile_trailing_stop(db: Session, pos: db_models.Position, new_trigger_price: float) -> None:
    """Throttled/coalesced Modify Order call for a live position's resting
    stop-loss order - only called by check_exits when _evaluate_exits
    actually changed pos.stop_loss_price this tick (the caller's own
    before/after diff IS the throttle: at most one Modify Order call per
    position per 30s exit-monitor tick, never one per poll of an unchanged
    value - see modify_resting_order_scheduled's own docstring). No active
    resting order to modify is logged, not raised - the position stays
    protected by the in-app CMP monitor alone in that case, same fallback
    submit_resting_stop_loss's own docstring describes."""
    order = _active_resting_stop_loss(db, pos.id)
    if order is None:
        logger.warning("live position %s trailed to %s but has no active resting stop-loss order to modify", pos.id, new_trigger_price)
        return
    error = modify_resting_order_scheduled(db, pos.live_trading_user_id, order, new_trigger_price)
    if error is not None:
        logger.warning("failed to modify resting stop-loss for position %s: %s", pos.id, error)


def check_exits(
    db: Session, get_ltp_batch: GetLtpBatch, get_previous_candle: GetPreviousCandle, get_candle_history: GetCandleHistory
) -> dict:
    """Closes OPEN positions early if CMP has hit their stop-loss or
    target, ahead of square-off - the continuous monitoring loop
    square_off_all_open alone doesn't provide. See _evaluate_exits for
    the actual logic; this just queries the DB-eligible candidates and
    commits the result.

    Live-broker-adapter P2 (see docs/architecture.md) - _evaluate_exits
    itself never closes a live position (is_live_broker_order=True) or
    calls Dhan; it only mutates stop_loss_price (trailing) and flags a
    stop/target hit in its own "live_exits_needed" return list, since it's
    pure logic with no DB/HTTP access. This wrapper does the real work for
    both: submits a real reactive market exit for anything flagged
    (_settle_live_exit), and diffs each live position's stop_loss_price
    before/after to call Modify Order on its resting stop exactly when it
    actually trailed (_reconcile_trailing_stop) - never on every tick."""
    candidates = (
        db.query(db_models.Position)
        .filter(db_models.Position.status == "OPEN")
        .filter(
            (db_models.Position.stop_loss_price.isnot(None))
            | (db_models.Position.target_price.isnot(None))
            # A leveraged CRYPTO future can carry a liquidation_price with
            # no stop_loss_price/target_price configured at all (e.g. no
            # Strategy stop-loss method set) - still must be checked every
            # tick, see _evaluate_exits' liquidation branch.
            | (db_models.Position.liquidation_price.isnot(None))
        )
        .all()
    )
    accounts = _accounts_by_segment(db, candidates)
    strategy_accounts = _strategy_accounts_by_id(db, candidates)
    usdinr_rates = _usdinr_rate_by_user(db, candidates)
    prior_live_stops = {p.id: p.stop_loss_price for p in candidates if p.is_live_broker_order}

    result = _evaluate_exits(candidates, get_ltp_batch, get_previous_candle, accounts, get_candle_history, strategy_accounts, usdinr_rates)
    db.commit()

    live_exits_needed = result.pop("live_exits_needed", [])
    for pos, reason in live_exits_needed:
        _settle_live_exit(db, pos, reason)
    db.commit()

    for pos_id, prior_stop in prior_live_stops.items():
        pos = next((p for p in candidates if p.id == pos_id), None)
        if pos is None or pos.status != "OPEN" or pos.stop_loss_price is None:
            continue
        if prior_stop is None or float(pos.stop_loss_price) != float(prior_stop):
            _reconcile_trailing_stop(db, pos, float(pos.stop_loss_price))
    db.commit()

    return result
