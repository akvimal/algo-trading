"""Long-history daily/weekly OHLCV via Yahoo Finance, for NSE equities and
indices where Dhan's own history endpoint is capped (~90 days for some
instruments) - not a QuoteProvider (no LTP/lot-size/instrument-sync concept
here, just a historical-candles fetch), so it's wired directly into GET
/candles/history's `source=yahoo` option rather than through
providers/router.py's per-exchange dispatch. See docs/architecture.md's
weekly-options-advisor notes for why this exists.

Only NSE is supported (yfinance's ".NS" suffix convention) - MCX/CRYPTO
have no Yahoo equivalent worth adding here.
"""
from __future__ import annotations

from datetime import date, timedelta

import yfinance as yf

from app.domain.models import Candle

PROVIDER_NAME = "yahoo"

_YF_INTERVAL = {"daily": "1d", "weekly": "1wk"}


def _to_yahoo_symbol(exchange: str, symbol: str) -> str:
    if exchange != "NSE":
        raise ValueError(f"Yahoo Finance history is only wired for NSE, got exchange={exchange!r}")
    return f"{symbol}.NS"


def get_candle_history(exchange: str, symbol: str, interval: str, from_date: date, to_date: date) -> list[Candle]:
    """Every completed daily or weekly candle for `symbol` in [from_date,
    to_date] - mirrors the shape of QuoteProvider.get_candle_history so it
    slots into the same route/cache as Dhan/Delta (see candles.py's
    `source` param), just for the two interval values Yahoo actually
    covers here. `to_date` is treated as inclusive, matching every other
    provider's own convention - yfinance's own `end` is exclusive, so this
    adds a day before calling it.
    """
    yf_interval = _YF_INTERVAL.get(interval)
    if yf_interval is None:
        raise ValueError(f"Yahoo history only supports interval in {sorted(_YF_INTERVAL)}, got {interval!r}")

    yahoo_symbol = _to_yahoo_symbol(exchange, symbol)
    df = yf.Ticker(yahoo_symbol).history(start=from_date, end=to_date + timedelta(days=1), interval=yf_interval)
    if df.empty:
        raise ValueError(f"no Yahoo Finance data for '{symbol}' ({yahoo_symbol}) - unknown symbol or no data in range")

    candles = []
    for ts, row in df.iterrows():
        candles.append(
            Candle(
                exchange=exchange,
                symbol=symbol,
                interval=interval,
                open=float(row["Open"]),
                high=float(row["High"]),
                low=float(row["Low"]),
                close=float(row["Close"]),
                volume=float(row["Volume"]),
                timestamp=ts.isoformat(),
                provider=PROVIDER_NAME,
            )
        )
    return candles
