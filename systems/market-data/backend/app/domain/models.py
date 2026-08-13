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
    """Dhan's option-chain response doesn't include rho - only the first
    four. Delta Exchange's does (Phase 2 of the crypto module, see
    docs/architecture.md) - rho stays unset (None) for Dhan-sourced legs."""

    delta: float
    theta: float
    gamma: float
    vega: float
    rho: Optional[float] = None


class OptionLegQuote(BaseModel):
    """One CE or PE leg at one strike - see DhanProvider.get_option_chain
    and DeltaProvider.get_option_chain (Phase 2 of the crypto module).
    Trimmed from Dhan's raw response to what strike/strategy selection
    (Phase 4b) actually needs; average_price/previous_close_price/
    previous_volume/bid-ask *quantity* are dropped, easy to add back if a
    later phase needs them. previous_oi is Optional (Dhan always sends
    it; Delta's ticker response has no previous-OI figure at all, only a
    dollar-denominated 6h change, not a contract-count delta) and volume
    is float (Dhan's is a whole share/contract count; Delta's is
    asset-denominated, e.g. 0.04 BTC) - both widenings, backward
    compatible with Dhan's existing construction."""

    security_id: str
    last_price: float
    oi: int
    previous_oi: Optional[int] = None
    volume: float
    implied_volatility: float
    top_bid_price: float
    top_ask_price: float
    greeks: OptionGreeks
    # Computed by app/domain/moneyness.py at fetch time - not something
    # either provider's response itself carries.
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
    lot_size: float  # int for NSE/MCX F&O; a real fraction for Delta CRYPTO perpetuals (e.g. BTCUSD=0.001)
    expiry: Optional[str] = None  # ISO date - the trade contract's expiry
