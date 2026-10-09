"""Tests for app/domain/equity_screener.compute_equity_screener_row - pure
computation over an already-fetched trailing daily-candle window, with no
Dhan/DB dependency. See app/scheduler.py's _record_equity_screener_snapshot
for the job that fetches that window and calls this."""

import pytest

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


# --- the descriptive filter/sort fields (added 2026-10-08) --------------------------------------------------------------------------------------------

from app.domain.equity_screener import LIQUID_MIN_CR, percentile_ranks, swing_fields  # noqa: E402


def _series(closes: list[float], volume: float = 1_000_000.0) -> list[Candle]:
    return [_c(i, c, c + 1, c - 1, c).model_copy(update={"volume": volume}) for i, c in enumerate(closes)]


def test_turnover_is_the_20_day_average_of_close_times_volume_in_crore():
    f = swing_fields(_series([100.0] * 30, volume=2_000_000))
    assert f["avg_turnover_cr"] == 20.0  # Rs 100 x 2,000,000 shares = Rs 20 crore a day
    assert "avg_turnover_cr" not in swing_fields(_series([100.0] * 19))  # under 20 bars there is no 20-day average


def test_returns_use_the_stated_lookbacks_and_skip_the_latest_month_for_12_1():
    closes = [100.0 + i for i in range(260)]  # a steady climb: close[i] = 100 + i
    f = swing_fields(_series(closes))
    assert f["ret_3m_pct"] == pytest.approx((closes[-1] / closes[-64] - 1) * 100)
    assert f["mom_12_1_pct"] == pytest.approx((closes[-22] / closes[-253] - 1) * 100)  # the last 21 bars are skipped
    assert "mom_12_1_pct" not in swing_fields(_series(closes[:200]))  # under a year of bars: no 12-1 score
    assert "ret_3m_pct" not in swing_fields(_series(closes[:40]))


def test_rsi3_reads_oversold_after_three_down_closes_and_overbought_after_a_run_up():
    base = [100.0] * 20
    assert swing_fields(_series(base + [98.0, 96.0, 94.0]))["rsi3"] < 15
    assert swing_fields(_series(base + [102.0, 104.0, 106.0]))["rsi3"] > 85
    assert swing_fields(_series(base))["rsi3"] is None  # perfectly flat: no direction to read


def test_distance_from_the_ema_atr_percent_and_volume_ratio():
    candles = _series([100.0] * 40)
    candles[-1] = candles[-1].model_copy(update={"close": 110.0, "high": 111.0, "volume": 3_000_000.0})
    f = swing_fields(candles)
    assert f["dist_ema20_pct"] > 4  # well above its 20-day EMA
    assert f["vol_ratio"] == pytest.approx(3.0)  # 3M against the 1M average of the 20 days before
    assert f["atr_pct"] == pytest.approx(2.0, abs=0.9)  # 99-101 daily ranges: a bit under 2% of the close


def test_the_row_carries_the_new_fields_and_a_short_series_leaves_them_none():
    full = compute_equity_screener_row(_flat_candles(260))
    assert full.avg_turnover_cr == 10.0 and full.mom_12_1_pct == 0 and full.vol_ratio == 1.0
    short = compute_equity_screener_row(_flat_candles(_MIN_BARS))
    assert short.mom_12_1_pct is None and short.ret_3m_pct is None


def test_percentile_ranks_run_zero_to_a_hundred_share_ties_and_skip_missing():
    assert percentile_ranks({"A": 1.0, "B": 2.0, "C": 3.0}) == {"A": 0.0, "B": 50.0, "C": 100.0}
    assert percentile_ranks({"A": 1.0, "B": 1.0, "C": 3.0}) == {"A": 25.0, "B": 25.0, "C": 100.0}
    assert percentile_ranks({"A": None, "B": 5.0}) == {"B": 100.0}
    assert percentile_ranks({}) == {}
    assert LIQUID_MIN_CR == 5.0


def test_the_route_returns_universes_liquidity_and_ranks_among_liquid_stocks_only():
    from datetime import date
    from types import SimpleNamespace

    from app.api.routes import equity_screener as route

    def row(symbol, ret, mom, turnover, tags, fno=False):
        return SimpleNamespace(
            symbol=symbol, exchange="NSE", snapshot_date=date(2026, 10, 8), close=100.0, pct_change_5d=1.0, pct_change_20d=2.0, adx=20.0, regime="ranging", high_52w=110.0, low_52w=80.0,
            pct_from_52w_high=-9.0, pct_from_52w_low=25.0, proximity=None, is_fno=fno, index_memberships=tags, avg_turnover_cr=turnover, ret_3m_pct=ret, mom_12_1_pct=mom,
            rsi3=40.0, dist_ema20_pct=1.0, atr_pct=2.0, vol_ratio=1.1,
        )

    rows = [row("AAA", 10.0, 30.0, 50.0, "NIFTY500,NIFTY100", fno=True), row("BBB", 20.0, 10.0, 12.0, "NIFTY500,NIFTYMIDCAP150"), row("CCC", 99.0, 99.0, 0.4, None)]

    class Q:
        def __init__(self, data=None, scalar=None):
            self.data, self._scalar = data, scalar

        def filter(self, *a, **k):
            return self

        def order_by(self, *a, **k):
            return self

        def all(self):
            return self.data

        def scalar(self):
            return self._scalar

    class Db:
        def query(self, arg):
            if str(arg).startswith("max("):
                return Q(scalar=date(2026, 10, 8))
            return Q(data=rows)

    out = route.get_equity_screener(history_days=1, db=Db())
    by = {r.symbol: r for r in out.rows}
    assert by["AAA"].universes == ["NIFTY500", "NIFTY100"] and by["AAA"].is_fno is True and by["CCC"].universes == []
    # CCC trades only Rs 0.4 Cr a day: it is not ranked, and its 99% return does not push the others down the scale
    assert by["CCC"].rs_3m_pctile is None and by["CCC"].rs_12m_pctile is None
    assert (by["AAA"].rs_3m_pctile, by["BBB"].rs_3m_pctile) == (0.0, 100.0)
    assert (by["AAA"].rs_12m_pctile, by["BBB"].rs_12m_pctile) == (100.0, 0.0)
    assert by["BBB"].avg_turnover_cr == 12.0
