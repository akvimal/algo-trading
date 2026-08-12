"""Thin HTTP client to the market-data system - signal-processing never
embeds a broker SDK or credentials directly, same rule execution and
signal-generation follow for quotes/candles. Used only by option-strategy
resolution (app/domain/resolution/option_templates.py,
app/domain/resolution/strategy.py) - signal-processing had no reason to
call market-data before Phase 4b of the options trading module (see
docs/architecture.md)."""

from dataclasses import dataclass
from typing import Optional

import requests

from app.config import settings


@dataclass
class ResolvedUnderlying:
    chart_symbol: str
    chart_exchange: str
    trade_symbol: str
    trade_exchange: str
    lot_size: int


def resolve_underlying(segment: str, underlying: str) -> Optional[ResolvedUnderlying]:
    """What to reference an option chain against for a logical underlying
    (e.g. "GOLDM", "NIFTY", "RELIANCE") - chart_symbol specifically, not
    trade_symbol: an NSE index option's underlying is the index SPOT
    (chart_symbol), not the active-month future actually traded
    (trade_symbol) - see DhanProvider.resolve_underlying. For MCX
    commodities, which have no separate spot at all, chart_symbol and
    trade_symbol are already the same (the active-month futures contract
    itself) - see app/domain/resolution/strategy.py for why this needs
    calling before get_expiry_list/get_option_chain for every exchange,
    not just MCX. None if unresolvable."""
    resp = requests.get(
        f"{settings.market_data_base_url}/instruments/resolve",
        params={"segment": segment, "underlying": underlying},
        timeout=settings.market_data_timeout_seconds,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    data = resp.json()
    return ResolvedUnderlying(
        chart_symbol=data["chart_symbol"],
        chart_exchange=data["chart_exchange"],
        trade_symbol=data["trade_symbol"],
        trade_exchange=data["trade_exchange"],
        lot_size=data["lot_size"],
    )


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
