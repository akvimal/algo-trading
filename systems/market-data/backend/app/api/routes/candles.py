import re
import threading
import time
from datetime import date, datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app.adapters.accounts_client import get_user_dhan_credentials
from app.auth import get_optional_user_id
from app.domain.models import Candle, CandleCacheStatus, DataAvailability
from app.providers.router import get_provider

router = APIRouter()

# GET /candles/history is called with the EXACT same (exchange, symbol,
# interval, from, to) repeatedly whenever a caller re-runs a backtest
# after changing only an exit-config knob (stop-loss, target%, entry
# window, ...) - none of those affect what candles get fetched, so
# without this cache every minor tweak re-fetches the whole series from
# the real provider (Dhan/Delta) again, even seconds later. Cached here
# (the route layer), not inside either provider, so one implementation
# covers both - same "cheap to rebuild on restart, no DB" in-memory-only
# philosophy this whole system already uses for its other caches (see its
# README), just extended to a full range instead of one candle. Safe to
# return the cached list as-is: nothing downstream mutates it (FastAPI
# serializes it to JSON per request; every caller parses that into its
# own fresh objects).
#
# Stores both a monotonic fetch time (TTL comparisons - immune to wall-
# clock adjustments) and a wall-clock one (GET /candles/cache-status'
# human-readable fetched_at - monotonic time has no fixed epoch, so it
# can't be rendered as a timestamp).
_history_cache_lock = threading.Lock()
_history_cache: dict[tuple[str, str, str, date, date], tuple[list[Candle], float, datetime]] = {}

# A range ending strictly before today is a genuinely completed, immutable
# series - nothing about it will ever change, so it's safe to cache far
# longer than any live-trailing-edge concern would allow. A range
# reaching up to today can still gain a fresh completed candle every
# `interval`, so that TTL is scoped to the interval itself instead (the
# regex only sizes the cache window - the provider itself is what
# actually validates the interval string, this never rejects one).
_HISTORICAL_RANGE_TTL_SECONDS = 24 * 3600
_INTERVAL_MINUTES_RE = re.compile(r"^(\d+)")


def _history_cache_ttl_seconds(interval: str, to_date: date) -> float:
    if to_date < date.today():
        return _HISTORICAL_RANGE_TTL_SECONDS
    match = _INTERVAL_MINUTES_RE.match(interval)
    minutes = int(match.group(1)) if match else 1440  # "daily" (or anything unparsed) - new bars are rare either way
    return minutes * 60


@router.get("/candles/previous", response_model=Candle)
def get_previous_candle(exchange: str, symbol: str, interval: str, user_id: Optional[UUID] = Depends(get_optional_user_id)):
    """The most recently completed candle only - not a historical range,
    see app/providers/dhan.py get_previous_candle for scope/rationale.
    404 if unavailable (unknown symbol, or no completed candle yet e.g.
    just after market open) - same "not found" semantics as GET
    /quotes/ltp for an unknown symbol. BYO Dhan credentials (Phase 3) -
    see GET /quotes/ltp/batch's own docstring."""
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        credentials = get_user_dhan_credentials(user_id) if user_id else None
        candle = provider.get_previous_candle(symbol, interval, credentials=credentials)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if candle is None:
        raise HTTPException(status_code=404, detail=f"no completed candle available for '{symbol}' at '{interval}' yet")

    return candle


@router.get("/candles/history", response_model=list[Candle])
def get_candle_history(
    exchange: str,
    symbol: str,
    interval: str,
    from_: Optional[date] = Query(default=None, alias="from"),
    to: Optional[date] = None,
    user_id: Optional[UUID] = Depends(get_optional_user_id),
):
    """A general multi-bar series over [from_, to] - used to warm up
    indicator state (signal-generation's RSI/SMA engine) and for
    backtesting, unlike GET /candles/previous which only ever returns
    one value. `from_` (query param `from`) defaults to 7 days back,
    `to` defaults to today, if omitted. Cached per exact (exchange,
    symbol, interval, from_date, to_date) tuple - see
    _history_cache_ttl_seconds for how long. Note: this route-level cache
    isn't credential-aware (a cache hit returns the same candle DATA
    regardless of who fetched it originally, so this is harmless - it
    just means a cache hit never even resolves BYO credentials, which is
    fine since candle values don't depend on whose token fetched them)."""
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    to_date = to or date.today()
    from_date = from_ or date.fromordinal(to_date.toordinal() - 7)

    try:
        credentials = get_user_dhan_credentials(user_id) if user_id else None
        return fetch_candle_history_cached(provider, exchange, symbol, interval, from_date, to_date, credentials)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def fetch_candle_history_cached(provider, exchange, symbol, interval, from_date, to_date, credentials=None) -> list[Candle]:
    """The cached (exchange, symbol, interval, from, to) fetch behind GET
    /candles/history - also reused by GET /order-blocks, which needs the
    same series (usually at a coarser interval than the chart is showing)
    and benefits from the same cache. Takes an already-resolved `provider`
    (the caller owns the unknown-exchange 404); raises ValueError (bad
    interval) / RuntimeError (provider error) for the caller to map. The
    cache isn't credential-aware - see GET /candles/history's docstring."""
    cache_key = (exchange, symbol, interval, from_date, to_date)
    ttl = _history_cache_ttl_seconds(interval, to_date)
    with _history_cache_lock:
        cached = _history_cache.get(cache_key)
    if cached is not None:
        candles, fetched_at, _ = cached
        if (time.monotonic() - fetched_at) < ttl:
            return candles

    candles = provider.get_candle_history(symbol, interval, from_date, to_date, credentials=credentials)
    with _history_cache_lock:
        _history_cache[cache_key] = (candles, time.monotonic(), datetime.now(timezone.utc))
    return candles


@router.get("/candles/cache-status", response_model=CandleCacheStatus)
def get_candle_cache_status(
    exchange: str,
    symbol: str,
    interval: str,
    from_: Optional[date] = Query(default=None, alias="from"),
    to: Optional[date] = None,
):
    """Whether GET /candles/history currently holds a live (not yet TTL-
    expired) cache entry for this exact tuple, and when it was fetched -
    backs the signal-generation backtest form's "data cached at HH:MM"
    hint. Same from_/to defaulting as GET /candles/history itself, so a
    caller passing the same args to both always asks about the same key -
    doesn't validate exchange/interval against a real provider (an
    unknown/malformed one just reports cached=False, same as a genuine
    miss, since there's nothing more specific to say)."""
    to_date = to or date.today()
    from_date = from_ or date.fromordinal(to_date.toordinal() - 7)

    cache_key = (exchange, symbol, interval, from_date, to_date)
    ttl = _history_cache_ttl_seconds(interval, to_date)
    with _history_cache_lock:
        cached = _history_cache.get(cache_key)
    if cached is None:
        return CandleCacheStatus(cached=False)

    _, fetched_at_monotonic, fetched_at_wall = cached
    if (time.monotonic() - fetched_at_monotonic) >= ttl:
        return CandleCacheStatus(cached=False)
    return CandleCacheStatus(cached=True, fetched_at=fetched_at_wall.isoformat())


@router.post("/candles/cache/clear", status_code=204)
def clear_candle_cache_entry(
    exchange: str,
    symbol: str,
    interval: str,
    from_: Optional[date] = Query(default=None, alias="from"),
    to: Optional[date] = None,
):
    """Evicts one exact cache entry (same tuple/defaulting as GET
    /candles/history and /candles/cache-status) - a manual "force refresh"
    for a caller who wants the next GET /candles/history for these exact
    args to genuinely re-fetch from the provider instead of serving the
    cached copy, e.g. after suspecting a provider-side correction to
    historical data. A no-op (still 204) if nothing was cached for this
    key - clearing something already absent isn't an error."""
    to_date = to or date.today()
    from_date = from_ or date.fromordinal(to_date.toordinal() - 7)

    cache_key = (exchange, symbol, interval, from_date, to_date)
    with _history_cache_lock:
        _history_cache.pop(cache_key, None)


@router.get("/candles/availability", response_model=DataAvailability)
def get_data_availability(exchange: str, symbol: str, interval: str):
    """Backs the signal-generation backtest form's data-availability hint -
    see DataAvailability's own docstring for why Dhan (NSE/MCX) and Delta
    (CRYPTO) report genuinely different things here."""
    try:
        provider = get_provider(exchange)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        return provider.get_data_availability(symbol, interval)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
