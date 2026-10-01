"""Discipline v2, step 1 (docs/discipline-v2-spec.md): the rules about moving a stop-loss or target once an order is live,
and the log that records every attempt.

- A live stop can only move TOWARD price (tighten). Widening or removing it is refused (`STOP_WIDEN_MESSAGE`), and the
  refused attempt is logged - it is itself a greed signal.
- Every stop/target move, accepted or refused, is one `position_events` row, so a later score can tell a planned trail from
  an emotional one, and a target pulled in or pushed out.
- A "tight trail" is a stop tightened to within N x ATR of price, except moving to breakeven once price is +1R.

Pure functions plus two small helpers that touch the DB / market-data. Nothing here decides a score."""

import logging
from datetime import date, timedelta
from typing import Callable, Optional

from sqlalchemy.orm import Session

from app.adapters.db import models as db_models
from app.config import settings

logger = logging.getLogger(__name__)

DEFAULT_ATR_INTERVAL = "15min"
STOP_WIDEN_MESSAGE = "The stop can only move toward price once the order is live."

# What a stop/target edit's ATR and price come from: (price now, ATR) - either can be None when market-data could not
# be reached, in which case the move is logged without a tight-trail judgement.
MoveContext = tuple[Optional[float], Optional[float]]
NO_CONTEXT: MoveContext = (None, None)

_TOL = 1e-9


class StopWidenRefused(ValueError):
    """A live stop may not move away from price. The refused attempt is already logged (and committed) when this is raised."""

    def __init__(self) -> None:
        super().__init__(STOP_WIDEN_MESSAGE)


def classify_stop_move(direction: str, old: Optional[float], new: Optional[float]) -> str:
    """'set' (no stop before), 'tighten' (toward price), 'widen' (away from price), 'clear' (removed) or 'same'.
    `direction` is the side of the trade: for a BUY the stop sits below and higher is tighter; for a SELL, the reverse."""
    if new is None:
        return "same" if old is None else "clear"
    if old is None:
        return "set"
    if abs(new - old) <= _TOL:
        return "same"
    tighter = new > old if direction == "BUY" else new < old
    return "tighten" if tighter else "widen"


def is_widening(move: str) -> bool:
    return move in ("widen", "clear")


def classify_target_move(direction: str, old: Optional[float], new: Optional[float]) -> str:
    """'set', 'closer' (a smaller reward), 'further' (a bigger one), 'clear' or 'same'."""
    if new is None:
        return "same" if old is None else "clear"
    if old is None:
        return "set"
    if abs(new - old) <= _TOL:
        return "same"
    closer = new < old if direction == "BUY" else new > old
    return "closer" if closer else "further"


def is_breakeven_move(
    direction: str, entry: float, initial_stop: Optional[float], new_stop: float, price: float
) -> bool:
    """The stop moved to (about) the entry, and price is at least one initial risk in profit. Always allowed, never a
    tight trail. Without a recorded initial stop the +1R test cannot be made, so any profit counts."""
    if abs(new_stop - entry) > max(_TOL, abs(entry) * 0.0005):
        return False
    profit = (price - entry) if direction == "BUY" else (entry - price)
    if initial_stop is None:
        return profit > 0
    risk = abs(entry - initial_stop)
    return risk > 0 and profit >= risk


def judge_tight_trail(
    direction: str,
    move: str,
    entry: float,
    initial_stop: Optional[float],
    new_stop: Optional[float],
    price: Optional[float],
    atr: Optional[float],
    multiple: Optional[float] = None,
) -> Optional[bool]:
    """True when a TIGHTENED stop is within `multiple` x ATR of price (and is not the breakeven move); False when it is not;
    None when it cannot be judged (not a tighten, or no price/ATR)."""
    if move != "tighten" or new_stop is None or price is None or atr is None or atr <= 0:
        return None
    if is_breakeven_move(direction, entry, initial_stop, new_stop, price):
        return False
    m = settings.tight_trail_atr_multiple if multiple is None else multiple
    return abs(price - new_stop) < m * atr


def fetch_context(
    get_ltp_batch: Callable,
    get_candle_history: Callable,
    exchange: str,
    symbol: str,
    interval: str,
    token: Optional[str] = None,
) -> MoveContext:
    """Price now and ATR at `interval`, best effort: any failure gives None for that half, never raises (a stop edit must
    not fail because market-data is slow)."""
    from app.domain.position_manager import compute_atr  # lazy: position_manager imports this module

    price: Optional[float] = None
    atr: Optional[float] = None
    try:
        quote = get_ltp_batch(exchange, [symbol], token=token) if token is not None else get_ltp_batch(exchange, [symbol])
        value = quote.get(symbol)
        price = float(value) if value is not None else None
    except Exception:
        logger.warning("stop move: no price for %s:%s", exchange, symbol, exc_info=True)
    try:
        today = date.today()
        candles = get_candle_history(exchange, symbol, interval, today - timedelta(days=7), today)
        series = compute_atr(candles, settings.tight_trail_atr_period) if candles else []
        last = next((v for v in reversed(series) if v is not None), None)
        atr = float(last) if last is not None else None
    except Exception:
        logger.warning("stop move: no ATR for %s:%s %s", exchange, symbol, interval, exc_info=True)
    return price, atr


def record_event(
    db: Session,
    *,
    user_id,
    field: str,
    move: str,
    old_price: Optional[float],
    new_price: Optional[float],
    source: str = "user",
    position_id=None,
    option_group_id=None,
    accepted: bool = True,
    refused_reason: Optional[str] = None,
    context: MoveContext = NO_CONTEXT,
    atr_interval: Optional[str] = None,
    tight_trail: Optional[bool] = None,
) -> db_models.PositionEvent:
    """Adds the row to the session. The caller commits it with the change it describes - or, for a refused attempt,
    commits just this row."""
    price, atr = context
    event = db_models.PositionEvent(
        user_id=user_id,
        position_id=position_id,
        option_group_id=option_group_id,
        field=field,
        move=move,
        old_price=old_price,
        new_price=new_price,
        source=source,
        accepted=accepted,
        refused_reason=refused_reason,
        price_at_event=price,
        atr=atr,
        atr_interval=atr_interval if atr is not None else None,
        tight_trail=tight_trail,
    )
    db.add(event)
    return event
