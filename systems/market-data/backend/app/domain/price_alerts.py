"""Standalone price alerts - the crossing test + the scheduler dispatch.

A user adds a level + direction on any symbol (POST /price-alerts). app/scheduler.py's _check_price_alerts runs `dispatch_due`
every minute: it groups the active alerts by exchange, batch-fetches the LTP, and for each alert that just *crossed* its level
(not merely "is currently past" it - `last_side` remembers which side we saw last) sends a Telegram message to the alert owner's
own chat, then deactivates it (one-shot) or re-arms it (`repeat=true`).

DELIVERY IS PART OF FIRING. An alert whose message could not be sent (no chat set, Telegram down, the chat rejected the bot)
has NOT fired as far as the user is concerned: it stays armed, its remembered side is left where it was so the crossing is
seen again on the next pass, and the failure is counted and shown. Only a delivered message uses up a one-shot alert. After
MAX_DELIVERY_FAILURES failures in a row it is switched off, with the reason kept, rather than retrying forever.

Independent of the Live Chart's browser-only drawing-line alerts."""

import logging
import threading
from datetime import datetime, timezone
from typing import Callable, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.adapters.db.models import AlertChannel, PriceAlert
from app.config import settings
from app.domain.notify import send_telegram
from app.providers.router import get_provider

logger = logging.getLogger(__name__)

# symbol -> ltp, per exchange
BatchQuote = Callable[[str, list[str]], dict[str, float]]

EXCHANGES = ("NSE", "MCX", "CRYPTO")
MAX_DELIVERY_FAILURES = 10
MAX_ACTIVE_ALERTS_PER_USER = 50

# One evaluation pass at a time: the scheduler and the admin "check now" button must not both read the same alert as armed and
# both send its message before either saves.
_dispatch_lock = threading.Lock()


def _side(ltp: float, target: float) -> str:
    return "above" if ltp >= target else "below"


def alert_fires(direction: str, target: float, ltp: float, last_side: Optional[str]) -> bool:
    """Has this alert's condition just been met? A directional alert fires the first time the LTP reaches that side; a `cross`
    alert fires on any side change. `last_side is None` (never checked) never fires - it only seeds the memory, so an alert
    added while price is already past its level doesn't fire immediately."""
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


def load_channels(db: Session) -> dict[UUID, str]:
    """user_id -> that user's Telegram chat id."""
    return {c.user_id: c.telegram_chat_id for c in db.query(AlertChannel).all()}


def chat_for(user_id: Optional[UUID], channels: dict[UUID, str]) -> Optional[str]:
    """Where an alert's message goes: its owner's own chat. Only an alert with NO owner (created before alerts were tied to an
    account) falls back to the platform chat; a user who has not set a chat gets nothing, rather than their alerts landing in the
    operator's chat."""
    if user_id is None:
        return settings.telegram_chat_id or None
    return channels.get(user_id)


def current_ltp(exchange: str, symbol: str, batch_quote: BatchQuote = _default_batch_quote) -> Optional[float]:
    """The price now, or None when the symbol is unknown to the provider (or it could not be fetched)."""
    px = batch_quote(exchange, [symbol]).get(symbol)
    return float(px) if isinstance(px, (int, float)) else None


def dispatch_due(db: Session, batch_quote: BatchQuote = _default_batch_quote, channels_loader: Callable[[Session], dict] = load_channels) -> int:
    """Check every active alert against a fresh LTP, fire the ones that crossed, and persist the outcome. Returns how many were
    DELIVERED."""
    with _dispatch_lock:
        return _dispatch_due(db, batch_quote, channels_loader)


def _dispatch_due(db: Session, batch_quote: BatchQuote, channels_loader: Callable[[Session], dict]) -> int:
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
    channels = channels_loader(db)

    delivered = 0
    for a in alerts:
        ltp = quotes.get((a.exchange, a.symbol))
        if ltp is None:
            continue
        if alert_fires(a.direction, float(a.target_price), ltp, a.last_side):
            chat = chat_for(a.user_id, channels)
            error = send_telegram(_message(a, ltp), chat) if chat else "no Telegram chat set for this account"
            if error:
                a.delivery_failures = (a.delivery_failures or 0) + 1
                a.last_error = error
                if a.delivery_failures >= MAX_DELIVERY_FAILURES:
                    a.active = False
                    a.last_error = f"switched off after {a.delivery_failures} failed sends: {error}"
                logger.warning("price alert %s crossed at %s but was not delivered (%s) - %s", a.id, ltp, error, "switched off" if not a.active else "will retry")
                continue  # leave last_side alone, so the same crossing is seen again next pass
            a.last_triggered_at = datetime.now(timezone.utc)
            a.trigger_count = (a.trigger_count or 0) + 1
            a.delivery_failures = 0
            a.last_error = None
            if not a.repeat:
                a.active = False
            logger.info("price alert %s fired for %s:%s at %s", a.id, a.exchange, a.symbol, ltp)
            delivered += 1
        a.last_side = _side(ltp, float(a.target_price))

    db.commit()
    return delivered
