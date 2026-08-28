"""Chartink alert parsing - replaces the n8n chartink-{buy,sell}-intake
workflows' "Normalize + fan-out" Code node (see docs/architecture.md).
A single Chartink alert carries comma-separated stocks/trigger_prices for
potentially many symbols in one call; this splits that into per-symbol
(symbol, price) pairs for the caller (app/api/routes/webhooks.py) to turn
into individual SignalIngest objects - action/exchange aren't parsed here
since they're fixed by which webhook path fired (BUY/SELL) and this
repo's own Chartink scans being NSE-only, not something in the payload."""

from typing import Optional


def parse_chartink_alert(body: dict) -> list[tuple[str, Optional[float]]]:
    """(symbol, price) pairs from Chartink's comma-separated stocks/
    trigger_prices - price is None for a symbol whose price is missing or
    unparseable at that index (the caller skips it rather than opening a
    position with a fabricated price). Blank/whitespace-only symbols are
    dropped entirely, matching the JS Code node's own `.filter(Boolean)`."""
    symbols = [s.strip() for s in str(body.get("stocks", "")).split(",") if s.strip()]
    raw_prices = str(body.get("trigger_prices", "")).split(",")

    pairs: list[tuple[str, Optional[float]]] = []
    for i, symbol in enumerate(symbols):
        price: Optional[float] = None
        if i < len(raw_prices):
            try:
                price = float(raw_prices[i].strip())
            except ValueError:
                price = None
        pairs.append((symbol, price))
    return pairs
