"""Thin HTTP client to the market-data system. execution never embeds a
broker SDK or credentials directly - see docs/architecture.md."""

from typing import Optional

import requests

from app.config import settings


def get_ltp(exchange: str, symbol: str) -> float:
    resp = requests.get(
        f"{settings.market_data_base_url}/quotes/ltp",
        params={"exchange": exchange, "symbol": symbol},
        timeout=settings.market_data_timeout_seconds,
    )
    resp.raise_for_status()
    return float(resp.json()["ltp"])


def get_ltp_batch(exchange: str, symbols: list[str]) -> dict[str, float]:
    """All symbols for one exchange in a single market-data call - see
    position_manager.compute_unrealized_pnl/square_off_all_open, which
    call this once per exchange instead of once per position."""
    if not symbols:
        return {}
    resp = requests.post(
        f"{settings.market_data_base_url}/quotes/ltp/batch",
        json={"exchange": exchange, "symbols": symbols},
        timeout=settings.market_data_timeout_seconds,
    )
    resp.raise_for_status()
    return resp.json()["prices"]


def get_previous_candle(exchange: str, symbol: str, interval: str) -> Optional[dict]:
    """Most recently completed candle only (see market-data's GET
    /candles/previous) - None if unavailable (unknown symbol, or no
    completed candle yet e.g. just after market open), not an error."""
    resp = requests.get(
        f"{settings.market_data_base_url}/candles/previous",
        params={"exchange": exchange, "symbol": symbol, "interval": interval},
        timeout=settings.market_data_timeout_seconds,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def get_lot_size(exchange: str, symbol: str) -> Optional[int]:
    """Lot size for an already-resolved trading symbol (see market-data's
    GET /instruments/lot-size) - None if unknown, not an error. Only
    called for instrument_type='future' orders (see
    position_manager.open_position) - the NSE-spot path never pays this
    extra call."""
    resp = requests.get(
        f"{settings.market_data_base_url}/instruments/lot-size",
        params={"exchange": exchange, "symbol": symbol},
        timeout=settings.market_data_timeout_seconds,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return int(resp.json()["lot_size"])
