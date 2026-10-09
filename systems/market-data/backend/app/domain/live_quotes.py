"""Live prices for callers that cannot wait for the rate-limited REST quote (the exit monitor: a stop-loss should fire on the price now, not on one
that was fetched when Dhan's LTP endpoint, shared by everything on the account at about one call per two seconds, got round to it).

`POST /quotes/ltp/batch` with `"live": true` asks for the feed's own ticks: each requested symbol is subscribed on the Dhan live feed (idempotent, and
re-asserted by the caller on every poll, so it heals after a restart) and, once a tick under LIVE_MAX_AGE_SECONDS old is held, that price is used
without any outbound call. A symbol with no fresh tick yet (just subscribed, feed down, an unknown symbol) falls back to the normal REST quote, so asking
for live is never worse than not asking. Only for the platform credential and for Dhan-backed exchanges: a person's own keys keep their own REST budget,
and a provider with no live feed (crypto) has nothing to subscribe to."""

from __future__ import annotations

import logging

from app.providers import dhan_feed
from app.providers.router import get_provider

logger = logging.getLogger(__name__)

# A tick arrives whenever the price moves, but a quiet instrument can go several seconds without one; past this the REST quote is asked instead.
LIVE_MAX_AGE_SECONDS = 4.0


def split_live(exchange: str, symbols: list[str]) -> tuple[dict[str, float], list[str]]:
    """(prices the feed holds fresh, the symbols still to fetch the ordinary way)."""
    provider = get_provider(exchange)
    if getattr(provider, "resolve_feed_target", None) is None:
        return {}, list(symbols)
    dhan_feed.start_feed()  # idempotent; a no-op without Dhan credentials
    fresh: dict[str, float] = {}
    for symbol in symbols:
        try:
            if not dhan_feed.is_subscribed(exchange, symbol):
                dhan_feed.subscribe(exchange, symbol)
            price = dhan_feed.fresh_price(exchange, symbol, LIVE_MAX_AGE_SECONDS)
        except Exception:
            logger.exception("live quote: could not use the feed for %s:%s", exchange, symbol)
            continue
        if price is not None:
            fresh[symbol] = price
    return fresh, [s for s in symbols if s not in fresh]
