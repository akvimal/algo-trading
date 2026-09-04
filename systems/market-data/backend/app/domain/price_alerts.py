"""Standalone price alerts - the crossing test + the scheduler dispatch.

A user adds a level + direction on any symbol (POST /price-alerts).
app/scheduler.py's _check_price_alerts runs `dispatch_due` every minute:
it groups the active alerts by exchange, batch-fetches the LTP, and for
each alert that just *crossed* its level (not merely "is currently past"
it - `last_side` remembers which side we saw last) sends a Telegram
message, then deactivates it (one-shot) or re-arms it (`repeat=true`).

Independent of the Live Chart's browser-only drawing-line alerts."""

import logging
from datetime import datetime, timezone
from typing import Callable, Optional

from sqlalchemy.orm import Session

from app.adapters.db.models import PriceAlert
from app.domain.notify import notify_telegram
from app.providers.router import get_provider

logger = logging.getLogger(__name__)

# symbol -> ltp, per exchange
BatchQuote = Callable[[str, list[str]], dict[str, float]]


def _side(ltp: float, target: float) -> str:
    return "above" if ltp >= target else "below"


def alert_fires(direction: str, target: float, ltp: float, last_side: Optional[str]) -> bool:
    """Has this alert's condition just been met? A directional alert fires
    the first time the LTP reaches that side; a `cross` alert fires on any
    side change. `last_side is None` (never checked) never fires - it only
    seeds the memory, so an alert added while price is already past its
    level doesn't fire immediately."""
    now_side = _side(ltp, target)
    if last_side is None:
        return False
    if now_side == last_side:
        return False
    if direction == "cross":
        return True
    return now_side == direction


def _message(a: PriceAlert, ltp: float) -> str:
    arrow = "▲" if _side(ltp, float(a.target_price)) == "above" else "▼"
    body = f"{arrow} {a.exchange}:{a.symbol} crossed {a.target_price:g} (now {ltp:g})"
    if a.note:
        body += f"\n{a.note}"
    return body


def _default_batch_quote(exchange: str, symbols: list[str]) -> dict[str, float]:
    try:
        return get_provider(exchange).get_ltp_batch(symbols, credentials=None)
    except Exception:
        logger.warning("price-alert LTP fetch failed for %s %s", exchange, symbols, exc_info=True)
        return {}


def dispatch_due(db: Session, batch_quote: BatchQuote = _default_batch_quote) -> int:
    """Check every active alert against a fresh LTP, fire the ones that
    crossed, and persist the outcome. Returns how many fired."""
    alerts = db.query(PriceAlert).filter(PriceAlert.active.is_(True)).all()
    if not alerts:
        return 0

    by_exchange: dict[str, set[str]] = {}
    for a in alerts:
        by_exchange.setdefault(a.exchange, set()).add(a.symbol)
    quotes: dict[tuple[str, str], float] = {}
    for exchange, symbols in by_exchange.items():
        for sym, px in batch_quote(exchange, sorted(symbols)).items():
            if isinstance(px, (int, float)):
                quotes[(exchange, sym)] = float(px)

    fired = 0
    for a in alerts:
        ltp = quotes.get((a.exchange, a.symbol))
        if ltp is None:
            continue
        if alert_fires(a.direction, float(a.target_price), ltp, a.last_side):
            sent = notify_telegram(_message(a, ltp))
            a.last_triggered_at = datetime.now(timezone.utc)
            a.trigger_count = (a.trigger_count or 0) + 1
            if not a.repeat:
                a.active = False
            logger.info("price alert %s fired for %s:%s at %s (telegram sent=%s)", a.id, a.exchange, a.symbol, ltp, sent)
            fired += 1
        a.last_side = _side(ltp, float(a.target_price))

    db.commit()
    return fired
