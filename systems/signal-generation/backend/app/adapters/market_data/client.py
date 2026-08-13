"""Thin HTTP client to the market-data system - the in-house engine never
embeds a broker SDK or credentials directly, same rule execution follows
for quotes. See docs/architecture.md."""

from datetime import date
from typing import Optional

import requests

from app.config import settings
from app.domain.rules import CandleClose


class ResolvedUnderlying:
    def __init__(
        self,
        chart_symbol: str,
        chart_exchange: str,
        trade_symbol: str,
        trade_exchange: str,
        lot_size: int,
        expiry: Optional[str] = None,
    ):
        self.chart_symbol = chart_symbol
        self.chart_exchange = chart_exchange
        self.trade_symbol = trade_symbol
        self.trade_exchange = trade_exchange
        self.lot_size = lot_size
        # ISO date - the trade contract's expiry, None for instruments
        # with no expiry (cash equity, crypto perpetuals). market-data's
        # own GET /instruments/resolve already returns this - previously
        # silently dropped here since nothing needed it until the
        # contract_day_filter feature.
        self.expiry = expiry


def resolve_underlying(segment: str, underlying: str) -> Optional[ResolvedUnderlying]:
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
        expiry=data.get("expiry"),
    )


def get_ltp(exchange: str, symbol: str) -> Optional[float]:
    """The traded instrument's current price - used as a signal's entry
    price instead of whatever candle actually drove the signal, which can
    be a DIFFERENT, charted-only instrument (e.g. an index spot, while
    the real trade is the active-month future - see
    ResolvedUnderlying.chart_symbol vs trade_symbol). None if unavailable
    (unknown symbol, or the market-data call fails) - callers should skip
    posting the signal this tick rather than fall back to a mismatched
    price."""
    try:
        resp = requests.get(
            f"{settings.market_data_base_url}/quotes/ltp",
            params={"exchange": exchange, "symbol": symbol},
            timeout=settings.market_data_timeout_seconds,
        )
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None
    return resp.json()["ltp"]


def get_universe_constituents(key: str) -> Optional[list[str]]:
    """The member symbol list for an NSE index-constituent universe (e.g.
    "NIFTYBANK") - used to expand a universe-scoped Strategy into its
    target symbols each tick (see app/domain/engine.py's
    _target_symbols). None if unknown or unavailable - callers skip the
    strategy for this tick rather than guess at a partial/stale list."""
    try:
        resp = requests.get(
            f"{settings.market_data_base_url}/instruments/universe/constituents",
            params={"key": key},
            timeout=settings.market_data_timeout_seconds,
        )
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None
    return resp.json()["constituents"]


def get_candle_history(exchange: str, symbol: str, interval: str, from_date: date, to_date: date) -> list[CandleClose]:
    """Oldest-first, completed bars only - ready to feed straight into
    evaluate_rsi_sma_crossover (or any future rule)."""
    resp = requests.get(
        f"{settings.market_data_base_url}/candles/history",
        params={
            "exchange": exchange,
            "symbol": symbol,
            "interval": interval,
            "from": from_date.isoformat(),
            "to": to_date.isoformat(),
        },
        timeout=settings.market_data_timeout_seconds,
    )
    resp.raise_for_status()
    return [
        CandleClose(timestamp=c["timestamp"], close=c["close"], high=c["high"], low=c["low"]) for c in resp.json()
    ]


def get_option_leg_history(
    exchange: str,
    symbol: str,
    option_type: str,
    strike: str,
    expiry_flag: str,
    expiry_code: int,
    interval: str,
    from_date: date,
    to_date: date,
) -> Optional[list[CandleClose]]:
    """One option leg's historical premium, tracked relative to spot (e.g.
    always the ATM strike) - Phase 4c's backtesting data source (see
    docs/architecture.md's app/domain/option_backtest.py). None if
    unresolvable (unknown underlying, or market-data has no option-history
    support for this exchange - MCX today)."""
    resp = requests.get(
        f"{settings.market_data_base_url}/options/leg-history",
        params={
            "exchange": exchange,
            "symbol": symbol,
            "option_type": option_type,
            "strike": strike,
            "expiry_flag": expiry_flag,
            "expiry_code": expiry_code,
            "interval": interval,
            "from": from_date.isoformat(),
            "to": to_date.isoformat(),
        },
        timeout=settings.option_history_timeout_seconds,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return [
        CandleClose(timestamp=c["timestamp"], close=c["close"], high=c["high"], low=c["low"]) for c in resp.json()
    ]
