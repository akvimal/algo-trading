"""Tests for app/domain/custom_screens.py - pure evaluation over already-
fetched candidates, no DB dependency."""

from datetime import date, timedelta

import pytest

from app.domain.custom_screens import ScreenCandidate, matches_universe_filters, run_custom_screen
from app.domain.models import Candle
from app.domain.screener_expr import ExpressionError


def _daily(closes: list[float], start: date = date(2026, 1, 5)) -> list[Candle]:
    out = []
    d = start
    for c in closes:
        out.append(Candle(exchange="NSE", symbol="X", interval="daily", open=c, high=c, low=c, close=c, volume=1000, timestamp=f"{d.isoformat()}T00:00:00", provider="fake"))
        d += timedelta(days=1)
        while d.weekday() >= 5:
            d += timedelta(days=1)
    return out


def _candidate(symbol: str, closes: list[float]) -> ScreenCandidate:
    return ScreenCandidate(symbol=symbol, exchange="NSE", close=closes[-1], bars=_daily(closes))


# ---- run_custom_screen -------------------------------------------------------------------------------------


def test_returns_only_the_symbols_that_match():
    candidates = [_candidate("HIGH", [200]), _candidate("LOW", [50])]
    out = run_custom_screen("close > 100", candidates)
    assert [m.symbol for m in out] == ["HIGH"]
    assert out[0].close == 200 and out[0].exchange == "NSE"


def test_no_candidates_match_gives_an_empty_list_not_an_error():
    assert run_custom_screen("close > 100000", [_candidate("A", [10])]) == []


def test_an_unparseable_expression_raises_once_up_front():
    with pytest.raises(ExpressionError):
        run_custom_screen("banana > 100", [_candidate("A", [10])])


def test_one_thin_candidate_does_not_stop_the_others_matching():
    thin = _candidate("THIN", [10])  # not enough bars for ema(20)
    thick = _candidate("THICK", [10] * 30)
    out = run_custom_screen("ema(20) > 1 or close > 5", [thin, thick])
    # THIN's ema(20)>1 evaluates to False (not enough history), but close>5 still matches it
    assert {m.symbol for m in out} == {"THIN", "THICK"}


def test_the_stated_bearish_breakout_expression_end_to_end():
    weeks = [
        [150, 152, 151, 153, 155], [156, 154, 157, 158, 159], [160, 161, 159, 162, 163],
        [164, 165, 163, 166, 167], [100, 100, 100, 100, 100],
    ]
    closes = [c for week in weeks for c in week]
    out = run_custom_screen("weekly_close < min(weekly_low, 4) and close < 120", [_candidate("BREAKOUT", closes)])
    assert [m.symbol for m in out] == ["BREAKOUT"]


# ---- matches_universe_filters ------------------------------------------------------------------------------


def test_no_filters_at_all_matches_everything():
    assert matches_universe_filters(is_fno=False, index_memberships=None, close=10, filter_is_fno=None, filter_index=None, filter_min_price=None, filter_max_price=None) is True


def test_is_fno_filter():
    assert matches_universe_filters(True, None, 10, filter_is_fno=True, filter_index=None, filter_min_price=None, filter_max_price=None) is True
    assert matches_universe_filters(False, None, 10, filter_is_fno=True, filter_index=None, filter_min_price=None, filter_max_price=None) is False


def test_index_membership_filter_checks_the_comma_joined_list():
    assert matches_universe_filters(False, "NIFTY50,NIFTY100", 10, filter_is_fno=None, filter_index="NIFTY100", filter_min_price=None, filter_max_price=None) is True
    assert matches_universe_filters(False, "NIFTY50", 10, filter_is_fno=None, filter_index="NIFTY100", filter_min_price=None, filter_max_price=None) is False
    assert matches_universe_filters(False, None, 10, filter_is_fno=None, filter_index="NIFTY100", filter_min_price=None, filter_max_price=None) is False


def test_price_range_filters():
    assert matches_universe_filters(False, None, 100, filter_is_fno=None, filter_index=None, filter_min_price=50, filter_max_price=None) is True
    assert matches_universe_filters(False, None, 40, filter_is_fno=None, filter_index=None, filter_min_price=50, filter_max_price=None) is False
    assert matches_universe_filters(False, None, 100, filter_is_fno=None, filter_index=None, filter_min_price=None, filter_max_price=50) is False


def test_filters_combine_with_and_not_or():
    # F&O yes, but price too low - should fail even though the F&O check passes.
    assert matches_universe_filters(True, None, 10, filter_is_fno=True, filter_index=None, filter_min_price=50, filter_max_price=None) is False
