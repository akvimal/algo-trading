"""Regression test for the atr() Wilder-recursion bug found while
prototyping this feature against real NSE data: the recursive step added
the full new true range instead of new_tr/period, so ATR inflated without
bound past the warmup window. A constant-true-range series should hold a
perfectly flat ATR forever - it didn't, before the fix."""
from app.domain.weekly_advisor.indicators import atr


def test_atr_stays_flat_on_constant_true_range():
    n = 40
    highs = [110.0] * n
    lows = [90.0] * n
    closes = [100.0] * n  # true range is a flat 20.0 every bar

    series = atr(highs, lows, closes, period=14)

    assert len(series) == n
    for i, value in enumerate(series):
        assert value == 20.0, f"bar {i}: expected flat ATR of 20.0, got {value}"
