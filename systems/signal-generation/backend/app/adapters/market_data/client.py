"""Thin HTTP client to the market-data system - the in-house engine never
embeds a broker SDK or credentials directly, same rule execution follows
for quotes. See docs/architecture.md."""

from datetime import date
from typing import Optional

import requests

from app.config import settings
from app.domain.rules import CandleClose


class ResolvedUnderlying:
    def __init__(self, chart_symbol: str, chart_exchange: str, trade_symbol: str, trade_exchange: str, lot_size: int):
        self.chart_symbol = chart_symbol
        self.chart_exchange = chart_exchange
        self.trade_symbol = trade_symbol
        self.trade_exchange = trade_exchange
        self.lot_size = lot_size


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
