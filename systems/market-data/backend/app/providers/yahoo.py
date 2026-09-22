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

import logging
import time
from datetime import date, timedelta

import pandas as pd
import yfinance as yf

from app.domain.models import Candle

logger = logging.getLogger(__name__)

PROVIDER_NAME = "yahoo"

_YF_INTERVAL = {"daily": "1d", "weekly": "1wk"}

# yfinance's own curl_cffi-based session occasionally fails to resolve or
# connect to Yahoo's endpoint under load - confirmed live 2026-09-22: a
# 209-symbol weekly_advisor batch produced both "Could not resolve host"
# and "Could not connect" curl errors for a scattered subset of symbols,
# including rock-solid large caps (INFY, DMART, HCLTECH) that plainly have
# real data - a transient network hiccup under concurrent load, not a
# genuine data gap, and every one of them succeeded on a bare retry
# minutes later. yfinance swallows the real exception internally and logs
# its own misleading "possibly delisted" line, returning an EMPTY
# DataFrame rather than raising - so retrying on an empty result matters
# here just as much as retrying a raised exception. Same "retry the whole
# operation a few times, fixed delay" shape as pipeline.py's own
# _fetch_expiry_and_chain_with_retry for Dhan's option-chain throttle,
# tuned smaller since this is about clearing a connection hiccup, not
# waiting out a rate limit.
_HISTORY_RETRY_ATTEMPTS = 3
_HISTORY_RETRY_SLEEP_SECONDS = 2.0


def _to_yahoo_symbol(exchange: str, symbol: str) -> str:
    if exchange != "NSE":
        raise ValueError(f"Yahoo Finance history is only wired for NSE, got exchange={exchange!r}")
    return f"{symbol}.NS"


def _fetch_history_with_retry(yahoo_symbol: str, start: date, end: date, yf_interval: str) -> pd.DataFrame:
    last_exc: Exception | None = None
    for attempt in range(_HISTORY_RETRY_ATTEMPTS):
        try:
            df = yf.Ticker(yahoo_symbol).history(start=start, end=end, interval=yf_interval)
            if not df.empty:
                return df
        except Exception as exc:  # yfinance/curl_cffi can raise directly too, not just return empty
            last_exc = exc
        if attempt < _HISTORY_RETRY_ATTEMPTS - 1:
            time.sleep(_HISTORY_RETRY_SLEEP_SECONDS)
    if last_exc is not None:
        logger.warning(
            "Yahoo history fetch for %s failed on every one of %d attempts, last error: %s",
            yahoo_symbol, _HISTORY_RETRY_ATTEMPTS, last_exc,
        )
    return pd.DataFrame()  # empty - let the caller's own empty-check raise its existing, clearer ValueError


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
    df = _fetch_history_with_retry(yahoo_symbol, from_date, to_date + timedelta(days=1), yf_interval)
    if df.empty:
        raise ValueError(f"no Yahoo Finance data for '{symbol}' ({yahoo_symbol}) - unknown symbol or no data in range")
    # Yahoo's own history has NaN OHLC rows for some NSE symbols with messy
    # corporate history (a moratorium, a demerger/relisting, a recent IPO -
    # e.g. YESBANK/INDUSTOWER/PAYTM) - float(nan) builds a Candle fine, but
    # FastAPI's strict JSON encoder then 500s on the whole response trying
    # to serialize it (json.dumps(..., allow_nan=False), so ONE bad row
    # anywhere in the range broke the entire fetch). Drop incomplete rows
    # before building candles rather than after - the caller only ever
    # wants complete, chartable bars anyway.
    df = df.dropna(subset=["Open", "High", "Low", "Close", "Volume"])
    if df.empty:
        raise ValueError(f"no complete Yahoo Finance data for '{symbol}' ({yahoo_symbol}) in range - every row had a gap")

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
