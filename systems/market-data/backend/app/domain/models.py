from typing import Literal, Optional

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


class FeedSubscribeRequest(BaseModel):
    """POST /dhan/feed/subscribe body - see app/providers/dhan_feed.py."""

    exchange: str
    symbol: str


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


class OptionGreeks(BaseModel):
    """Dhan's option-chain response doesn't include rho - only these four."""

    delta: float
    theta: float
    gamma: float
    vega: float


class OptionLegQuote(BaseModel):
    """One CE or PE leg at one strike - see DhanProvider.get_option_chain.
    Trimmed from Dhan's raw response to what strike/strategy selection
    (Phase 4b, not built yet - see docs/architecture.md) will actually
    need; average_price/previous_close_price/previous_volume/bid-ask
    *quantity* are dropped, easy to add back if a later phase needs them."""

    security_id: str
    last_price: float
    oi: int
    previous_oi: int
    volume: int
    implied_volatility: float
    top_bid_price: float
    top_ask_price: float
    greeks: OptionGreeks
    # Computed by app/domain/moneyness.py at fetch time - not something
    # Dhan's response itself carries.
    moneyness: Literal["ITM", "ATM", "OTM"]


class OptionChainStrike(BaseModel):
    strike: float
    ce: Optional[OptionLegQuote] = None
    pe: Optional[OptionLegQuote] = None


class OptionChain(BaseModel):
    """GET /options/chain - see DhanProvider.get_option_chain."""

    underlying_symbol: str
    underlying_exchange: str
    expiry: str
    underlying_last_price: float
    strikes: list[OptionChainStrike]  # sorted ascending by strike


class OptionLegCandle(BaseModel):
    """GET /options/leg-history - one completed bar of a single option
    leg's historical premium, tracked *relative to spot* (e.g. always the
    ATM strike, or always 2 strikes OTM) rather than a fixed strike price -
    see DhanProvider.get_option_leg_history. Phase 4c (backtesting) only;
    unrelated to OptionChainStrike/OptionLegQuote above (Phase 4a's live
    chain snapshot, keyed by an actual strike price, not a rolling
    strike-offset label)."""

    symbol: str
    option_type: str  # "CE" | "PE"
    strike: str  # e.g. "ATM", "ATM+2", "ATM-2" - Dhan resolves the real strike server-side per bar
    expiry_flag: str  # "WEEK" | "MONTH"
    expiry_code: int
    interval: str
    timestamp: str  # ISO-8601, the bar's start time
    open: float
    high: float
    low: float
    close: float


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
