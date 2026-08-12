"""Thin HTTP client to the market-data system - signal-processing never
embeds a broker SDK or credentials directly, same rule execution and
signal-generation follow for quotes/candles. Used only by option-strategy
resolution (app/domain/resolution/option_templates.py,
app/domain/resolution/strategy.py) - signal-processing had no reason to
call market-data before Phase 4b of the options trading module (see
docs/architecture.md)."""

from typing import Optional

import requests

from app.config import settings


def get_expiry_list(exchange: str, symbol: str) -> Optional[list[str]]:
    """Active option expiry dates (YYYY-MM-DD) for `symbol` on `exchange`
    - None if unresolvable (unknown underlying, or market-data has no
    option-chain support for this exchange)."""
    resp = requests.get(
        f"{settings.market_data_base_url}/options/expiries",
        params={"exchange": exchange, "symbol": symbol},
        timeout=settings.market_data_timeout_seconds,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()["expiries"]


def get_option_chain(exchange: str, symbol: str, expiry: str) -> Optional[dict]:
    """Full option chain for `symbol` at `expiry` - the raw JSON shape
    market-data's GET /options/chain returns (see its OptionChain model),
    not re-modeled here since app/domain/resolution/option_templates.py
    only ever reads a few fields off it. None if unresolvable."""
    resp = requests.get(
        f"{settings.market_data_base_url}/options/chain",
        params={"exchange": exchange, "symbol": symbol, "expiry": expiry},
        timeout=settings.market_data_timeout_seconds,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()
