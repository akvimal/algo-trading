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
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

import requests

from app.config import settings
from app.domain.candle_aggregation import aggregate_candles, resolve_interval_minutes
from app.domain.models import Candle, ResolvedUnderlying
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


class DeltaProvider(QuoteProvider):
    def __init__(self, name: str = "delta-india") -> None:
        self.name = name

        self._lock = threading.Lock()
        self._symbol_to_product_id: dict[str, int] = {}
        self._symbol_to_state: dict[str, str] = {}
        self._last_synced_at: Optional[datetime] = None

        self._quote_cache: dict[str, tuple[float, float]] = {}
        self._quote_cache_lock = threading.Lock()
        self._ticker_lock = threading.Lock()
        self._last_ticker_call_at: float = 0.0

        self._candle_lock = threading.Lock()
        self._last_candle_call_at: float = 0.0
        self._candle_cache: dict[tuple[str, str], tuple[Candle, float]] = {}
        self._candle_cache_lock = threading.Lock()

    def status(self) -> dict:
        return {
            "provider": self.name,
            "symbol_count": len(self._symbol_to_product_id),
            "last_synced_at": self._last_synced_at.isoformat() if self._last_synced_at else None,
        }

    def sync_instruments(self) -> dict:
        """Paginates GET /v2/products (perpetual futures only - options
        are Phase 2) via Delta's cursor-based meta.after, not page
        numbers - confirmed live that meta.after is absent/falsy once
        the last page is reached."""
        logger.info("syncing Delta Exchange instrument list (%s)", self.name)
        symbol_to_id: dict[str, int] = {}
        symbol_to_state: dict[str, str] = {}

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
            cursor = (data.get("meta") or {}).get("after")
            if not cursor:
                break

        with self._lock:
            self._symbol_to_product_id = symbol_to_id
            self._symbol_to_state = symbol_to_state
            self._last_synced_at = datetime.now(timezone.utc)

        logger.info("Delta instrument sync complete (%s): %d symbols", self.name, len(symbol_to_id))
        return self.status()

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
            lot_size=1,
            expiry=None,
        )

    def get_lot_size(self, symbol: str) -> Optional[int]:
        """Always 1 - Delta perpetuals size in whole contracts directly,
        no separate lot-multiplier concept the way NSE/MCX F&O has."""
        if not self._symbol_to_product_id:
            self.sync_instruments()
        if symbol not in self._symbol_to_product_id:
            return None
        return 1

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

    def get_ltp_batch(self, symbols: list[str]) -> dict[str, float]:
        """Delta's /v2/tickers ignores a `symbols=` filter (confirmed
        live - it returns every product regardless), so the batching
        strategy is one contract_types=perpetual_futures call (~220 rows
        today) filtered to the requested symbols in memory - still just
        one provider call regardless of how many symbols are asked for,
        same goal DhanProvider.get_ltp_batch has via a different
        mechanism."""
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

        self._store_quotes(fresh)
        result.update(fresh)
        return result

    def _fetch_native_candles(
        self, symbol: str, interval: str, interval_minutes: int, from_dt: datetime, to_dt: datetime
    ) -> list[Candle]:
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
