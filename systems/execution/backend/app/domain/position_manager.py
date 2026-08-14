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
from app.domain.models import ExecutionSettings, ResolvedOrder

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


def _ema_stop_value(closes: list[float], params: dict) -> Optional[float]:
    ema = compute_ema(closes, params["period"])
    return ema[-1] if ema and ema[-1] is not None else None


# stop_loss_indicator_type -> (closes, params) -> candidate stop value.
# Mirrors signal-generation's own _STOP_LOSS_COMPUTE_FUNCS
# (app/domain/backtest.py) exactly - a deliberate duplicate registry, not
# shared, so live and backtest can never disagree about what a given
# indicator_type+params computes. Adding a second indicator type (e.g.
# SuperTrend) means a new entry here AND there, plus widening both
# systems' DB CHECK constraints and the contract's own enum - see
# signal-generation's app/domain/rule.py for the equivalent comment on
# its own params-validation registry.
_STOP_LOSS_COMPUTE_FUNCS: dict[str, Callable[[list[float], dict], Optional[float]]] = {
    "ema": _ema_stop_value,
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
    today = datetime.now(dt_timezone.utc).date()
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
    """Intraday spot or future positions are handled here - swing/
    positional and options remain rejected until that resolution/
    execution logic exists. `future` was added alongside the in-house
    RSI/SMA(RSI) engine (Phase 3) - a deliberate pull-forward of one
    piece of what was originally planned as Phase 4, so that engine's
    signals are actually tradeable rather than permanently REJECTED. See
    docs/architecture.md."""
    return horizon == "intraday" and instrument_type in ("spot", "future")


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


def load_settings(db: Session) -> ExecutionSettings:
    row = db.get(db_models.Settings, 1)
    return ExecutionSettings(
        timezone=row.timezone, usdinr_rate=float(row.usdinr_rate) if row.usdinr_rate is not None else None
    )


def load_account(db: Session, segment: str) -> Optional[db_models.Account]:
    return db.get(db_models.Account, segment)


def _accounts_by_segment(db: Session, positions: list) -> dict[str, db_models.Account]:
    """One query for the distinct segments among `positions` - mirrors
    _quotes_by_exchange's per-distinct-key batching shape. Used by the
    closing paths (square_off_due_positions, check_exits) so the pure
    logic functions can credit/debit balances without querying the DB
    themselves."""
    segments = {pos.segment for pos in positions}
    if not segments:
        return {}
    rows = db.query(db_models.Account).filter(db_models.Account.segment.in_(segments)).all()
    return {row.segment: row for row in rows}


def _apply_realized_pnl(pos, account, pnl: float) -> None:
    """Sets pos.pnl and, if an account was found, credits/debits its
    current_balance by the same amount - the one piece of bookkeeping
    every closing path shares. account may be None (shouldn't happen -
    positions.segment is NOT NULL + FK-enforced - but defended rather
    than crashing a close over a bookkeeping gap)."""
    pos.pnl = pnl
    if account is None:
        logger.error("no account found for segment %s - position %s closed without a balance update", pos.segment, pos.id)
        return
    account.current_balance = float(account.current_balance) + pnl


def _reject(db: Session, order: ResolvedOrder, signal_id: uuid.UUID, reason: str) -> db_models.Position:
    """quantity is left unset (NULL) - a rejected order was never sized,
    it's not a real position."""
    logger.info("rejecting signal %s: %s", order.signal_id, reason)
    row = db_models.Position(
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
            "only intraday spot/future is handled in this phase",
        )
        db.commit()
        return row

    account = load_account(db, order.segment)
    if account is None:
        row = _reject(db, order, signal_id, f"no paper-trading account configured for segment {order.segment}")
        db.commit()
        return row

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

    open_positions = db.query(db_models.Position).filter_by(symbol=order.symbol, status="OPEN").all()
    positions_to_close, reject_reason = _resolve_signal_conflicts(open_positions, order)
    if reject_reason is not None:
        row = _reject(db, order, signal_id, reject_reason)
        db.commit()
        return row

    for pos in positions_to_close:
        pos.exit_price = order.price
        pos.exit_time = datetime.now(dt_timezone.utc)
        _apply_realized_pnl(
            pos, account, compute_pnl(pos.action, float(pos.entry_price), order.price, float(pos.quantity))
        )
        pos.status = "CLOSED"
        pos.exit_reason = "counter_signal"

    # Sizing is capped by whatever's actually left in the account, not
    # just the account's configured capital_per_trade - a depleted
    # account sizes smaller (or rejects outright below) rather than
    # opening a position it can't afford. See docs/architecture.md
    # § 'Why paper-trading accounts are per-segment, not per-strategy'.
    effective_capital = min(float(account.capital_per_trade), float(account.current_balance))
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

    if effective_capital < order.price * lot_size:
        capital_unit = "USD" if order.segment == "CRYPTO" else "INR"
        row = _reject(
            db,
            order,
            signal_id,
            f"insufficient account balance ({effective_capital} {capital_unit} available for {order.segment}, "
            f"need at least {order.price * lot_size} for 1 lot)",
        )
        db.commit()
        return row

    stop_loss_price: Optional[float] = None
    target_price: Optional[float] = None

    if order.stop_loss_method == "percent":
        stop_loss_price = compute_stop_loss_percent_price(order.action, order.price, order.stop_loss_percent)
    elif order.stop_loss_method == "previous_candle":
        candle = get_previous_candle(order.exchange, order.symbol, order.stop_loss_interval)
        if candle is None:
            row = _reject(
                db,
                order,
                signal_id,
                f"stop_loss_method='previous_candle' but no completed {order.stop_loss_interval} candle "
                f"available for {order.symbol} yet",
            )
            db.commit()
            return row
        stop_loss_price = candle["low"] if order.action == "BUY" else candle["high"]
    elif order.stop_loss_method == "indicator":
        compute = _STOP_LOSS_COMPUTE_FUNCS.get(order.stop_loss_indicator_type)
        if compute is None:
            row = _reject(
                db, order, signal_id, f"unrecognized stop_loss_indicator_type '{order.stop_loss_indicator_type}'"
            )
            db.commit()
            return row
        warmup_from, warmup_to = _indicator_history_window(
            order.stop_loss_indicator_params.get("period", 20), order.stop_loss_interval
        )
        history = get_candle_history(order.exchange, order.symbol, order.stop_loss_interval, warmup_from, warmup_to)
        closes = [c["close"] for c in history]
        stop_loss_price = compute(closes, order.stop_loss_indicator_params)
        if stop_loss_price is None:
            row = _reject(
                db,
                order,
                signal_id,
                f"stop_loss_method='indicator' ({order.stop_loss_indicator_type}) but not enough {order.stop_loss_interval} "
                f"history available for {order.symbol} yet",
            )
            db.commit()
            return row
        # The compute functions return a raw indicator value with no
        # direction concept at all (unlike previous_candle's own low/high
        # split, which is directionally safe by construction) - a value
        # that lands on the WRONG side of entry (e.g. a slow EMA still
        # above entry for a fresh BUY after a downtrend) isn't a
        # protective stop, it's a near-certain instant "stop-out" at a
        # phantom price the market may never trade at, fabricating a
        # same-direction profit instead of limiting a loss - reproduced
        # live via backtest (EMA(400) ~415 points above a bullish entry).
        # Reject cleanly rather than open an unprotected/nonsensical
        # position, same as the "not enough history" case just above.
        if (order.action == "BUY" and stop_loss_price >= order.price) or (
            order.action == "SELL" and stop_loss_price <= order.price
        ):
            row = _reject(
                db,
                order,
                signal_id,
                f"stop_loss_method='indicator' ({order.stop_loss_indicator_type}) computed {stop_loss_price} - "
                f"not on the protective side of entry ({order.price}) for a {order.action}, not usable as a stop-loss",
            )
            db.commit()
            return row

    if order.target_percent is not None:
        target_price = compute_target_percent_price(order.action, order.price, order.target_percent)

    if stop_loss_price is not None:
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
            effective_capital, float(account.risk_per_trade_pct), order.price, stop_loss_price, lot_size
        )
    else:
        quantity = compute_quantity(effective_capital, order.price, lot_size)

    row = db_models.Position(
        signal_id=signal_id,
        strategy_id=uuid.UUID(order.strategy_id),
        symbol=order.symbol,
        exchange=order.exchange,
        segment=order.segment,
        action=order.action,
        horizon=order.horizon,
        instrument_type=order.instrument_type,
        quantity=quantity,
        entry_price=order.price,
        status="OPEN",
        stop_loss_price=stop_loss_price,
        initial_stop_loss_price=stop_loss_price,
        target_price=target_price,
        trailing_stop_enabled=order.trailing_stop_enabled,
        stop_loss_method=order.stop_loss_method,
        stop_loss_interval=order.stop_loss_interval,
        stop_loss_percent=order.stop_loss_percent,
        stop_loss_indicator_type=order.stop_loss_indicator_type,
        stop_loss_indicator_params=order.stop_loss_indicator_params,
        square_off_time=account.square_off_time,
    )
    db.add(row)
    db.commit()
    return row


def open_manual_position(
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
) -> db_models.Position:
    """Manual tab (spot/future only - option orders go through the sibling
    open_manual_option_group in option_position_manager.py instead, which
    resolves its own legs directly rather than sharing this function's
    sizing/gates). Deliberately NOT a ResolvedOrder - that type
    represents the signal-processing contract, and a manual order never
    touches it. Mirrors open_position's gates/sizing exactly (read that
    function alongside this one), with two differences: no Strategy means
    no stop-loss method/percent-target/horizon to carry, so those are
    simplified to "caller supplies a raw stop-loss price directly, horizon
    is always intraday" (the only value is_supported() ever accepts
    anyway); and `quantity`, if given, bypasses auto-sizing entirely - same
    precedence pattern already used for Strategy.option_fixed_lots in
    open_option_group. square_off_time is no longer a caller-supplied
    parameter - like open_position, it's looked up from the segment's own
    account row below.

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
    failing loudly."""
    signal_id = uuid.uuid4()

    if not is_supported("intraday", instrument_type):
        row = _reject_manual(
            db, signal_id, symbol, segment, segment, action, instrument_type, price,
            f"unsupported instrument_type ({instrument_type}) - only spot/future is handled here",
        )
        db.commit()
        return row

    lot_size = 1
    if instrument_type == "future":
        resolved = resolve_underlying(segment, symbol)
        if resolved is None:
            row = _reject_manual(
                db, signal_id, symbol, segment, segment, action, instrument_type, price,
                f"could not resolve underlying '{symbol}' on {segment} for futures",
            )
            db.commit()
            return row
        # Everything below (conflict detection, sizing, persistence) uses
        # the REAL contract symbol from here on - not the bare underlying
        # the caller typed.
        symbol = resolved["trade_symbol"]
        lot_size = resolved["lot_size"]

    account = load_account(db, segment)
    if account is None:
        row = _reject_manual(
            db, signal_id, symbol, segment, segment, action, instrument_type, price,
            f"no paper-trading account configured for segment {segment}",
        )
        db.commit()
        return row

    now = datetime.now(dt_timezone.utc)
    if not is_within_intraday_window(now, account.square_off_time, settings.timezone):
        row = _reject_manual(
            db, signal_id, symbol, segment, segment, action, instrument_type, price,
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
    open_positions = db.query(db_models.Position).filter_by(symbol=symbol, status="OPEN").all()
    positions_to_close, reject_reason = _resolve_signal_conflicts(open_positions, conflict_check)
    if reject_reason is not None:
        row = _reject_manual(db, signal_id, symbol, segment, segment, action, instrument_type, price, reject_reason)
        db.commit()
        return row

    for pos in positions_to_close:
        pos.exit_price = price
        pos.exit_time = datetime.now(dt_timezone.utc)
        _apply_realized_pnl(pos, account, compute_pnl(pos.action, float(pos.entry_price), price, float(pos.quantity)))
        pos.status = "CLOSED"
        pos.exit_reason = "counter_signal"

    effective_capital = min(float(account.capital_per_trade), float(account.current_balance))
    if segment == "CRYPTO":
        if settings.usdinr_rate is None:
            row = _reject_manual(
                db, signal_id, symbol, segment, segment, action, instrument_type, price,
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
                db, signal_id, symbol, segment, segment, action, instrument_type, price,
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
                db, signal_id, symbol, segment, segment, action, instrument_type, price,
                f"insufficient account balance ({effective_capital} {capital_unit} available for {segment}, "
                f"need at least {price * lot_size} for 1 lot)",
            )
            db.commit()
            return row
        if stop_loss_price is not None:
            stop_distance = abs(price - stop_loss_price)
            if stop_distance <= 0:
                row = _reject_manual(
                    db, signal_id, symbol, segment, segment, action, instrument_type, price,
                    f"stop-loss price ({stop_loss_price}) equals entry price ({price}) - can't size by risk",
                )
                db.commit()
                return row
            final_quantity = compute_risk_based_quantity(
                effective_capital, float(account.risk_per_trade_pct), price, stop_loss_price, lot_size
            )
        else:
            final_quantity = compute_quantity(effective_capital, price, lot_size)

    row = db_models.Position(
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
        stop_loss_price=stop_loss_price,
        initial_stop_loss_price=stop_loss_price,
        square_off_time=account.square_off_time,
    )
    db.add(row)
    db.commit()
    return row


def update_stop_loss(db: Session, position_id: uuid.UUID, new_price: float) -> Optional[db_models.Position]:
    """Generically useful, not manual-only - editing SL on any already-open
    position. Never touches initial_stop_loss_price, an immutable audit
    column set once at open time."""
    row = db.get(db_models.Position, position_id)
    if row is None:
        return None
    row.stop_loss_price = new_price
    db.commit()
    return row


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


def square_off_all_open(db: Session, get_ltp_batch: GetLtpBatch) -> dict:
    """Closes every OPEN position at CMP. One quote fetch per distinct
    exchange among the open positions. A position whose quote fetch fails
    is left OPEN (not rejected - it's a real paper position, just not
    closeable right now) so the next scheduled run or a manual retry can
    close it."""
    open_positions = db.query(db_models.Position).filter_by(status="OPEN").all()
    quotes = _quotes_by_exchange(open_positions, get_ltp_batch)
    accounts = _accounts_by_segment(db, open_positions)
    closed = 0
    failed = 0

    for pos in open_positions:
        cmp_price = quotes.get((pos.exchange, pos.symbol))
        if cmp_price is None:
            failed += 1
            continue

        pos.exit_price = cmp_price
        pos.exit_time = datetime.now(dt_timezone.utc)
        _apply_realized_pnl(pos, accounts.get(pos.segment), compute_pnl(pos.action, float(pos.entry_price), cmp_price, float(pos.quantity)))
        pos.status = "CLOSED"
        pos.exit_reason = "square_off"
        closed += 1

    db.commit()
    return {"closed": closed, "failed": failed, "total_open": len(open_positions)}


def square_off_position(
    db: Session, position_id: uuid.UUID, get_ltp_batch: GetLtpBatch, quantity: Optional[float] = None
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
    existed."""
    pos = db.get(db_models.Position, position_id)
    if pos is None:
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

    account = load_account(db, pos.segment)
    pnl = compute_pnl(pos.action, float(pos.entry_price), cmp_price, close_quantity)

    if close_quantity == held_quantity:
        pos.exit_price = cmp_price
        pos.exit_time = datetime.now(dt_timezone.utc)
        _apply_realized_pnl(pos, account, pnl)
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
    pos.quantity = remaining_quantity
    closed_row = db_models.Position(
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
    )
    _apply_realized_pnl(closed_row, account, pnl)
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
    positions: list, get_ltp_batch: GetLtpBatch, now_local: time, accounts_by_segment: dict
) -> dict:
    """Pure logic (no DB query/commit) - closes positions in place whose
    own square_off_time has already passed the given local time. Mirrors
    _evaluate_exits' split from its DB-querying wrapper, for the same
    testability reason (plain objects like FakePosition instead of a
    real Session)."""
    due = [p for p in positions if p.square_off_time is not None and now_local >= p.square_off_time]
    if not due:
        return {"closed": 0, "failed": 0, "checked": 0}

    quotes = _quotes_by_exchange(due, get_ltp_batch)
    closed = 0
    failed = 0

    for pos in due:
        cmp_price = quotes.get((pos.exchange, pos.symbol))
        if cmp_price is None:
            failed += 1
            continue

        pos.exit_price = cmp_price
        pos.exit_time = datetime.now(dt_timezone.utc)
        _apply_realized_pnl(
            pos, accounts_by_segment.get(pos.segment), compute_pnl(pos.action, float(pos.entry_price), cmp_price, float(pos.quantity))
        )
        pos.status = "CLOSED"
        pos.exit_reason = "square_off"
        closed += 1

    return {"closed": closed, "failed": failed, "checked": len(due)}


def square_off_due_positions(db: Session, get_ltp_batch: GetLtpBatch) -> dict:
    """Closes each OPEN position once local time passes ITS OWN stored
    square_off_time - the periodic replacement for a single daily cron
    trigger, since square_off_time can now differ per position (a
    Strategy override, or whatever the platform default was at open
    time). This is what the scheduler's periodic job actually calls;
    square_off_all_open (unconditional, ignores each position's own time)
    remains for the manual 'square off everything now' trigger."""
    exec_settings = load_settings(db)
    now_local = datetime.now(dt_timezone.utc).astimezone(ZoneInfo(exec_settings.timezone)).time()
    open_positions = db.query(db_models.Position).filter_by(status="OPEN").all()
    accounts = _accounts_by_segment(db, open_positions)
    result = _evaluate_square_off_due(open_positions, get_ltp_batch, now_local, accounts)
    db.commit()
    return result


def _evaluate_exits(
    positions: list,
    get_ltp_batch: GetLtpBatch,
    get_previous_candle: GetPreviousCandle,
    accounts_by_segment: dict,
    get_candle_history: Optional[GetCandleHistory] = None,
) -> dict:
    """Pure logic (no DB query/commit) - mutates the given position
    objects in place (closing them, or trailing stop_loss_price) and
    returns a summary. Split out from check_exits so it's directly
    unit-testable with plain objects (e.g. FakePosition), the same reason
    compute_unrealized_pnl takes a plain `positions: list` instead of a
    Session.

    Only positions with a stop_loss_price or target_price set should be
    passed in - plain capital-sized positions (neither set) aren't
    monitored at all, no added overhead for them (check_exits filters
    before calling this). SL takes priority over target if both would
    fire in the same tick (gappy price).

    Trailing (only trailing_stop_enabled positions, stop-loss only, never
    the target - see docs/architecture.md) ratchets stop_loss_price using
    the same method the position was opened with, re-anchored to the
    current CMP (percent method), the latest completed candle
    (previous_candle method), or the latest indicator value (indicator
    method, via _STOP_LOSS_COMPUTE_FUNCS) - and only if the new candidate
    is MORE favorable than the stored value. It never loosens.
    get_candle_history is Optional (default None) purely so existing
    callers/tests that only ever exercise percent/previous_candle
    positions don't need updating - a position with
    stop_loss_method='indicator' but no get_candle_history supplied is
    simply skipped for trailing, same as a candle fetch failure below."""
    if not positions:
        return {"closed_stop_loss": 0, "closed_target": 0, "trailed": 0, "checked": 0}

    quotes = _quotes_by_exchange(positions, get_ltp_batch)
    closed_stop_loss = 0
    closed_target = 0
    trailed = 0
    # Dedupe candle fetches within this run - several positions may share
    # the same (exchange, symbol, interval); market-data's own
    # interval-length TTL cache further dedupes across separate runs.
    candle_cache: dict[tuple[str, str, str], Optional[dict]] = {}
    candle_history_cache: dict[tuple[str, str, str], list[dict]] = {}

    for pos in positions:
        cmp_price = quotes.get((pos.exchange, pos.symbol))
        if cmp_price is None:
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
            pos.exit_price = cmp_price
            pos.exit_time = datetime.now(dt_timezone.utc)
            _apply_realized_pnl(
                pos, accounts_by_segment.get(pos.segment), compute_pnl(pos.action, float(pos.entry_price), cmp_price, float(pos.quantity))
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
                    closes = [c["close"] for c in candle_history_cache[key]]
                    raw_candidate = compute(closes, pos.stop_loss_indicator_params or {})
                    # Same wrong-side guard as open_position's own indicator
                    # branch - a candidate that isn't on the protective side
                    # of the CURRENT price isn't a real trailing update,
                    # discard it rather than let "only tighten" wave it
                    # through against the stored stop.
                    if raw_candidate is not None and (
                        (pos.action == "BUY" and raw_candidate < cmp_price) or (pos.action == "SELL" and raw_candidate > cmp_price)
                    ):
                        candidate_stop = raw_candidate

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
    }


def check_exits(
    db: Session, get_ltp_batch: GetLtpBatch, get_previous_candle: GetPreviousCandle, get_candle_history: GetCandleHistory
) -> dict:
    """Closes OPEN positions early if CMP has hit their stop-loss or
    target, ahead of square-off - the continuous monitoring loop
    square_off_all_open alone doesn't provide. See _evaluate_exits for
    the actual logic; this just queries the DB-eligible candidates and
    commits the result."""
    candidates = (
        db.query(db_models.Position)
        .filter(db_models.Position.status == "OPEN")
        .filter((db_models.Position.stop_loss_price.isnot(None)) | (db_models.Position.target_price.isnot(None)))
        .all()
    )
    accounts = _accounts_by_segment(db, candidates)
    result = _evaluate_exits(candidates, get_ltp_batch, get_previous_candle, accounts, get_candle_history)
    db.commit()
    return result
