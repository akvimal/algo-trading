"""Position lifecycle: open on signal, close at square-off.

The pure decision functions (compute_pnl, compute_quantity, is_supported,
is_within_intraday_window) are kept free of DB/session state so they're
directly unit-testable; open_position/square_off_all_open wire them to
persistence.
"""

import logging
import uuid
from datetime import datetime, time
from datetime import timezone as dt_timezone
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.domain.models import ExecutionSettings, ResolvedOrder

logger = logging.getLogger(__name__)

GetLtpBatch = Callable[[str, list[str]], dict[str, float]]  # (exchange, symbols) -> {symbol: price}
GetPreviousCandle = Callable[[str, str, str], Optional[dict]]  # (exchange, symbol, interval) -> candle dict or None
GetLotSize = Callable[[str, str], Optional[int]]  # (exchange, symbol) -> lot size, or None if unknown


def compute_pnl(action: str, entry_price: float, exit_price: float, quantity: float) -> float:
    if action == "BUY":
        return (exit_price - entry_price) * quantity
    return (entry_price - exit_price) * quantity  # SELL = intraday short


def compute_quantity(capital_per_trade: float, price: float, lot_size: int = 1) -> int:
    """Whole LOTS, returned as total units (lots * lot_size) - lot_size=1
    for instruments with no lot concept (NSE cash equity, and MCX
    commodity futures - Dhan's own lot-size convention there is already
    1) and a real multiplier for others (e.g. NIFTY futures=65,
    BANKNIFTY futures=30). Floors to a minimum of 1 lot even if
    capital_per_trade can't strictly afford it - a position always opens
    rather than being rejected for undersized capital. See
    docs/architecture.md."""
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


def compute_risk_based_quantity(
    capital_per_trade: float, risk_per_trade_pct: float, entry_price: float, stop_loss_price: float, lot_size: int = 1
) -> int:
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
    capital_capped_lots = compute_quantity(capital_per_trade, entry_price, lot_size) // lot_size
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


def is_within_intraday_window(now: datetime, square_off_time: time, tz_name: str) -> bool:
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


def open_position(
    order: ResolvedOrder,
    settings: ExecutionSettings,
    db: Session,
    get_previous_candle: GetPreviousCandle,
    get_lot_size: GetLotSize,
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

    if order.square_off_time is None:
        # Shouldn't happen - signal-generation requires square_off_time
        # for horizon='intraday' (the only horizon that reaches here,
        # given is_supported() above). Defends against a malformed
        # message rather than crashing on None comparisons below.
        row = _reject(db, order, signal_id, "intraday spot order is missing square_off_time (contract violation)")
        db.commit()
        return row

    now = datetime.now(dt_timezone.utc)
    if not is_within_intraday_window(now, order.square_off_time, settings.timezone):
        row = _reject(
            db, order, signal_id, f"received outside intraday window (square-off is {order.square_off_time})"
        )
        db.commit()
        return row

    account = load_account(db, order.segment)
    if account is None:
        row = _reject(db, order, signal_id, f"no paper-trading account configured for segment {order.segment}")
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
    if effective_capital < order.price:
        row = _reject(
            db,
            order,
            signal_id,
            f"insufficient account balance ({account.current_balance} left in {order.segment} account, "
            f"need at least {order.price} for 1 share)",
        )
        db.commit()
        return row

    # Only futures carry a lot concept - spot (NSE cash equity) keeps
    # lot_size=1 with no extra network call, so that path's latency is
    # unchanged from before this lookup existed.
    lot_size = 1
    if order.instrument_type == "future":
        resolved_lot_size = get_lot_size(order.exchange, order.symbol)
        if resolved_lot_size is None:
            row = _reject(db, order, signal_id, f"could not determine lot size for {order.symbol} on {order.exchange}")
            db.commit()
            return row
        lot_size = resolved_lot_size

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
        square_off_time=order.square_off_time,
    )
    db.add(row)
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


def square_off_position(db: Session, position_id: uuid.UUID, get_ltp_batch: GetLtpBatch) -> dict:
    """Closes exactly one OPEN position by id - the per-row 'Square off'
    button in the frontend's Positions grid, as opposed to
    square_off_all_open (every open position) or square_off_due_positions
    (only those past their own square_off_time). exit_reason='manual'
    distinguishes this from the other two closing paths."""
    pos = db.get(db_models.Position, position_id)
    if pos is None:
        return {"status": "not_found"}
    if pos.status != "OPEN":
        return {"status": "not_open", "position_status": pos.status}

    quotes = get_ltp_batch(pos.exchange, [pos.symbol])
    cmp_price = quotes.get(pos.symbol)
    if cmp_price is None:
        return {"status": "quote_unavailable"}

    pos.exit_price = cmp_price
    pos.exit_time = datetime.now(dt_timezone.utc)
    account = load_account(db, pos.segment)
    _apply_realized_pnl(pos, account, compute_pnl(pos.action, float(pos.entry_price), cmp_price, float(pos.quantity)))
    pos.status = "CLOSED"
    pos.exit_reason = "manual"
    db.commit()
    return {
        "status": "closed",
        "position_id": str(pos.id),
        "symbol": pos.symbol,
        "exit_price": cmp_price,
        "pnl": float(pos.pnl),
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
    positions: list, get_ltp_batch: GetLtpBatch, get_previous_candle: GetPreviousCandle, accounts_by_segment: dict
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
    current CMP (percent method) or the latest completed candle
    (previous_candle method) - and only if the new candidate is MORE
    favorable than the stored value. It never loosens."""
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


def check_exits(db: Session, get_ltp_batch: GetLtpBatch, get_previous_candle: GetPreviousCandle) -> dict:
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
    result = _evaluate_exits(candidates, get_ltp_batch, get_previous_candle, accounts)
    db.commit()
    return result
