from typing import Optional

from pydantic import BaseModel


class Quote(BaseModel):
    exchange: str
    symbol: str
    ltp: float
    provider: str


class BatchQuoteRequest(BaseModel):
    exchange: str
    symbols: list[str]


class BatchQuoteResponse(BaseModel):
    exchange: str
    provider: str
    prices: dict[str, float]  # symbol -> ltp; missing symbols were unresolvable/unavailable


class ProviderStatus(BaseModel):
    provider: str
    symbol_count: int
    last_synced_at: Optional[str] = None


class Candle(BaseModel):
    """One *completed* intraday candle for a symbol at a given interval.
    See app/providers/dhan.py get_previous_candle (single most recent)
    and get_candle_history (a caller-supplied range) for the two ways
    these get produced."""

    exchange: str
    symbol: str
    interval: str
    open: float
    high: float
    low: float
    close: float
    timestamp: str  # ISO-8601, the candle's start time
    provider: str


class ResolvedUnderlying(BaseModel):
    """What GET /instruments/resolve returns for a logical underlying
    (e.g. "GOLDM", "NIFTY") - see DhanProvider.resolve_underlying.
    chart_symbol/chart_exchange: what to fetch candles for and compute
    indicators on. trade_symbol/trade_exchange: what an actual signal
    should be opened on - equal to the chart fields for instruments with
    no continuous spot (commodity futures), different for ones with both
    a spot and a tradeable derivative (indices)."""

    chart_symbol: str
    chart_exchange: str
    trade_symbol: str
    trade_exchange: str
    lot_size: int
    expiry: Optional[str] = None  # ISO date - the trade contract's expiry
