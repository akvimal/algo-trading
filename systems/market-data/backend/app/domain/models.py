from typing import Literal, Optional

from pydantic import BaseModel, Field


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


class DhanCredentialsUpdate(BaseModel):
    """PUT /dhan/credentials body - the UI's 'Data provider keys' form, see
    app/providers/dhan.py's set_manual_credentials."""

    client_id: str = Field(min_length=1)
    access_token: str = Field(min_length=1)


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


class DataAvailability(BaseModel):
    """Backs GET /candles/history's sibling GET /candles/availability -
    what the signal-generation backtest form shows so a user doesn't pick
    a date range that's guaranteed to fail or silently return partial
    data. The two providers have genuinely different constraints, so only
    one of the two optional fields is ever populated for a given exchange:

    - Dhan (NSE/MCX): a fixed, documented per-request cap
      (`max_days_per_request`) - real history goes back years, but a
      single charts/intraday call 400s past 90 days (DH-905), and this
      codebase doesn't chunk around it for spot/future the way
      option_backtest.py does for options. `earliest_available_date`
      stays None - not worth a live probe for a constant.
    - Delta Exchange India (CRYPTO): no per-request day cap, but real
      history is much shallower and grows day by day - `earliest_available_date`
      is live-probed and cached (see DeltaProvider.get_data_availability).
      `max_days_per_request` stays None."""

    exchange: str
    symbol: str
    interval: str
    max_days_per_request: Optional[int] = None
    earliest_available_date: Optional[str] = None  # ISO date "YYYY-MM-DD"
    note: str


class CandleCacheStatus(BaseModel):
    """Backs GET /candles/cache-status - whether GET /candles/history's own
    in-memory cache (app/api/routes/candles.py's _history_cache) currently
    holds an entry for one exact (exchange, symbol, interval, from, to)
    tuple, and when it was fetched. `fetched_at` is None whenever `cached`
    is False (nothing to report) - never a stale leftover value."""

    cached: bool
    fetched_at: Optional[str] = None  # ISO 8601 UTC timestamp


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


class OptionOiLeg(BaseModel):
    """One CE or PE leg's OI-analysis figures at one strike, for GET
    /options/oi-summary - a lighter, analysis-focused sibling of
    OptionLegQuote above (Phase 4b's leg-selection chain) rather than a
    mutation of it, so this feature can evolve independently of what
    execution/signal-processing's own option_templates.py mirrors already
    depend on. oi_change_5m/15m are None until DhanProvider's in-memory OI
    history buffer (see its own comment) has a sample old enough to diff
    against - typically the first ~5/15 minutes after this backend last
    restarted, or for a strike nobody has fetched before."""

    oi: int
    oi_change_5m: Optional[int] = None
    oi_change_15m: Optional[int] = None
    implied_volatility: float
    last_price: float
    volume: float
    top_bid_price: float
    top_ask_price: float
    moneyness: Literal["ITM", "ATM", "OTM"]
    # Premium change over the same 15m window oi_change_15m uses - None
    # under the same "no old-enough sample yet" condition. Paired with
    # oi_change_15m to derive `buildup` below; not shown as its own
    # column, just the input to that classification.
    price_change_15m: Optional[float] = None
    # Classic OI-vs-price buildup read (price up/down x OI up/down) -
    # None whenever either input change is None or exactly zero (nothing
    # to classify yet, or between two flat samples). See
    # app/domain/oi_summary.py's _classify_buildup for the mapping.
    buildup: Optional[Literal["long_buildup", "short_buildup", "short_covering", "long_unwinding"]] = None


class OptionOiSummaryStrike(BaseModel):
    strike: float
    call: Optional[OptionOiLeg] = None
    put: Optional[OptionOiLeg] = None


class OptionOiSummary(BaseModel):
    """GET /options/oi-summary - PCR + aggregate OI-change + per-strike
    breakdown for one (exchange, symbol, expiry), built (app/domain/
    oi_summary.py's build_oi_summary) from the same DhanProvider.
    get_option_chain fetch GET /options/chain uses, plus its in-memory OI
    history buffer. signal-generation's OI Summary page is the only
    consumer - not used anywhere in the resolve/order-placement path."""

    underlying_symbol: str
    underlying_exchange: str
    expiry: str
    underlying_last_price: float
    total_call_oi: int
    total_put_oi: int
    # total_put_oi / total_call_oi - the standard OI-based Put/Call
    # Ratio. None only if total_call_oi is 0 (division undefined).
    pcr: Optional[float] = None
    # Summed leg-level changes across the whole chain - None (not 0) if
    # NOT EVERY leg in the sum has a change figure yet, so a partially
    # warmed-up buffer doesn't silently understate the true total.
    total_call_oi_change_5m: Optional[int] = None
    total_put_oi_change_5m: Optional[int] = None
    total_call_oi_change_15m: Optional[int] = None
    total_put_oi_change_15m: Optional[int] = None
    atm_call_iv: Optional[float] = None
    atm_put_iv: Optional[float] = None
    strikes: list[OptionOiSummaryStrike]  # sorted ascending by strike


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
