from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


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
    # Total traded quantity within this bar - Dhan's charts/intraday response
    # already includes it, just wasn't being extracted before signal-generation's
    # multi-condition rules (app/domain/multi_condition.py there) needed a
    # volume-vs-its-own-SMA condition type. Summed across the 1min bars an
    # aggregated (non-native) interval buckets together - see
    # providers/dhan.py's _aggregate_candles.
    volume: float
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


SentimentDirection = Literal["bullish", "bearish", "neutral"]
SentimentStrength = Literal["mild", "strong", "very_strong"]


class UnderlyingSentiment(BaseModel):
    """One watchlist underlying's OI-based directional read - see
    app/domain/sentiment.py. score_5m/15m are a percent-of-total-OI put-
    minus-call OI shift; None (with `error` set) if this underlying's
    option chain couldn't be fetched this round (e.g. a Dhan 401/429) -
    GET /options/sentiment degrades that one underlying rather than
    failing the whole response."""

    symbol: str
    score_5m: Optional[float] = None
    score_15m: Optional[float] = None
    direction: SentimentDirection
    strength: Optional[SentimentStrength] = None
    # The ATM strike's own call/put buildup classification (see
    # app/domain/sentiment.py's _atm_buildups) - that leg's own OI change
    # vs its own PREMIUM change, the same per-leg read OptionOiLeg.buildup
    # already carries on the OI-by-strike table. Deliberately two separate
    # values, not merged into one label - a rising call OI and a rising
    # put OI mean different things, same reason score_5m/15m itself is a
    # put-minus-call SKEW rather than a summed figure.
    atm_call_buildup: Optional[Literal["long_buildup", "short_buildup", "short_covering", "long_unwinding"]] = None
    atm_put_buildup: Optional[Literal["long_buildup", "short_buildup", "short_covering", "long_unwinding"]] = None
    error: Optional[str] = None


class ExchangeSentiment(BaseModel):
    """NSE or MCX's combined sentiment - the mean of its watchlist
    underlyings' scores (see app/domain/sentiment.py's SENTIMENT_UNDERLYINGS),
    not a literal scan of the whole exchange's option universe."""

    direction: SentimentDirection
    strength: Optional[SentimentStrength] = None
    score: Optional[float] = None
    underlyings: list[UnderlyingSentiment]


class MarketSentiment(BaseModel):
    """GET /options/sentiment - backs the shell header's sentiment badges."""

    exchanges: dict[str, ExchangeSentiment]


class PlaceOrderRequest(BaseModel):
    """POST /dhan/orders body - live-broker-adapter P0 (see
    docs/architecture.md). `symbol` is this service's own plain symbol
    (resolved to a Dhan security ID/segment server-side via
    resolve_feed_target, see DhanProvider.place_order), not a Dhan ID -
    execution never needs to know those. `correlation_id` should carry
    execution's own broker_orders.client_order_id, for the submit-then-
    crash idempotency story - see DhanProvider.place_order's own docstring
    on why that dedup isn't yet confirmed to actually work Dhan-side."""

    symbol: str
    exchange: str
    transaction_type: Literal["BUY", "SELL"]
    quantity: int = Field(gt=0)
    order_type: Literal["MARKET", "LIMIT", "STOP_LOSS", "STOP_LOSS_MARKET"]
    product_type: Literal["CNC", "INTRADAY", "MARGIN", "MTF"]
    price: Optional[float] = None
    trigger_price: Optional[float] = None
    correlation_id: Optional[str] = None


class InternalPlaceOrderRequest(PlaceOrderRequest):
    """service-to-service counterpart to PlaceOrderRequest - live-broker-
    adapter P2 (see docs/architecture.md), for execution's scheduler jobs
    (real square-off, reactive live exits), which have no live user bearer
    token to forward. `user_id` stands in for require_user_id's decoded
    JWT claim - see GET /internal/dhan/order-book's own docstring for the
    same shared-secret-instead-of-JWT reasoning."""

    user_id: UUID


class ModifyOrderRequest(BaseModel):
    """PUT /dhan/orders/{order_id} body - only what the trailing-SL
    reconciliation job (execution) actually needs to change on a resting
    order, see DhanProvider.modify_order's own docstring."""

    order_type: Literal["MARKET", "LIMIT", "STOP_LOSS", "STOP_LOSS_MARKET"]
    quantity: int = Field(gt=0)
    price: Optional[float] = None
    trigger_price: Optional[float] = None


class InternalModifyOrderRequest(ModifyOrderRequest):
    """service-to-service counterpart to ModifyOrderRequest - see
    InternalPlaceOrderRequest's own docstring. Needs `exchange` too (unlike
    the user-token route, which takes it as a query param) since this
    isn't nested under a path that already carries it."""

    user_id: UUID
    exchange: str


class OrderResponse(BaseModel):
    """Deliberately a thin, permissive passthrough of Dhan's own raw
    response rather than a strict field-by-field mirror - see
    DhanProvider.place_order's own docstring on why the exact response
    shape isn't yet confirmed live. execution's caller is expected to
    read `raw` for whatever Dhan actually sent back (order id, status,
    etc.) rather than this service guessing at a stable contract for
    something that hasn't been exercised against the real API yet."""

    raw: dict


class OrderBookResponse(BaseModel):
    orders: list[dict]


class FundsResponse(BaseModel):
    raw: dict


class DhanOrderUpdatePostback(BaseModel):
    """POST /dhan/order-update/{secret} body - Dhan's own postback shape
    isn't documented/confirmed live yet (see config.py's own comment on
    the secret-path-segment protection this route relies on instead of a
    signature check), so this is deliberately permissive: every field
    Optional, extra fields ignored rather than 422ing a payload Dhan
    actually sent just because this mirror is incomplete. Relayed
    as-is (see the route) to execution's own internal ingestion endpoint,
    which is what actually interprets/validates it against broker_orders -
    market-data holds no order state of its own to validate against."""

    model_config = ConfigDict(extra="allow")

    orderId: Optional[str] = None
    orderStatus: Optional[str] = None
    correlationId: Optional[str] = None


class SentimentHistoryPoint(BaseModel):
    """One market_data.sentiment_history row - GET /options/sentiment-history.
    spot_price is the underlying's own price at that same recorded_at (not
    converted/adjusted), so it can be plotted directly against direction/
    strength to check whether price actually moved the way the OI read
    predicted."""

    model_config = ConfigDict(from_attributes=True)

    recorded_at: datetime
    direction: SentimentDirection
    strength: Optional[SentimentStrength] = None
    score_5m: Optional[float] = None
    score_15m: Optional[float] = None
    spot_price: Optional[float] = None
    # See UnderlyingSentiment's own comment - the ATM strike's own
    # call/put buildup classification at this snapshot, deliberately kept
    # as two separate values.
    atm_call_buildup: Optional[Literal["long_buildup", "short_buildup", "short_covering", "long_unwinding"]] = None
    atm_put_buildup: Optional[Literal["long_buildup", "short_buildup", "short_covering", "long_unwinding"]] = None
    error: Optional[str] = None


class SentimentHistoryDay(BaseModel):
    """GET /options/sentiment-history's full response - one calendar day's
    points, PLUS that same day's session_start/session_end already resolved
    from app.domain.sentiment.SEGMENT_SESSION_HOURS (see session_bounds) -
    so SentimentHistoryChart.tsx doesn't need its own copy of session-hours
    logic to bound its x-axis. One definition, in this backend, shared by
    both the scheduled recorder (is_within_session) and this read path."""

    exchange: str
    session_start: datetime
    session_end: datetime
    points: list[SentimentHistoryPoint]
