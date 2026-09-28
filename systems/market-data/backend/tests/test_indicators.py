"""Tests for app/domain/indicators.py - pure timeframe/indicator building
blocks (compute_ema, rolling_min/max, resample_weekly) with no Dhan/DB
dependency, the foundation the (upcoming) custom-expression equity
screener evaluates against."""

from app.domain.indicators import compute_ema, resample_weekly, rolling_max, rolling_min
from app.domain.models import Candle


def _c(day: str, o: float, h: float, lo: float, cl: float, vol: float = 1000) -> Candle:
    return Candle(exchange="NSE", symbol="TCS", interval="daily", open=o, high=h, low=lo, close=cl, volume=vol, timestamp=f"{day}T00:00:00", provider="fake")


# ---- compute_ema -----------------------------------------------------------------------------------------


def test_ema_is_none_until_the_period_is_filled():
    out = compute_ema([1, 2, 3], 5)
    assert out == [None, None, None]


def test_ema_seeds_with_a_plain_average_then_smooths():
    closes = [10, 20, 30, 20, 10]
    out = compute_ema(closes, 3)
    assert out[0] is None and out[1] is None
    assert out[2] == (10 + 20 + 30) / 3  # the seed: a plain SMA of the first 3
    k = 2 / 4
    assert out[3] == 20 * k + out[2] * (1 - k)
    assert out[4] == 10 * k + out[3] * (1 - k)


def test_ema_of_a_flat_series_is_flat():
    out = compute_ema([5.0] * 10, 4)
    assert all(v is None or v == 5.0 for v in out)


def test_a_non_positive_period_gives_all_none_rather_than_raising():
    assert compute_ema([1, 2, 3], 0) == [None, None, None]


# ---- rolling_min / rolling_max ----------------------------------------------------------------------------


def test_rolling_min_and_max_are_none_until_the_window_is_filled():
    assert rolling_min([3, 1, 2], 5) == [None, None, None]
    assert rolling_max([3, 1, 2], 5) == [None, None, None]


def test_rolling_min_tracks_the_trailing_window():
    values = [5, 3, 8, 1, 9, 2]
    assert rolling_min(values, 3) == [None, None, 3, 1, 1, 1]


def test_rolling_max_tracks_the_trailing_window():
    values = [5, 3, 8, 1, 9, 2]
    assert rolling_max(values, 3) == [None, None, 8, 8, 9, 9]


def test_window_of_one_is_just_the_value_itself():
    assert rolling_min([4, 7, 2], 1) == [4, 7, 2]
    assert rolling_max([4, 7, 2], 1) == [4, 7, 2]


def test_a_value_leaves_the_window_once_it_is_old_enough():
    # the 9 at index 2 must stop being the max once the window has moved past it
    values = [1, 2, 9, 1, 1, 1]
    assert rolling_max(values, 2)[4] == 1  # window at index 4 is [3,4] -> values 1,1


# ---- resample_weekly ---------------------------------------------------------------------------------------


def test_groups_daily_bars_into_iso_weeks():
    # 2026-09-21 is a Monday; 2026-09-25 Friday (same ISO week); 2026-09-28 is the next Monday.
    candles = [
        _c("2026-09-21", 100, 105, 99, 102, 1000),
        _c("2026-09-22", 102, 106, 101, 104, 1100),
        _c("2026-09-25", 104, 108, 103, 107, 1200),
        _c("2026-09-28", 107, 110, 106, 109, 1300),
    ]
    weeks = resample_weekly(candles)
    assert len(weeks) == 2
    w1, w2 = weeks
    assert w1.open == 100 and w1.close == 107 and w1.high == 108 and w1.low == 99 and w1.volume == 1000 + 1100 + 1200
    assert w1.timestamp.startswith("2026-09-21")
    assert w1.interval == "1week"
    assert w2.open == 107 and w2.close == 109 and w2.volume == 1300


def test_a_lone_day_is_its_own_one_day_week():
    weeks = resample_weekly([_c("2026-09-23", 50, 51, 49, 50.5)])
    assert len(weeks) == 1
    assert weeks[0].open == 50 and weeks[0].close == 50.5


def test_empty_input_gives_an_empty_result():
    assert resample_weekly([]) == []


def test_carries_the_symbol_exchange_and_provider_through_unchanged():
    weeks = resample_weekly([_c("2026-09-21", 1, 2, 0.5, 1.5)])
    assert weeks[0].symbol == "TCS" and weeks[0].exchange == "NSE" and weeks[0].provider == "fake"
