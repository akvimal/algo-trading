"""Tests for app/domain/equity_screener.compute_equity_screener_row - pure
computation over an already-fetched trailing daily-candle window, with no
Dhan/DB dependency. See app/scheduler.py's _record_equity_screener_snapshot
for the job that fetches that window and calls this."""

from app.domain.equity_screener import MIN_BARS_FOR_52W_PROXIMITY, compute_equity_screener_row
from app.domain.models import Candle
from app.domain.regime import _MIN_BARS


def _c(i: int, o: float, h: float, lo: float, cl: float) -> Candle:
    return Candle(
        exchange="NSE",
        symbol="RELIANCE",
        interval="daily",
        open=o,
        high=h,
        low=lo,
        close=cl,
        volume=1_000_000,
        timestamp=f"day-{i:04d}",
        provider="fake",
    )


def _flat_candles(n: int, price: float = 100.0) -> list[Candle]:
    return [_c(i, price, price + 1, price - 1, price) for i in range(n)]


def test_too_few_bars_returns_none():
    candles = _flat_candles(_MIN_BARS - 1)
    assert compute_equity_screener_row(candles) is None


def test_enough_for_regime_but_not_52w_leaves_proximity_none():
    candles = _flat_candles(MIN_BARS_FOR_52W_PROXIMITY - 1)
    result = compute_equity_screener_row(candles)

    assert result is not None
    assert result.high_52w is None
    assert result.low_52w is None
    assert result.proximity is None


def test_pct_change_5d_and_20d_from_flat_then_a_final_jump():
    candles = _flat_candles(60, price=100.0)
    # Move only the LAST candle - closes[-6] and closes[-21] both still
    # read 100.0, so both windows should agree on the same % move.
    candles[-1] = _c(59, 100.0, 111, 99, 110.0)
    result = compute_equity_screener_row(candles)

    assert result is not None
    assert result.pct_change_5d == 10.0
    assert result.pct_change_20d == 10.0


def test_near_52w_high_when_todays_close_sits_at_the_years_max():
    candles = _flat_candles(MIN_BARS_FOR_52W_PROXIMITY, price=100.0)
    candles[-1] = _c(MIN_BARS_FOR_52W_PROXIMITY - 1, 100.0, 120.0, 99.0, 120.0)
    result = compute_equity_screener_row(candles)

    assert result is not None
    assert result.high_52w == 120.0
    assert result.proximity == "near_52w_high"
    assert result.pct_from_52w_high == 0.0


def test_near_52w_low_when_todays_close_sits_at_the_years_min():
    candles = _flat_candles(MIN_BARS_FOR_52W_PROXIMITY, price=100.0)
    candles[-1] = _c(MIN_BARS_FOR_52W_PROXIMITY - 1, 100.0, 101.0, 80.0, 80.0)
    result = compute_equity_screener_row(candles)

    assert result is not None
    assert result.low_52w == 80.0
    assert result.proximity == "near_52w_low"
    assert result.pct_from_52w_low == 0.0


def test_mid_range_close_flags_no_proximity():
    candles = _flat_candles(MIN_BARS_FOR_52W_PROXIMITY, price=100.0)
    # High 120 set early, low 80 set early, today's close sits dead center.
    candles[10] = _c(10, 100.0, 120.0, 99.0, 100.0)
    candles[20] = _c(20, 100.0, 101.0, 80.0, 100.0)
    result = compute_equity_screener_row(candles)

    assert result is not None
    assert result.proximity is None
