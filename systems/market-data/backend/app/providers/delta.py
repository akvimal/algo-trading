"""Delta Exchange India provider - CRYPTO segment, Phase 1 of the crypto
module (see docs/architecture.md). Every endpoint used here is public -
no api-key/signature needed (Delta's HMAC auth scheme only gates order
placement/wallet/positions, none of which this paper-trading platform
ever calls) - so unlike app/providers/dhan.py, there's no credential/
token-renewal state here at all.

Base URL, the products/candles/tickers response shapes, and the
pagination cursor behavior were all confirmed directly against the live
API rather than docs.delta.exchange (a JS-rendered SPA that scrapes
poorly) - see docs/architecture.md for the verification note. A crypto
perpetual future has no expiry/rollover at all (unlike MCX commodity
futures or NSE index futures) - chart_symbol == trade_symbol == the
perpetual's own symbol, permanently, so this provider needs none of
DhanProvider's active-contract-resolution machinery.
"""

import logging
import re
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

import requests

from app.config import settings
from app.domain.candle_aggregation import aggregate_candles, resolve_interval_minutes
from app.domain.models import (
    Candle,
    DataAvailability,
    OptionChain,
    OptionChainStrike,
    OptionGreeks,
    OptionLegQuote,
    ResolvedUnderlying,
)
from app.domain.moneyness import classify_moneyness, infer_strike_step
from app.providers.base import QuoteProvider

logger = logging.getLogger(__name__)

# Confirmed live for symbol=BTCUSD, resolution=1m/5m/15m/30m/1h - no
# native 25min the way Dhan has, so a "25min" request is locally
# aggregated from 1m the same way Dhan's own non-native intervals are
# (see app/domain/candle_aggregation.py).
DELTA_CANDLE_INTERVAL_MINUTES = {"1min": 1, "5min": 5, "15min": 15, "30min": 30, "60min": 60}
_RESOLUTION_BY_MINUTES = {1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "1h"}

# Delta doesn't publish a rate limit for these public endpoints (unlike
# Dhan's documented/empirical ones) - conservative defaults, same "no
# known requirement, err on the side of not hammering it" spirit as
# Dhan's own undocumented-endpoint throttles.
MIN_CANDLE_CALL_INTERVAL_SECONDS = 1.0
MIN_TICKER_CALL_INTERVAL_SECONDS = 1.0
MAX_THROTTLE_WAIT_SECONDS = 4.0
QUOTE_CACHE_TTL_SECONDS = 3.0

# get_data_availability's live probe (see below) - Delta publishes no
# retention policy, and live testing (2026-08-16) found BTCUSD 60min data
# starting around early Feb 2024 (~2.5 years back) with a wide single
# request otherwise silently truncating to the most recent ~4000 bars
# rather than erroring, unlike Dhan's hard per-call day cap. The upper
# bound just needs to comfortably exceed the real floor, with room for it
# to keep growing - it does NOT claim data exists that far back.
AVAILABILITY_PROBE_UPPER_BOUND_DAYS = 1460
AVAILABILITY_PROBE_WINDOW_DAYS = 3
AVAILABILITY_CACHE_TTL_SECONDS = 6 * 3600

# get_candle_history's own defense against the same silent-truncation
# behavior noted above - confirmed live 2026-08-16 that the real cap
# varies a little by resolution (~3600-4000 rows observed, not one clean
# documented number), so this stays safely under that rather than trying
# to detect/react to truncation after the fact (nothing in the response
# distinguishes "truncated" from "genuinely that few rows exist" - both
# come back as `success: true`). A request needing more than this many
# candles is split into consecutive chunks (see _fetch_native_candles)
# and concatenated - each chunk still goes through the same self-throttle
# as any other call, so a wide backtest just takes longer, not wrong.
DELTA_MAX_CANDLES_PER_REQUEST = 2000

# Own lock/timestamp/cache, distinct from the candle/ticker throttles
# above - a different Dhan-style "own state per distinct endpoint"
# convention, even though this hits the same /v2/tickers URL the LTP
# batching does (a different query shape - contract_types=call_options,
# put_options - so no reason to serialize behind spot/perpetual quoting).
MIN_OPTION_CALL_INTERVAL_SECONDS = 1.0
# 30s, not a QUOTE_CACHE_TTL_SECONDS-style few-second value: this backs
# BOTH get_expiry_list and get_option_chain (see _fetch_option_rows),
# called synchronously from signal-processing's option-strategy
# resolution on every incoming signal - a short TTL meant a near-guaranteed
# cache miss (and therefore a full throttle-wait + live Delta round trip)
# on every single resolution, which could exceed the caller's own
# request timeout under any throttle contention. Expiry lists and strike
# structure don't meaningfully change within 30s; only OI/last-traded-price
# fields inside a cached chain go stale, and those aren't what position
# entry price is sourced from (execution fetches a fresh LTP at open time
# instead - see docs/architecture.md).
OPTION_CHAIN_CACHE_TTL_SECONDS = 30.0

# Delta's own option symbol format, confirmed live: "C-BTC-61600-150826"
# (Call, BTC, strike 61600, expiry 15-Aug-2026) / "P-..." for puts. This
# is the ONLY place expiry appears in the /v2/tickers response at all -
# there's no settlement_time field on a ticker (confirmed live), unlike
# the /v2/products response, which does have one.
_OPTION_SYMBOL_RE = re.compile(r"^([CP])-([A-Z0-9]+)-(\d+(?:\.\d+)?)-(\d{2})(\d{2})(\d{2})$")


def _parse_option_symbol(symbol: str) -> Optional[tuple[str, float, str]]:
    """(option_type, strike, expiry) from Delta's own option symbol -
    ('CE'|'PE', float, 'YYYY-MM-DD') - or None if `symbol` doesn't match
    the expected shape (e.g. a perpetual future's own symbol, which
    shares the same /v2/tickers response when contract_types isn't
    filtered narrowly enough - defensive, not expected to actually
    happen given how this is called). Pure, directly unit-testable."""
    match = _OPTION_SYMBOL_RE.match(symbol)
    if not match:
        return None
    side, _underlying, strike_str, dd, mm, yy = match.groups()
    option_type = "CE" if side == "C" else "PE"
    try:
        expiry = date(2000 + int(yy), int(mm), int(dd)).isoformat()
    except ValueError:
        return None
    return option_type, float(strike_str), expiry


class DeltaProvider(QuoteProvider):
    def __init__(self, name: str = "delta-india") -> None:
        self.name = name

        self._lock = threading.Lock()
        self._symbol_to_product_id: dict[str, int] = {}
        self._symbol_to_state: dict[str, str] = {}
        # A perpetual's own underlying asset symbol (e.g. "BTCUSD" ->
        # "BTC") - Delta's option products are keyed by this, not by the
        # perpetual's own symbol. Captured for free during the same sync
        # pass, used by get_expiry_list/get_option_chain (Phase 2 of the
        # crypto module, see docs/architecture.md).
        self._symbol_to_underlying_asset: dict[str, str] = {}
        # Delta's real per-contract multiplier in underlying-asset units
        # (e.g. BTCUSD -> 0.001 BTC/lot, ETHUSD -> 0.01 ETH/lot) - varies
        # wildly by symbol (confirmed live against /v2/products, values
        # from 0.001 to 10000 across the product list), so this is NOT a
        # platform-wide constant the way NSE/MCX's own lot sizes are
        # per-instrument but at least always >= 1. get_lot_size() below
        # returns this instead of a hardcoded 1 for perpetuals.
        self._symbol_to_contract_value: dict[str, float] = {}
        self._last_synced_at: Optional[datetime] = None

        self._quote_cache: dict[str, tuple[float, float]] = {}
        self._quote_cache_lock = threading.Lock()
        self._ticker_lock = threading.Lock()
        self._last_ticker_call_at: float = 0.0

        self._candle_lock = threading.Lock()
        self._last_candle_call_at: float = 0.0
        self._candle_cache: dict[tuple[str, str], tuple[Candle, float]] = {}
        self._candle_cache_lock = threading.Lock()

        self._availability_cache: dict[tuple[str, str], tuple[DataAvailability, float]] = {}
        self._availability_cache_lock = threading.Lock()

        self._option_lock = threading.Lock()
        self._last_option_call_at: float = 0.0
        self._option_chain_cache: dict[str, tuple[list[dict], float]] = {}
        self._option_chain_cache_lock = threading.Lock()

    def status(self) -> dict:
        return {
            "provider": self.name,
            "symbol_count": len(self._symbol_to_product_id),
            "last_synced_at": self._last_synced_at.isoformat() if self._last_synced_at else None,
        }

    def sync_instruments(self) -> dict:
        """Paginates GET /v2/products (perpetual futures only - options
        products aren't synced here at all, see get_expiry_list/
        get_option_chain below, which fetch option data live via
        /v2/tickers instead) via Delta's cursor-based meta.after, not
        page numbers - confirmed live that meta.after is absent/falsy
        once the last page is reached."""
        logger.info("syncing Delta Exchange instrument list (%s)", self.name)
        symbol_to_id: dict[str, int] = {}
        symbol_to_state: dict[str, str] = {}
        symbol_to_underlying_asset: dict[str, str] = {}
        symbol_to_contract_value: dict[str, float] = {}

        cursor: Optional[str] = None
        while True:
            params = {"contract_types": "perpetual_futures", "states": "live", "page_size": 100}
            if cursor:
                params["after"] = cursor
            resp = requests.get(f"{settings.delta_base_url}/v2/products", params=params, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            rows = data.get("result") or []
            if not rows:
                break
            for row in rows:
                symbol_to_id[row["symbol"]] = row["id"]
                symbol_to_state[row["symbol"]] = row["state"]
                underlying_symbol = (row.get("underlying_asset") or {}).get("symbol")
                if underlying_symbol:
                    symbol_to_underlying_asset[row["symbol"]] = underlying_symbol
                contract_value = row.get("contract_value")
                if contract_value is not None:
                    symbol_to_contract_value[row["symbol"]] = float(contract_value)
            cursor = (data.get("meta") or {}).get("after")
            if not cursor:
                break

        with self._lock:
            self._symbol_to_product_id = symbol_to_id
            self._symbol_to_state = symbol_to_state
            self._symbol_to_underlying_asset = symbol_to_underlying_asset
            self._symbol_to_contract_value = symbol_to_contract_value
            self._last_synced_at = datetime.now(timezone.utc)

        logger.info("Delta instrument sync complete (%s): %d symbols", self.name, len(symbol_to_id))
        return self.status()

    def list_live_symbols(self) -> list[str]:
        """Every currently-live perpetual future symbol (e.g. "BTCUSD",
        "ETHUSD") - not part of the QuoteProvider abstract base (Delta-only
        concern, backs a CRYPTO-specific symbol picker on the frontend
        rather than a generic cross-provider one - NSE/MCX symbols are
        already well-known and typed directly). Sorted for a stable,
        readable dropdown order."""
        if not self._symbol_to_product_id:
            self.sync_instruments()
        return sorted(sym for sym, state in self._symbol_to_state.items() if state == "live")

    def _underlying_asset_symbol(self, symbol: str) -> Optional[str]:
        if not self._symbol_to_product_id:
            self.sync_instruments()
        return self._symbol_to_underlying_asset.get(symbol)

    def resolve_underlying(self, underlying: str) -> Optional[ResolvedUnderlying]:
        """A perpetual has no separate spot/rollover concept - chart and
        trade the same symbol, forever. None if `underlying` isn't a
        live perpetual's own symbol."""
        if not self._symbol_to_product_id:
            self.sync_instruments()
        if self._symbol_to_state.get(underlying) != "live":
            return None
        return ResolvedUnderlying(
            chart_symbol=underlying,
            chart_exchange="CRYPTO",
            trade_symbol=underlying,
            trade_exchange="CRYPTO",
            lot_size=self._symbol_to_contract_value.get(underlying, 1.0),
            expiry=None,
        )

    def get_lot_size(self, symbol: str) -> Optional[float]:
        """Options still return 1 - naked/spread legs are priced and sized
        directly per Delta's own option premium quotes, no separate
        contract_value concept observed there (unlike perpetuals - see
        below). An option's own symbol is never in _symbol_to_product_id
        (that dict is only populated by sync_instruments()'s
        perpetuals-only sync - option data is fetched live per-underlying-
        asset, see _fetch_option_rows, never persisted into a sync-time
        dict) - checked via _OPTION_SYMBOL_RE first, same shape-detection
        get_ltp_batch uses, before falling back to the perpetual lookup.

        Perpetuals return Delta's real contract_value (confirmed live
        against /v2/products - e.g. BTCUSD=0.001, ETHUSD=0.01, varies per
        symbol, some as large as 10000) instead of a hardcoded 1 - a
        "quantity" from compute_quantity/compute_risk_based_quantity
        (execution) is lots * this value, in underlying-asset units, same
        as Delta's own "Funds req." calculation."""
        if _OPTION_SYMBOL_RE.match(symbol):
            return 1
        if not self._symbol_to_product_id:
            self.sync_instruments()
        if symbol not in self._symbol_to_product_id:
            return None
        return self._symbol_to_contract_value.get(symbol, 1.0)

    def resolve_symbol_by_security_id(self, security_id: str) -> Optional[str]:
        """Crypto module Phase 4 (see docs/architecture.md) - execution's
        option_position_manager.py calls this once per leg, at position-
        open time, to translate a resolved order's security_id (Delta's
        own product_id, a stringified int - see OptionLegQuote.security_id)
        into a tradeable symbol. Unlike DhanProvider's version (a reverse
        lookup into a sync-time-populated dict), this is a single direct
        GET /v2/products/{id} call - confirmed live it resolves BOTH
        perpetuals and options by numeric product_id (e.g. id 27 ->
        "BTCUSD", a real option id -> "P-BTC-85000-280826"), so no local
        product_id->symbol map needs building/maintaining (option data
        isn't part of sync_instruments()'s perpetuals-only sync at all -
        see _fetch_option_rows). None if `security_id` isn't a real
        product_id, or the request fails to resolve."""
        resp = requests.get(f"{settings.delta_base_url}/v2/products/{security_id}", timeout=15)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            return None
        return (data.get("result") or {}).get("symbol")

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
            raise ValueError(f"no LTP available for '{symbol}' - unknown symbol or Delta omitted it")
        return result[symbol]

    def _fetch_perpetual_quotes(self, pending: set[str]) -> dict[str, float]:
        """The original get_ltp_batch body, unchanged - Delta's /v2/tickers
        ignores a `symbols=` filter (confirmed live - it returns every
        product regardless), so the batching strategy is one
        contract_types=perpetual_futures call (~220 rows today) filtered
        to the requested symbols in memory - still just one provider call
        regardless of how many symbols are asked for, same goal
        DhanProvider.get_ltp_batch has via a different mechanism."""
        with self._ticker_lock:
            wait = MIN_TICKER_CALL_INTERVAL_SECONDS - (time.monotonic() - self._last_ticker_call_at)
            if wait > MAX_THROTTLE_WAIT_SECONDS:
                raise RuntimeError(f"Delta ticker queue is backed up ({wait:.1f}s wait) - try again shortly")
            if wait > 0:
                time.sleep(wait)
            self._last_ticker_call_at = time.monotonic()

        resp = requests.get(
            f"{settings.delta_base_url}/v2/tickers", params={"contract_types": "perpetual_futures"}, timeout=15
        )
        resp.raise_for_status()
        rows = resp.json().get("result") or []

        fresh: dict[str, float] = {}
        for row in rows:
            symbol = row.get("symbol")
            if symbol in pending and row.get("close") is not None:
                fresh[symbol] = float(row["close"])
        return fresh

    def _fetch_option_quotes(self, pending: set[str]) -> dict[str, float]:
        """Crypto module Phase 4 (see docs/architecture.md) - an option's
        own symbol never appears in the perpetual-only ticker call above,
        so option legs need their own path. An option symbol already
        encodes its underlying asset (_OPTION_SYMBOL_RE's 2nd group, e.g.
        "BTC" from "P-BTC-85000-280826") - grouping requested option
        symbols by that and reusing the already-cached
        _fetch_option_rows(underlying_asset) (Phase 2) avoids a new Delta
        endpoint entirely, same "one bulk call covers everything" pattern
        get_option_chain already established, just consumed for LTP
        instead of the chain."""
        underlying_assets: set[str] = set()
        for symbol in pending:
            match = _OPTION_SYMBOL_RE.match(symbol)
            if match:
                underlying_assets.add(match.group(2))

        fresh: dict[str, float] = {}
        for underlying_asset in underlying_assets:
            for row in self._fetch_option_rows(underlying_asset):
                symbol = row.get("symbol")
                if symbol in pending and row.get("close") is not None:
                    fresh[symbol] = float(row["close"])
        return fresh

    def get_ltp_batch(self, symbols: list[str]) -> dict[str, float]:
        """Batches a mix of perpetual and option symbols - see
        _fetch_perpetual_quotes/_fetch_option_quotes for how each half is
        actually fetched. A pending symbol matching neither shape (unknown
        symbol) is simply absent from the result, same as an unresolvable
        one always was."""
        if not symbols:
            return {}

        result: dict[str, float] = {}
        pending = set()
        for symbol in symbols:
            cached = self._cached_quote(symbol)
            if cached is not None:
                result[symbol] = cached
            else:
                pending.add(symbol)

        if not pending:
            return result

        pending_options = {s for s in pending if _OPTION_SYMBOL_RE.match(s)}
        pending_perpetuals = pending - pending_options

        fresh: dict[str, float] = {}
        if pending_perpetuals:
            fresh.update(self._fetch_perpetual_quotes(pending_perpetuals))
        if pending_options:
            fresh.update(self._fetch_option_quotes(pending_options))

        self._store_quotes(fresh)
        result.update(fresh)
        return result

    def _fetch_native_candles(
        self, symbol: str, interval: str, interval_minutes: int, from_dt: datetime, to_dt: datetime
    ) -> list[Candle]:
        """Splits into consecutive DELTA_MAX_CANDLES_PER_REQUEST-sized
        chunks first, so a wide backtest range never risks the silent
        per-request truncation _fetch_native_candles_page's own docstring
        describes - each chunk is small enough to stay under it. Chunk
        boundaries are exclusive-of-next-chunk-start (chunk_end computed
        as one interval before the next chunk_start) so no candle is
        requested twice."""
        max_span = timedelta(minutes=interval_minutes * DELTA_MAX_CANDLES_PER_REQUEST)
        if to_dt - from_dt <= max_span:
            return self._fetch_native_candles_page(symbol, interval, interval_minutes, from_dt, to_dt)

        candles: list[Candle] = []
        chunk_start = from_dt
        interval_delta = timedelta(minutes=interval_minutes)
        while chunk_start <= to_dt:
            chunk_end = min(chunk_start + max_span - interval_delta, to_dt)
            candles.extend(self._fetch_native_candles_page(symbol, interval, interval_minutes, chunk_start, chunk_end))
            chunk_start = chunk_end + interval_delta
        return candles

    def _fetch_native_candles_page(
        self, symbol: str, interval: str, interval_minutes: int, from_dt: datetime, to_dt: datetime
    ) -> list[Candle]:
        """The actual single HTTP call - Delta's /v2/history/candles
        silently truncates to its own internal row cap rather than
        erroring or paginating when [from_dt, to_dt] needs more candles
        than that (confirmed live 2026-08-16 - returns `success: true`
        with just the most recent rows, nothing distinguishing that from
        "genuinely this few exist") - see DELTA_MAX_CANDLES_PER_REQUEST's
        own comment and _fetch_native_candles, which chunks around this
        rather than calling this directly for a wide range."""
        resolution = _RESOLUTION_BY_MINUTES[interval_minutes]

        with self._candle_lock:
            wait = MIN_CANDLE_CALL_INTERVAL_SECONDS - (time.monotonic() - self._last_candle_call_at)
            if wait > MAX_THROTTLE_WAIT_SECONDS:
                raise RuntimeError(f"Delta candle queue is backed up ({wait:.1f}s wait) - try again shortly")
            if wait > 0:
                time.sleep(wait)
            self._last_candle_call_at = time.monotonic()

        resp = requests.get(
            f"{settings.delta_base_url}/v2/history/candles",
            params={
                "symbol": symbol,
                "resolution": resolution,
                "start": int(from_dt.timestamp()),
                "end": int(to_dt.timestamp()),
            },
            timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json().get("result") or []

        tz = ZoneInfo(settings.timezone)
        now_epoch = datetime.now(timezone.utc).timestamp()
        interval_seconds = interval_minutes * 60
        # Crypto trades 24/7 so there's no "still forming" ambiguity from
        # a session boundary - only genuinely incomplete trailing bars
        # (whose own interval hasn't elapsed yet) are excluded, same rule
        # Dhan's own _fetch_native_candles applies.
        candles = [
            Candle(
                exchange="CRYPTO",
                symbol=symbol,
                interval=interval,
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                timestamp=datetime.fromtimestamp(row["time"], tz=tz).isoformat(),
                provider=self.name,
            )
            for row in rows
            if row["time"] + interval_seconds <= now_epoch
        ]
        # Delta returns newest-first (confirmed live) - this codebase's
        # Candle convention is oldest-first everywhere else.
        candles.sort(key=lambda c: c.timestamp)
        return candles

    def _fetch_candles(self, symbol: str, interval: str, from_dt: datetime, to_dt: datetime) -> list[Candle]:
        minutes = resolve_interval_minutes(interval, DELTA_CANDLE_INTERVAL_MINUTES)
        if interval in DELTA_CANDLE_INTERVAL_MINUTES:
            return self._fetch_native_candles(symbol, interval, minutes, from_dt, to_dt)
        one_min_candles = self._fetch_native_candles(symbol, "1min", 1, from_dt, to_dt)
        return aggregate_candles(one_min_candles, interval, minutes)

    def _cached_candle(self, symbol: str, interval: str) -> Optional[Candle]:
        with self._candle_cache_lock:
            cached = self._candle_cache.get((symbol, interval))
        if cached is None:
            return None
        candle, fetched_at = cached
        if (time.monotonic() - fetched_at) >= resolve_interval_minutes(interval, DELTA_CANDLE_INTERVAL_MINUTES) * 60:
            return None
        return candle

    def _store_candle(self, symbol: str, interval: str, candle: Candle) -> None:
        with self._candle_cache_lock:
            self._candle_cache[(symbol, interval)] = (candle, time.monotonic())

    def get_previous_candle(self, symbol: str, interval: str) -> Optional[Candle]:
        resolve_interval_minutes(interval, DELTA_CANDLE_INTERVAL_MINUTES)  # raises ValueError for a malformed interval

        cached = self._cached_candle(symbol, interval)
        if cached is not None:
            return cached

        tz = ZoneInfo(settings.timezone)
        now = datetime.now(tz)
        candles = self._fetch_candles(symbol, interval, now - timedelta(hours=6), now)
        if not candles:
            return None

        candle = candles[-1]
        self._store_candle(symbol, interval, candle)
        return candle

    def get_candle_history(self, symbol: str, interval: str, from_date: date, to_date: date) -> list[Candle]:
        resolve_interval_minutes(interval, DELTA_CANDLE_INTERVAL_MINUTES)  # raises ValueError for a malformed interval

        tz = ZoneInfo(settings.timezone)
        from_dt = datetime.combine(from_date, datetime.min.time(), tzinfo=tz)
        to_dt = datetime.combine(to_date, datetime.max.time().replace(microsecond=0), tzinfo=tz)
        return self._fetch_candles(symbol, interval, from_dt, to_dt)

    def get_data_availability(self, symbol: str, interval: str) -> DataAvailability:
        """Unlike Dhan's fixed per-request cap, Delta's real constraint is
        how far back it actually has data - a genuinely moving quantity
        (see AVAILABILITY_PROBE_UPPER_BOUND_DAYS above), so this is a real
        live probe, cached for AVAILABILITY_CACHE_TTL_SECONDS rather than
        hardcoded."""
        resolve_interval_minutes(interval, DELTA_CANDLE_INTERVAL_MINUTES)  # raises ValueError for a malformed interval

        with self._availability_cache_lock:
            cached = self._availability_cache.get((symbol, interval))
        if cached is not None:
            result, fetched_at = cached
            if (time.monotonic() - fetched_at) < AVAILABILITY_CACHE_TTL_SECONDS:
                return result

        earliest = self._probe_earliest_available_date(symbol, interval)
        note = (
            f"Delta Exchange India's history for {symbol} appears to start around {earliest.isoformat()} - "
            "checked live just now and cached for a few hours, not a fixed limit like Dhan's."
            if earliest is not None
            else f"Could not find any historical data for {symbol}/{interval} in the last "
            f"{AVAILABILITY_PROBE_UPPER_BOUND_DAYS} days - check the symbol is a real, currently-listed perpetual."
        )
        result = DataAvailability(
            exchange="CRYPTO",
            symbol=symbol,
            interval=interval,
            max_days_per_request=None,
            earliest_available_date=earliest.isoformat() if earliest is not None else None,
            note=note,
        )
        with self._availability_cache_lock:
            self._availability_cache[(symbol, interval)] = (result, time.monotonic())
        return result

    def _probe_earliest_available_date(self, symbol: str, interval: str) -> Optional[date]:
        """Binary search over days-back for the earliest point Delta
        actually returns candles for a narrow (AVAILABILITY_PROBE_WINDOW_DAYS)
        window. lo=0 (today) is checked first and assumed reachable for any
        real, currently-listed symbol; if even that's empty, gives up
        rather than searching a dead symbol. ~11 probe calls to converge
        on day precision, ~1s apart (MIN_CANDLE_CALL_INTERVAL_SECONDS's
        own throttle) - a few seconds for a cold cache entry, acceptable
        given the result is then cached for AVAILABILITY_CACHE_TTL_SECONDS."""
        tz = ZoneInfo(settings.timezone)

        def has_data(days_back: int) -> bool:
            end = datetime.now(tz) - timedelta(days=days_back)
            start = end - timedelta(days=AVAILABILITY_PROBE_WINDOW_DAYS)
            return len(self._fetch_candles(symbol, interval, start, end)) > 0

        if not has_data(0):
            return None

        lo, hi = 0, AVAILABILITY_PROBE_UPPER_BOUND_DAYS
        while hi - lo > AVAILABILITY_PROBE_WINDOW_DAYS:
            mid = (lo + hi) // 2
            if has_data(mid):
                lo = mid
            else:
                hi = mid

        return (datetime.now(tz) - timedelta(days=lo)).date()

    def _cached_option_rows(self, underlying_asset: str) -> Optional[list[dict]]:
        with self._option_chain_cache_lock:
            cached = self._option_chain_cache.get(underlying_asset)
        if cached is None:
            return None
        rows, fetched_at = cached
        if (time.monotonic() - fetched_at) >= OPTION_CHAIN_CACHE_TTL_SECONDS:
            return None
        return rows

    def _fetch_option_rows(self, underlying_asset: str) -> list[dict]:
        """One call covers every live expiry at once (confirmed live -
        395 BTC contracts across 7 expiries in a single response), shared
        by get_expiry_list and get_option_chain below - cached per
        underlying asset (not (symbol, expiry) the way Dhan's chain is,
        since there's no per-expiry request to make here at all)."""
        cached = self._cached_option_rows(underlying_asset)
        if cached is not None:
            return cached

        with self._option_lock:
            wait = MIN_OPTION_CALL_INTERVAL_SECONDS - (time.monotonic() - self._last_option_call_at)
            if wait > MAX_THROTTLE_WAIT_SECONDS:
                raise RuntimeError(f"Delta option queue is backed up ({wait:.1f}s wait) - try again shortly")
            if wait > 0:
                time.sleep(wait)
            self._last_option_call_at = time.monotonic()

        resp = requests.get(
            f"{settings.delta_base_url}/v2/tickers",
            params={"contract_types": "call_options,put_options", "underlying_asset_symbols": underlying_asset},
            timeout=15,
        )
        resp.raise_for_status()
        rows = resp.json().get("result") or []

        with self._option_chain_cache_lock:
            self._option_chain_cache[underlying_asset] = (rows, time.monotonic())
        return rows

    def get_expiry_list(self, symbol: str) -> Optional[list[str]]:
        """Every live expiry date (YYYY-MM-DD) for `symbol` (a perpetual's
        own symbol, e.g. "BTCUSD") - None if `symbol` isn't a known
        perpetual. Parsed from the option symbols themselves (see
        _parse_option_symbol) - there's no dedicated expiry-list endpoint
        the way Dhan has, and no separate call is needed since
        _fetch_option_rows already covers every expiry."""
        underlying_asset = self._underlying_asset_symbol(symbol)
        if underlying_asset is None:
            return None

        rows = self._fetch_option_rows(underlying_asset)
        expiries = set()
        for row in rows:
            parsed = _parse_option_symbol(row.get("symbol", ""))
            if parsed is not None:
                expiries.add(parsed[2])
        return sorted(expiries)

    def get_option_chain(self, symbol: str, expiry: str) -> Optional[OptionChain]:
        """Full option chain for `symbol` (e.g. "BTCUSD") at `expiry`
        (YYYY-MM-DD, from get_expiry_list) - OI/Greeks/IV/bid-ask per
        strike, each leg's ITM/ATM/OTM classification computed via
        app/domain/moneyness.py, identical reuse to DhanProvider's own
        get_option_chain. None only if `symbol` isn't a known perpetual,
        or the underlying has no live options at all - if it resolves but
        nothing matches `expiry` specifically, returns a chain with
        strikes=[] rather than None (still a real, resolvable market,
        just empty at that date); underlying_last_price is taken from any
        available row's spot_price in that case, a shared reference
        regardless of which expiry it came from."""
        underlying_asset = self._underlying_asset_symbol(symbol)
        if underlying_asset is None:
            return None

        rows = self._fetch_option_rows(underlying_asset)
        if not rows:
            return None

        spot = None
        parsed_rows = []
        for row in rows:
            parsed = _parse_option_symbol(row.get("symbol", ""))
            if parsed is None:
                continue
            if spot is None and row.get("spot_price") is not None:
                spot = float(row["spot_price"])
            if parsed[2] == expiry:
                option_type, strike, _expiry = parsed
                parsed_rows.append((option_type, strike, row))

        if spot is None:
            return None  # no usable rows for this underlying at all

        strike_prices = sorted({strike for _, strike, _ in parsed_rows})
        strike_step = infer_strike_step(strike_prices) if len(strike_prices) >= 2 else 1.0

        by_strike: dict[float, dict[str, OptionLegQuote]] = {}
        for option_type, strike, row in parsed_rows:
            by_strike.setdefault(strike, {})[option_type] = self._parse_option_leg(row, strike, spot, option_type, strike_step)

        strikes = [
            OptionChainStrike(strike=strike, ce=by_strike[strike].get("CE"), pe=by_strike[strike].get("PE"))
            for strike in sorted(by_strike)
        ]

        return OptionChain(
            underlying_symbol=symbol,
            underlying_exchange="CRYPTO",
            expiry=expiry,
            underlying_last_price=spot,
            strikes=strikes,
        )

    @staticmethod
    def _parse_option_leg(row: dict, strike: float, spot: float, option_type: str, strike_step: float) -> OptionLegQuote:
        greeks = row.get("greeks") or {}
        quotes = row.get("quotes") or {}
        rho = greeks.get("rho")
        return OptionLegQuote(
            security_id=str(row["product_id"]),
            last_price=float(row.get("close") or 0.0),
            oi=int(float(row.get("oi_contracts") or 0)),
            previous_oi=None,  # Delta's ticker has no previous-OI figure at all - see OptionLegQuote's own docstring
            volume=float(row.get("volume") or 0.0),
            implied_volatility=float(quotes.get("mark_iv") or 0.0),
            top_bid_price=float(quotes.get("best_bid") or 0.0),
            top_ask_price=float(quotes.get("best_ask") or 0.0),
            greeks=OptionGreeks(
                delta=float(greeks.get("delta") or 0.0),
                theta=float(greeks.get("theta") or 0.0),
                gamma=float(greeks.get("gamma") or 0.0),
                vega=float(greeks.get("vega") or 0.0),
                rho=float(rho) if rho is not None else None,
            ),
            moneyness=classify_moneyness(strike, spot, option_type, strike_step),
        )
