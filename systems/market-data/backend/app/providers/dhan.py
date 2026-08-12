"""Dhan v2 API provider - NSE equity/index/index-futures and MCX
commodity futures.

The instrument master (trading symbol -> security ID) is Dhan's own
reference data, downloaded fresh on a schedule rather than treated as
something we own long-term - see https://dhanhq.co/docs/v2/instruments/.

One DhanProvider instance covers one *exchange* (matching router.py's
exchange-keyed dispatch), but can hold several SegmentConfigs - e.g. the
NSE instance holds cash-equity, index-spot, and index-futures configs,
since Dhan's own API segments those independently even though they're
all "NSE" as far as the rest of this platform is concerned. Every
Dhan-specific field value used below (SEM_* CSV columns, the ltp/candle
"segment key" strings) was checked against a live download of the real
instrument-master CSV before being hardcoded here - see
docs/architecture.md Phase 3 for the verification note. The CSV columns
(SEM_EXM_EXCH_ID, SEM_SEGMENT, SEM_INSTRUMENT_NAME, SM_SYMBOL_NAME,
SEM_LOT_UNITS, SEM_EXPIRY_DATE) are confirmed directly from that
download; the marketfeed/charts "segment key" strings themselves
(NSE_EQ, MCX_COMM, NSE_FNO, IDX_I) aren't present in the CSV at all -
NSE_EQ is proven correct by this file's pre-existing working code, the
other three are Dhan's documented exchangeSegment values.
"""

import csv
import io
import logging
import re
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Optional
from zoneinfo import ZoneInfo

import requests

from app.config import settings
from app.domain.models import Candle, OptionChain, OptionChainStrike, OptionGreeks, OptionLegQuote, ResolvedUnderlying
from app.domain.moneyness import classify_moneyness, infer_strike_step
from app.providers.base import QuoteProvider

logger = logging.getLogger(__name__)

INSTRUMENT_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master.csv"
LTP_URL = "https://api.dhan.co/v2/marketfeed/ltp"
CANDLE_URL = "https://api.dhan.co/v2/charts/intraday"
RENEW_TOKEN_URL = "https://api.dhan.co/v2/RenewToken"
OPTION_CHAIN_URL = "https://api.dhan.co/v2/optionchain"
OPTION_EXPIRY_LIST_URL = "https://api.dhan.co/v2/optionchain/expirylist"

# Dhan's charts/intraday only *natively* supports these interval values
# (minutes) - notably 25, not 30, and no daily granularity (that's a
# separate charts/historical endpoint returning DAILY bars only - wrong
# granularity for intraday RSI, so get_candle_history below stays on
# this same intraday endpoint with a real date range instead). Any other
# "Nmin" interval (3min, 2min, 10min, 20min, 30min, ...) is served by
# fetching native 1min bars and aggregating them locally - see
# _interval_minutes/_aggregate_candles below - so the interval vocabulary
# used by Strategy's interval (signal-generation) is NOT limited to this
# dict; it's just which values skip local aggregation.
DHAN_CANDLE_INTERVAL_MINUTES = {"1min": 1, "5min": 5, "15min": 15, "25min": 25, "60min": 60}


def _interval_minutes(interval: str) -> int:
    """Resolves any interval string to its length in minutes - a native
    Dhan granularity (dict lookup) or a general "Nmin" shape for local
    aggregation (see _aggregate_candles). Raises ValueError for anything
    else (e.g. "daily", which these intraday endpoints don't serve at
    all - see get_candle_history's docstring)."""
    if interval in DHAN_CANDLE_INTERVAL_MINUTES:
        return DHAN_CANDLE_INTERVAL_MINUTES[interval]
    match = re.fullmatch(r"(\d+)min", interval)
    if not match or int(match.group(1)) <= 0:
        raise ValueError(
            f"unsupported candle interval '{interval}' - must be one of "
            f"{list(DHAN_CANDLE_INTERVAL_MINUTES)} (native) or any 'Nmin' shape (locally aggregated from 1min bars)"
        )
    return int(match.group(1))


def _aggregate_candles(one_min_candles: list[Candle], interval: str, minutes: int) -> list[Candle]:
    """Buckets native, already-completed 1-minute candles into `minutes`-
    wide bars, aligned to clock-time multiples of `minutes` since
    midnight - matching Dhan's own observed alignment for native
    intervals (e.g. real 5min bars land on :00/:05/:10, never :02/:07).
    Only emits a bucket once it holds a full complement of `minutes` one-
    minute bars; a short bucket (session open not aligned to N, or the
    tail end still forming) is dropped rather than emitted early -
    extending the same "completed bars only" rule _fetch_native_candles
    already applies at the 1-minute level up to the aggregate level.
    `one_min_candles` must be oldest-first (as returned by
    _fetch_native_candles) so the returned list is too."""
    buckets: dict[datetime, list[Candle]] = {}
    order: list[datetime] = []
    for candle in one_min_candles:
        ts = datetime.fromisoformat(candle.timestamp)
        bucket_start_minutes = ((ts.hour * 60 + ts.minute) // minutes) * minutes
        bucket_start = ts.replace(hour=bucket_start_minutes // 60, minute=bucket_start_minutes % 60, second=0, microsecond=0)
        if bucket_start not in buckets:
            buckets[bucket_start] = []
            order.append(bucket_start)
        buckets[bucket_start].append(candle)

    result = []
    for bucket_start in order:
        members = buckets[bucket_start]
        if len(members) != minutes:
            continue
        result.append(
            Candle(
                exchange=members[0].exchange,
                symbol=members[0].symbol,
                interval=interval,
                open=members[0].open,
                high=max(c.high for c in members),
                low=min(c.low for c in members),
                close=members[-1].close,
                timestamp=bucket_start.isoformat(),
                provider=members[0].provider,
            )
        )
    return result

# Dhan doesn't publish a specific rate limit for charts/intraday (unlike
# marketfeed/ltp's documented-and-empirically-confirmed 1 req/sec) - this
# is a conservative default, not a known requirement. Kept as independent
# throttle state from the LTP throttle below (own lock, own timestamp)
# since these hit a different Dhan endpoint - no reason for one to
# serialize behind the other.
MIN_CANDLE_CALL_INTERVAL_SECONDS = 2.0

# Dhan's LTP endpoint is limited to 1 request/second, but empirically a
# ~1.05s gap still gets 429'd - build in real margin rather than shaving
# it close. It supports up to 1000 instruments per call, so get_ltp_batch
# fetches everything needed in ONE throttled call regardless of how many
# distinct symbols are open - a per-symbol loop here would mean N*2s to
# refresh N symbols, which is structurally slower than most poll
# intervals once N is more than a couple (this was found the hard way -
# see docs/architecture.md).
MIN_LTP_CALL_INTERVAL_SECONDS = 2.0

# Short-lived cache so repeated lookups within a few seconds (e.g.
# execution's frontend polling every 5s) hit memory instead of making a
# fresh Dhan call at all. A stepping stone toward a Dhan WebSocket feed
# (ticks kept in memory, no per-request outbound call at all) - see
# docs/architecture.md.
QUOTE_CACHE_TTL_SECONDS = 3.0

# If the throttle wait already implied by another in-flight request is
# longer than this, fail fast instead of piling another thread onto the
# queue - callers already treat a failed quote as "unavailable, try again
# later" rather than something to block indefinitely on.
MAX_THROTTLE_WAIT_SECONDS = 4.0

# Dhan documents this one explicitly (unlike LTP/candle above, which are
# empirically-derived): 1 unique request per 3 seconds. Own lock/timestamp
# - a different Dhan endpoint, no reason to serialize behind LTP/candle.
MIN_OPTION_CHAIN_CALL_INTERVAL_SECONDS = 3.0
# A few seconds is enough to absorb a caller polling faster than the
# chain actually changes, same reasoning as QUOTE_CACHE_TTL_SECONDS above.
OPTION_CHAIN_CACHE_TTL_SECONDS = 3.0

# Shared, in-memory access-token state - genuinely global (not per
# DhanProvider instance) since router.py's two instances (dhan-nse,
# dhan-mcx) share one Dhan account/token. In-memory only, no persistence:
# a container restart reverts to DHAN_ACCESS_TOKEN from the environment,
# same as before this existed - see docs/architecture.md.
_token_lock = threading.Lock()
_renewed_token: Optional[str] = None  # None until the first successful renewal
_last_renewed_at: Optional[datetime] = None
_last_renewal_response: Optional[dict] = None  # raw Dhan response, for the status endpoint


def current_access_token() -> str:
    """The token every DhanProvider request should use - the last
    successfully renewed one if there's been one, else whatever's in
    DHAN_ACCESS_TOKEN (the .env seed value, or a test's monkeypatched
    settings.dhan_access_token - existing tests never call
    renew_access_token(), so this always falls through to settings for
    them, unmodified)."""
    with _token_lock:
        return _renewed_token if _renewed_token is not None else settings.dhan_access_token


def renew_token_status() -> dict:
    with _token_lock:
        return {
            "renewed": _renewed_token is not None,
            "last_renewed_at": _last_renewed_at.isoformat() if _last_renewed_at else None,
            "expiry_time": (_last_renewal_response or {}).get("expiryTime"),
            # dhanClientName is what Dhan's docs describe; createTime is
            # what the live response actually sends instead - surfacing
            # both defensively (see renew_access_token's own note).
            "dhan_client_name": (_last_renewal_response or {}).get("dhanClientName"),
            "create_time": (_last_renewal_response or {}).get("createTime"),
        }


def renew_access_token() -> dict:
    """Calls Dhan's RenewToken (https://docs.dhanhq.co/api/v2/authentication/renew-token)
    with the current active token; updates the shared token every
    DhanProvider instance's requests read from via current_access_token().
    Only renews an already-active token - Dhan rejects renewing an
    expired one (401), which is why the scheduled job (app/scheduler.py)
    runs well before the 24h validity window closes."""
    token = current_access_token()
    if not settings.dhan_client_id or not token:
        raise RuntimeError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are not configured")

    resp = requests.get(
        RENEW_TOKEN_URL,
        # Note: this endpoint's client-id header is "dhanClientId", not
        # "client-id" like the LTP/candle endpoints below use - Dhan's own
        # API is inconsistent about this between endpoints.
        headers={"Accept": "application/json", "access-token": token, "dhanClientId": settings.dhan_client_id},
        timeout=15,
    )
    if resp.status_code == 401:
        raise RuntimeError(
            "Dhan rejected the renewal request (401) - the current token may already be expired; "
            "generate a new one from Dhan Web"
        )
    try:
        resp.raise_for_status()
    except requests.exceptions.HTTPError as exc:
        raise RuntimeError(f"Dhan token renewal failed ({resp.status_code}): {resp.text[:200]}") from exc

    data = resp.json()
    # Dhan's own docs (https://docs.dhanhq.co/api/v2/authentication/renew-token)
    # say this field is "accessToken", but the live response actually
    # uses "token" (and "createTime" instead of dhanClientId/
    # dhanClientName/etc - confirmed empirically, docs are stale/wrong
    # here). Accept either name defensively.
    new_token = data.get("token") or data.get("accessToken")
    if not new_token:
        # Dhan doesn't always signal a rejected renewal via a non-200
        # status - e.g. an already-expired token has been observed to
        # come back as a 200 with an errorType/errorCode/errorMessage
        # body instead of a token, same shape other Dhan endpoints use
        # for a real error. Treat a response with no token as a failure
        # either way, rather than raising an unhandled KeyError.
        raise RuntimeError(f"Dhan token renewal did not return a token: {resp.text[:200]}")

    global _renewed_token, _last_renewed_at, _last_renewal_response
    with _token_lock:
        _renewed_token = new_token
        _last_renewed_at = datetime.now(timezone.utc)
        _last_renewal_response = data
    logger.info("Dhan access token renewed, new expiry %s", data.get("expiryTime"))
    return data


@dataclass(frozen=True)
class SegmentConfig:
    """One Dhan "segment" a DhanProvider instance can resolve/quote/chart.
    A single instance holds one of these per distinct Dhan segment it
    covers (see the NSE_* / MCX_FUTCOM constants below) - credentials and
    rate limits are shared per Dhan account regardless of segment, so
    there's no need for a separate provider *instance* per segment, only
    per exchange (matching router.py's existing exchange-keyed dispatch)."""

    exchange: str  # what Candle.exchange / execution's `exchange` field shows - "NSE" or "MCX"
    ltp_segment_key: str  # Dhan marketfeed/ltp request+response key, e.g. "NSE_EQ", "MCX_COMM"
    candle_exchange_segment: str  # charts API "exchangeSegment" - identical to ltp_segment_key for every segment seen so far
    candle_instrument: str  # charts API "instrument" - mirrors SEM_INSTRUMENT_NAME exactly
    row_matches: Callable[[dict], bool]  # CSV row filter
    # Set only for futures configs - extracts e.g. "GOLDM"/"NIFTY" from a
    # contract row, for active-month grouping (resolve_active_contract).
    underlying_of: Optional[Callable[[dict], str]] = None


def _underlying_from_trading_symbol(row: dict) -> str:
    """Derives the underlying from SEM_TRADING_SYMBOL (e.g.
    "GOLDM-04Sep2026-FUT" / "NIFTY-Oct2026-FUT" -> "GOLDM" / "NIFTY") -
    NOT from SM_SYMBOL_NAME, which is populated for MCX_FUTCOM rows but
    empirically blank for NSE_FUTIDX rows in Dhan's real instrument
    master (checked via a live download, not assumed)."""
    return row.get("SEM_TRADING_SYMBOL", "").split("-")[0]


NSE_EQ = SegmentConfig(
    exchange="NSE",
    ltp_segment_key="NSE_EQ",
    candle_exchange_segment="NSE_EQ",
    candle_instrument="EQUITY",
    row_matches=lambda r: (
        r.get("SEM_EXM_EXCH_ID") == "NSE" and r.get("SEM_SEGMENT") == "E" and r.get("SEM_SERIES") == "EQ"
    ),
)

# NSE index spot values (NIFTY, BANKNIFTY, and every other NSE index Dhan
# publishes) - what's actually charted for RSI on an index underlying,
# no expiry/rollover concept at all. Not restricted to a hardcoded
# symbol allowlist - any SEM_TRADING_SYMBOL match resolves, so a new
# underlying (e.g. FINNIFTY) works with zero code changes, same
# generality as MCX_FUTCOM below.
NSE_INDEX = SegmentConfig(
    exchange="NSE",
    ltp_segment_key="IDX_I",
    candle_exchange_segment="IDX_I",
    candle_instrument="INDEX",
    row_matches=lambda r: r.get("SEM_EXM_EXCH_ID") == "NSE" and r.get("SEM_INSTRUMENT_NAME") == "INDEX",
)

# NSE index futures (NIFTY/BANKNIFTY/...) - the interim tradeable
# instrument for an index underlying (chart the spot above, trade the
# active-month future here) per docs/architecture.md's "future signals
# now, options later" decision.
NSE_FUTIDX = SegmentConfig(
    exchange="NSE",
    ltp_segment_key="NSE_FNO",
    candle_exchange_segment="NSE_FNO",
    candle_instrument="FUTIDX",
    row_matches=lambda r: r.get("SEM_EXM_EXCH_ID") == "NSE" and r.get("SEM_INSTRUMENT_NAME") == "FUTIDX",
    underlying_of=_underlying_from_trading_symbol,
)

# MCX commodity futures (GOLDM, CRUDEOILM, ...) - no spot to chart, chart
# and trade the same active-month contract.
MCX_FUTCOM = SegmentConfig(
    exchange="MCX",
    ltp_segment_key="MCX_COMM",
    candle_exchange_segment="MCX_COMM",
    candle_instrument="FUTCOM",
    row_matches=lambda r: r.get("SEM_EXM_EXCH_ID") == "MCX" and r.get("SEM_INSTRUMENT_NAME") == "FUTCOM",
    underlying_of=_underlying_from_trading_symbol,
)


@dataclass(frozen=True)
class ContractInfo:
    trading_symbol: str
    expiry_date: date


class DhanProvider(QuoteProvider):
    def __init__(self, segment_configs: Optional[list[SegmentConfig]] = None, name: str = "dhan") -> None:
        # Defaults to NSE-cash-equity-only, matching this class's
        # original single-segment behavior - existing callers/tests that
        # construct DhanProvider() with no args are unaffected.
        self._configs = segment_configs or [NSE_EQ]
        self._default_config = self._configs[0]
        self.name = name

        self._lock = threading.Lock()
        self._symbol_to_security_id: dict[str, str] = {}
        # Per-symbol metadata beyond the security id - which Dhan segment
        # it belongs to and its lot size. Kept as a SEPARATE dict (not
        # merged into _symbol_to_security_id's value type) so that dict
        # stays a plain symbol->id str mapping exactly as before this
        # multi-segment refactor - existing tests poke it directly.
        self._symbol_to_config: dict[str, SegmentConfig] = {}
        self._symbol_to_lot_size: dict[str, int] = {}
        # underlying (e.g. "GOLDM") -> its contracts across all expiries,
        # sorted by expiry ascending - only populated for configs that
        # set underlying_of.
        self._underlying_to_contracts: dict[str, list[ContractInfo]] = {}
        self._last_synced_at: Optional[datetime] = None
        self._last_ltp_call_at: float = 0.0
        self._quote_cache: dict[str, tuple[float, float]] = {}  # symbol -> (price, fetched_at)
        self._quote_cache_lock = threading.Lock()

        self._candle_lock = threading.Lock()
        self._last_candle_call_at: float = 0.0
        # (symbol, interval) -> (candle, fetched_at) - TTL is the
        # interval's own length (see _cached_candle), not the 3s quote
        # TTL, since a completed candle doesn't change until the next one
        # closes.
        self._candle_cache: dict[tuple[str, str], tuple[Candle, float]] = {}
        self._candle_cache_lock = threading.Lock()

        self._option_chain_lock = threading.Lock()
        self._last_option_chain_call_at: float = 0.0
        self._option_chain_cache: dict[tuple[str, str], tuple[OptionChain, float]] = {}
        self._option_chain_cache_lock = threading.Lock()

    def status(self) -> dict:
        return {
            "provider": self.name,
            "symbol_count": len(self._symbol_to_security_id),
            "last_synced_at": self._last_synced_at.isoformat() if self._last_synced_at else None,
        }

    def sync_instruments(self) -> dict:
        logger.info("syncing Dhan instrument master from %s (%s)", INSTRUMENT_MASTER_URL, self.name)
        resp = requests.get(INSTRUMENT_MASTER_URL, timeout=60)
        resp.raise_for_status()

        symbol_to_id: dict[str, str] = {}
        symbol_to_config: dict[str, SegmentConfig] = {}
        symbol_to_lot: dict[str, int] = {}
        underlying_to_contracts: dict[str, list[ContractInfo]] = {}

        reader = csv.DictReader(io.StringIO(resp.text))
        for row in reader:
            for config in self._configs:
                if not config.row_matches(row):
                    continue
                symbol = row["SEM_TRADING_SYMBOL"]
                symbol_to_id[symbol] = row["SEM_SMST_SECURITY_ID"]
                symbol_to_config[symbol] = config
                symbol_to_lot[symbol] = int(float(row.get("SEM_LOT_UNITS") or 1))

                if config.underlying_of is not None:
                    underlying = config.underlying_of(row)
                    expiry_raw = (row.get("SEM_EXPIRY_DATE") or "").split(" ")[0]
                    try:
                        expiry_date = date.fromisoformat(expiry_raw)
                    except ValueError:
                        continue  # malformed/missing expiry - skip, can't be resolved by active-month logic
                    underlying_to_contracts.setdefault(underlying, []).append(
                        ContractInfo(trading_symbol=symbol, expiry_date=expiry_date)
                    )
                break  # a row belongs to at most one of this instance's configs

        for contracts in underlying_to_contracts.values():
            contracts.sort(key=lambda c: c.expiry_date)

        with self._lock:
            self._symbol_to_security_id = symbol_to_id
            self._symbol_to_config = symbol_to_config
            self._symbol_to_lot_size = symbol_to_lot
            self._underlying_to_contracts = underlying_to_contracts
            self._last_synced_at = datetime.now(timezone.utc)

        logger.info("Dhan instrument master synced (%s): %d symbols", self.name, len(symbol_to_id))
        return self.status()

    def _security_id(self, symbol: str) -> Optional[str]:
        if not self._symbol_to_security_id:
            self.sync_instruments()
        return self._symbol_to_security_id.get(symbol)

    def resolve_feed_target(self, symbol: str) -> Optional[tuple[str, str]]:
        """(ltp_segment_key, security_id) for subscribing `symbol` on
        Dhan's live market feed WebSocket (app/providers/dhan_feed.py) -
        the same segment-key vocabulary ("NSE_EQ", "IDX_I", ...) and
        security-id lookup get_ltp_batch already uses for the REST LTP
        endpoint. None if the symbol is unknown."""
        security_id = self._security_id(symbol)
        if security_id is None:
            return None
        return self._config_for(symbol).ltp_segment_key, security_id

    def _config_for(self, symbol: str) -> SegmentConfig:
        """Falls back to this instance's first/default config for a
        symbol with no recorded segment - covers tests (and any caller)
        that stuff _symbol_to_security_id directly without going through
        a real sync, reproducing this class's original single-segment
        behavior exactly."""
        return self._symbol_to_config.get(symbol, self._default_config)

    def resolve_active_contract(self, underlying: str) -> Optional[ContractInfo]:
        """The nearest not-yet-expired contract for `underlying` - "active
        month," re-resolved from whatever the most recent instrument sync
        produced (no separate caching/rollover-detection needed beyond
        that daily resync)."""
        contracts = self._underlying_to_contracts.get(underlying)
        if not contracts:
            return None
        today = datetime.now(ZoneInfo(settings.timezone)).date()
        unexpired = [c for c in contracts if c.expiry_date >= today]
        return min(unexpired, key=lambda c: c.expiry_date) if unexpired else None

    def resolve_underlying(self, underlying: str) -> Optional[ResolvedUnderlying]:
        """chart_symbol/chart_exchange = what to fetch candles for and
        compute indicators on; trade_symbol/trade_exchange = what an
        actual signal should be opened on. Equal for commodities (no
        spot to chart); different for indices (chart the spot, trade the
        active-month future) - see docs/architecture.md."""
        if not self._symbol_to_security_id:
            self.sync_instruments()

        index_symbol = underlying if underlying in self._symbol_to_config else None
        if index_symbol is not None and self._config_for(index_symbol).candle_instrument != "INDEX":
            index_symbol = None  # matched a non-index symbol of the same name - not what we want

        contract = self.resolve_active_contract(underlying)

        if index_symbol is not None and contract is not None:
            return ResolvedUnderlying(
                chart_symbol=index_symbol,
                chart_exchange=self._config_for(index_symbol).exchange,
                trade_symbol=contract.trading_symbol,
                trade_exchange=self._config_for(contract.trading_symbol).exchange,
                lot_size=self._symbol_to_lot_size.get(contract.trading_symbol, 1),
                expiry=contract.expiry_date.isoformat(),
            )
        if contract is not None:
            return ResolvedUnderlying(
                chart_symbol=contract.trading_symbol,
                chart_exchange=self._config_for(contract.trading_symbol).exchange,
                trade_symbol=contract.trading_symbol,
                trade_exchange=self._config_for(contract.trading_symbol).exchange,
                lot_size=self._symbol_to_lot_size.get(contract.trading_symbol, 1),
                expiry=contract.expiry_date.isoformat(),
            )

        # A directly-tradeable instrument with no separate underlying/
        # rollover concept at all - e.g. an NSE cash equity (NSE_EQ),
        # where the "underlying" IS the traded symbol itself, unlike a
        # future (resolved via `contract` above) or an index (charted
        # separately from what's traded). Checked last so it can never
        # shadow the index/futures resolutions above - only NSE_EQ rows
        # (underlying_of=None, candle_instrument="EQUITY") match; an
        # index row with no active future found still correctly resolves
        # to nothing rather than silently trading the index itself.
        if underlying in self._symbol_to_config:
            config = self._config_for(underlying)
            if config.underlying_of is None and config.candle_instrument == "EQUITY":
                return ResolvedUnderlying(
                    chart_symbol=underlying,
                    chart_exchange=config.exchange,
                    trade_symbol=underlying,
                    trade_exchange=config.exchange,
                    lot_size=self._symbol_to_lot_size.get(underlying, 1),
                    expiry=None,
                )
        return None

    def get_lot_size(self, symbol: str) -> Optional[int]:
        if not self._symbol_to_security_id:
            self.sync_instruments()
        if symbol not in self._symbol_to_security_id:
            return None
        return self._symbol_to_lot_size.get(symbol, 1)

    def _cached_quote(self, symbol: str) -> Optional[float]:
        with self._quote_cache_lock:
            cached = self._quote_cache.get(symbol)
        if cached is None:
            return None
        price, fetched_at = cached
        if (time.monotonic() - fetched_at) >= QUOTE_CACHE_TTL_SECONDS:
            return None
        return price

    def _store_quotes(self, prices: dict[str, float]) -> None:
        now = time.monotonic()
        with self._quote_cache_lock:
            for symbol, price in prices.items():
                self._quote_cache[symbol] = (price, now)

    def get_ltp(self, symbol: str) -> float:
        result = self.get_ltp_batch([symbol])
        if symbol not in result:
            raise ValueError(f"no LTP available for '{symbol}' - unknown symbol or Dhan omitted it")
        return result[symbol]

    def get_ltp_batch(self, symbols: list[str]) -> dict[str, float]:
        if not symbols:
            return {}

        result: dict[str, float] = {}
        # security_id -> (symbol, ltp_segment_key) - a batch can span
        # multiple Dhan segments (e.g. an NSE_EQ symbol and an NSE_FNO
        # symbol in the same request), grouped into the request body by
        # segment key below.
        pending: dict[str, tuple[str, str]] = {}
        for symbol in symbols:
            cached = self._cached_quote(symbol)
            if cached is not None:
                result[symbol] = cached
                continue
            security_id = self._security_id(symbol)
            if security_id is None:
                logger.warning("unknown symbol '%s' (%s) - instrument master may need a sync", symbol, self.name)
                continue
            pending[security_id] = (symbol, self._config_for(symbol).ltp_segment_key)

        if not pending:
            return result  # everything was cached (or unknown)

        access_token = current_access_token()
        if not settings.dhan_client_id or not access_token:
            raise RuntimeError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are not configured")

        with self._lock:
            wait = MIN_LTP_CALL_INTERVAL_SECONDS - (time.monotonic() - self._last_ltp_call_at)
            if wait > MAX_THROTTLE_WAIT_SECONDS:
                raise RuntimeError(f"Dhan quote queue is backed up ({wait:.1f}s wait) - try again shortly")
            if wait > 0:
                time.sleep(wait)
            self._last_ltp_call_at = time.monotonic()

        body: dict[str, list[int]] = {}
        for security_id, (_symbol, segment_key) in pending.items():
            body.setdefault(segment_key, []).append(int(security_id))

        resp = requests.post(
            LTP_URL,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "access-token": access_token,
                "client-id": settings.dhan_client_id,
            },
            json=body,
            timeout=15,
        )
        if resp.status_code == 401:
            raise RuntimeError("Dhan API rejected the access token (401) - it may need to be regenerated")
        if resp.status_code == 429:
            raise RuntimeError("Dhan API rate limit hit (429) - LTP is limited to 1 request/second, retry shortly")
        try:
            resp.raise_for_status()
        except requests.exceptions.HTTPError as exc:
            raise RuntimeError(f"Dhan API error ({resp.status_code}): {resp.text[:200]}") from exc

        data = resp.json().get("data", {})

        fresh: dict[str, float] = {}
        for security_id, (symbol, segment_key) in pending.items():
            entry = data.get(segment_key, {}).get(security_id)
            if entry is None:
                logger.warning("Dhan response missing %s (%s, segment=%s)", symbol, security_id, segment_key)
                continue
            fresh[symbol] = float(entry["last_price"])

        self._store_quotes(fresh)
        result.update(fresh)
        return result

    def _cached_candle(self, symbol: str, interval: str) -> Optional[Candle]:
        with self._candle_cache_lock:
            cached = self._candle_cache.get((symbol, interval))
        if cached is None:
            return None
        candle, fetched_at = cached
        if (time.monotonic() - fetched_at) >= _interval_minutes(interval) * 60:
            return None
        return candle

    def _store_candle(self, symbol: str, interval: str, candle: Candle) -> None:
        with self._candle_cache_lock:
            self._candle_cache[(symbol, interval)] = (candle, time.monotonic())

    def _fetch_candles(self, symbol: str, interval: str, from_dt: datetime, to_dt: datetime) -> list[Candle]:
        """Shared entry point for both get_previous_candle and
        get_candle_history. For a native Dhan granularity, this is a
        single request. For anything else (e.g. "3min"), Dhan has no
        native candle for it - so this fetches native 1min bars over the
        same range and buckets them locally (_aggregate_candles). Either
        way, returns only *completed* bars, oldest first."""
        minutes = _interval_minutes(interval)
        if interval in DHAN_CANDLE_INTERVAL_MINUTES:
            return self._fetch_native_candles(symbol, interval, minutes, from_dt, to_dt)
        one_min_candles = self._fetch_native_candles(symbol, "1min", 1, from_dt, to_dt)
        return _aggregate_candles(one_min_candles, interval, minutes)

    def _fetch_native_candles(
        self, symbol: str, interval: str, interval_minutes: int, from_dt: datetime, to_dt: datetime
    ) -> list[Candle]:
        """The actual Dhan charts/intraday request/parse - `interval` must
        be one of Dhan's own native granularities (a key of
        DHAN_CANDLE_INTERVAL_MINUTES), used both directly (native
        intervals) and as the "1min" building block for local aggregation
        (see _fetch_candles). Returns only *completed* bars (excludes any
        still-forming trailing bar), oldest first."""
        security_id = self._security_id(symbol)
        if security_id is None:
            logger.warning("unknown symbol '%s' (%s) - instrument master may need a sync", symbol, self.name)
            return []

        access_token = current_access_token()
        if not settings.dhan_client_id or not access_token:
            raise RuntimeError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are not configured")

        with self._candle_lock:
            wait = MIN_CANDLE_CALL_INTERVAL_SECONDS - (time.monotonic() - self._last_candle_call_at)
            if wait > MAX_THROTTLE_WAIT_SECONDS:
                raise RuntimeError(f"Dhan candle queue is backed up ({wait:.1f}s wait) - try again shortly")
            if wait > 0:
                time.sleep(wait)
            self._last_candle_call_at = time.monotonic()

        config = self._config_for(symbol)
        tz = ZoneInfo(settings.timezone)
        now_epoch = datetime.now(tz).timestamp()

        resp = requests.post(
            CANDLE_URL,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "access-token": access_token,
                "client-id": settings.dhan_client_id,
            },
            json={
                "securityId": security_id,
                "exchangeSegment": config.candle_exchange_segment,
                "instrument": config.candle_instrument,
                "interval": str(interval_minutes),
                "oi": False,
                "fromDate": from_dt.strftime("%Y-%m-%d %H:%M:%S"),
                "toDate": to_dt.strftime("%Y-%m-%d %H:%M:%S"),
            },
            timeout=30,
        )
        if resp.status_code == 401:
            raise RuntimeError("Dhan API rejected the access token (401) - it may need to be regenerated")
        if resp.status_code == 429:
            raise RuntimeError("Dhan API rate limit hit (429) on charts/intraday - retry shortly")
        try:
            resp.raise_for_status()
        except requests.exceptions.HTTPError as exc:
            raise RuntimeError(f"Dhan API error ({resp.status_code}): {resp.text[:200]}") from exc

        data = resp.json()
        timestamps = data.get("timestamp") or []
        if not timestamps:
            return []

        opens, highs, lows, closes = data.get("open", []), data.get("high", []), data.get("low", []), data.get("close", [])
        interval_seconds = interval_minutes * 60
        # Dhan may include a still-forming final bar - only trust bars
        # whose full interval has already elapsed.
        completed = [i for i, ts in enumerate(timestamps) if ts + interval_seconds <= now_epoch]

        return [
            Candle(
                exchange=config.exchange,
                symbol=symbol,
                interval=interval,
                open=float(opens[i]),
                high=float(highs[i]),
                low=float(lows[i]),
                close=float(closes[i]),
                timestamp=datetime.fromtimestamp(timestamps[i], tz=tz).isoformat(),
                provider=self.name,
            )
            for i in completed
        ]

    def get_previous_candle(self, symbol: str, interval: str) -> Optional[Candle]:
        """The most recently *completed* candle only - not a historical
        range (use get_candle_history for that). No true multi-symbol
        batching like get_ltp_batch - Dhan's charts/intraday endpoint is
        per-security-id, so callers needing several symbols must call
        this once each; the interval-length cache above is what keeps
        repeated calls (e.g. execution's exit-monitor job polling every
        30s) from re-hitting Dhan every tick."""
        _interval_minutes(interval)  # raises ValueError for a malformed interval; native or "Nmin" aggregate both fine

        cached = self._cached_candle(symbol, interval)
        if cached is not None:
            return cached

        tz = ZoneInfo(settings.timezone)
        now = datetime.now(tz)
        # 6h comfortably covers the trading session so far without
        # reaching back into a previous day - "previous candle" is scoped
        # to today; if the market just opened and no candle has completed
        # yet, this correctly returns None below.
        candles = self._fetch_candles(symbol, interval, now - timedelta(hours=6), now)
        if not candles:
            return None

        candle = candles[-1]  # _fetch_candles returns oldest-first, completed-only
        self._store_candle(symbol, interval, candle)
        return candle

    def get_candle_history(self, symbol: str, interval: str, from_date: date, to_date: date) -> list[Candle]:
        """A general multi-bar series over a caller-supplied date range -
        NOT cached (unlike get_previous_candle, a historical range isn't
        a single value that goes stale on a fixed TTL). Used to warm up
        indicator state (RSI/SMA) for the in-house signal engine and for
        backtesting - see signal-generation's app/domain/engine.py and
        backtest.py."""
        _interval_minutes(interval)  # raises ValueError for a malformed interval; native or "Nmin" aggregate both fine

        tz = ZoneInfo(settings.timezone)
        from_dt = datetime.combine(from_date, datetime.min.time(), tzinfo=tz)
        to_dt = datetime.combine(to_date, datetime.max.time().replace(microsecond=0), tzinfo=tz)
        return self._fetch_candles(symbol, interval, from_dt, to_dt)

    def _option_chain_headers(self, access_token: str) -> dict:
        return {"Accept": "application/json", "Content-Type": "application/json", "access-token": access_token, "client-id": settings.dhan_client_id}

    def _throttle_option_chain_call(self) -> None:
        with self._option_chain_lock:
            wait = MIN_OPTION_CHAIN_CALL_INTERVAL_SECONDS - (time.monotonic() - self._last_option_chain_call_at)
            if wait > MAX_THROTTLE_WAIT_SECONDS:
                raise RuntimeError(f"Dhan option-chain queue is backed up ({wait:.1f}s wait) - try again shortly")
            if wait > 0:
                time.sleep(wait)
            self._last_option_chain_call_at = time.monotonic()

    def get_expiry_list(self, symbol: str) -> Optional[list[str]]:
        """Every active option expiry date (YYYY-MM-DD) for `symbol` (e.g.
        "NIFTY") - None if `symbol` doesn't resolve on this provider."""
        target = self.resolve_feed_target(symbol)
        if target is None:
            return None
        segment_key, security_id = target

        access_token = current_access_token()
        if not settings.dhan_client_id or not access_token:
            raise RuntimeError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are not configured")

        self._throttle_option_chain_call()
        resp = requests.post(
            OPTION_EXPIRY_LIST_URL,
            headers=self._option_chain_headers(access_token),
            json={"UnderlyingScrip": int(security_id), "UnderlyingSeg": segment_key},
            timeout=15,
        )
        if resp.status_code == 401:
            raise RuntimeError("Dhan API rejected the access token (401) - it may need to be regenerated")
        if resp.status_code == 429:
            raise RuntimeError("Dhan API rate limit hit (429) on optionchain/expirylist - retry shortly")
        try:
            resp.raise_for_status()
        except requests.exceptions.HTTPError as exc:
            raise RuntimeError(f"Dhan API error ({resp.status_code}): {resp.text[:200]}") from exc

        return resp.json().get("data", [])

    def _cached_option_chain(self, symbol: str, expiry: str) -> Optional[OptionChain]:
        with self._option_chain_cache_lock:
            cached = self._option_chain_cache.get((symbol, expiry))
        if cached is None:
            return None
        chain, fetched_at = cached
        if (time.monotonic() - fetched_at) >= OPTION_CHAIN_CACHE_TTL_SECONDS:
            return None
        return chain

    def _store_option_chain(self, symbol: str, expiry: str, chain: OptionChain) -> None:
        with self._option_chain_cache_lock:
            self._option_chain_cache[(symbol, expiry)] = (chain, time.monotonic())

    @staticmethod
    def _parse_option_leg(raw: Optional[dict], strike: float, spot: float, option_type: str, strike_step: float) -> Optional[OptionLegQuote]:
        if raw is None:
            return None
        greeks = raw.get("greeks") or {}
        return OptionLegQuote(
            security_id=str(raw["security_id"]),
            last_price=raw["last_price"],
            oi=raw["oi"],
            previous_oi=raw["previous_oi"],
            volume=raw["volume"],
            implied_volatility=raw["implied_volatility"],
            top_bid_price=raw["top_bid_price"],
            top_ask_price=raw["top_ask_price"],
            greeks=OptionGreeks(delta=greeks["delta"], theta=greeks["theta"], gamma=greeks["gamma"], vega=greeks["vega"]),
            moneyness=classify_moneyness(strike, spot, option_type, strike_step),
        )

    def get_option_chain(self, symbol: str, expiry: str) -> Optional[OptionChain]:
        """Full option chain for `symbol` (e.g. "NIFTY") at `expiry`
        (YYYY-MM-DD, from get_expiry_list) - OI/Greeks/IV/bid-ask per
        strike, each leg's ITM/ATM/OTM classification computed via
        app/domain/moneyness.py. None if `symbol` doesn't resolve on this
        provider. Self-throttled to Dhan's documented 1-request-per-3s
        limit and short-cached (OPTION_CHAIN_CACHE_TTL_SECONDS)."""
        cached = self._cached_option_chain(symbol, expiry)
        if cached is not None:
            return cached

        target = self.resolve_feed_target(symbol)
        if target is None:
            return None
        segment_key, security_id = target
        config = self._config_for(symbol)

        access_token = current_access_token()
        if not settings.dhan_client_id or not access_token:
            raise RuntimeError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN are not configured")

        self._throttle_option_chain_call()
        resp = requests.post(
            OPTION_CHAIN_URL,
            headers=self._option_chain_headers(access_token),
            json={"UnderlyingScrip": int(security_id), "UnderlyingSeg": segment_key, "Expiry": expiry},
            timeout=15,
        )
        if resp.status_code == 401:
            raise RuntimeError("Dhan API rejected the access token (401) - it may need to be regenerated")
        if resp.status_code == 429:
            raise RuntimeError("Dhan API rate limit hit (429) on optionchain - retry shortly")
        try:
            resp.raise_for_status()
        except requests.exceptions.HTTPError as exc:
            raise RuntimeError(f"Dhan API error ({resp.status_code}): {resp.text[:200]}") from exc

        data = resp.json().get("data", {})
        spot = data.get("last_price", 0.0)
        raw_strikes = data.get("oc", {})
        strike_prices = [float(s) for s in raw_strikes]
        strike_step = infer_strike_step(strike_prices) if len(strike_prices) >= 2 else 1.0

        strikes = [
            OptionChainStrike(
                strike=float(strike_str),
                ce=self._parse_option_leg(raw.get("ce"), float(strike_str), spot, "CE", strike_step),
                pe=self._parse_option_leg(raw.get("pe"), float(strike_str), spot, "PE", strike_step),
            )
            for strike_str, raw in sorted(raw_strikes.items(), key=lambda item: float(item[0]))
        ]

        chain = OptionChain(
            underlying_symbol=symbol,
            underlying_exchange=config.exchange,
            expiry=expiry,
            underlying_last_price=spot,
            strikes=strikes,
        )
        self._store_option_chain(symbol, expiry, chain)
        return chain
