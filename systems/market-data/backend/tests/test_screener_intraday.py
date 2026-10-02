"""The custom screener's intraday timeframes (m5_/m15_/m30_/h1_) and prev(): grammar, evaluation, and the lazy, budgeted fetch."""

from datetime import date, datetime, timedelta

import pytest

from app.domain.custom_screens import ScreenCandidate, run_screen
from app.domain.models import Candle
from app.domain.screener_expr import (
    BoolOp, Comparison, EmaRef, EvalContext, ExpressionError, IntradayUnavailable, PriceRef, RollRef, ShiftRef,
    evaluate_expression, expression_timeframes, parse_expression,
)


def bars(closes, interval="15min", start=datetime(2026, 10, 2, 9, 15), step=15):
    return [
        Candle(exchange="NSE", symbol="X", interval=interval, open=c, high=c + 1, low=c - 1, close=c, volume=100, timestamp=(start + timedelta(minutes=step * i)).isoformat(), provider="fake")
        for i, c in enumerate(closes)
    ]


def daily(closes):
    return bars(closes, "daily", datetime(2026, 9, 1), 1440)


def ctx(daily_closes=(100, 101, 102), intraday=None, calls=None):
    def loader(interval):
        if calls is not None:
            calls.append(interval)
        if intraday is None:
            raise IntradayUnavailable("none")
        return intraday[interval]

    return EvalContext(daily_bars=daily(list(daily_closes)), load_intraday=loader if intraday is not None or calls is not None else None)


def test_intraday_names_parse_with_their_timeframe():
    for prefix, tf in (("m5_", "m5"), ("m15_", "m15"), ("m30_", "m30"), ("h1_", "h1"), ("weekly_", "weekly"), ("daily_", "daily")):
        node = parse_expression(f"{prefix}close > 1")
        assert isinstance(node.left, PriceRef) and node.left.timeframe == tf and node.left.field == "close"
    assert parse_expression("m15_ema(20) > 1").left == EmaRef(20, "m15")
    assert parse_expression("close > 1").left.timeframe == "daily"  # a bare name is still the daily bar


def test_prev_parses_with_and_without_a_count():
    one = parse_expression("prev(m15_close) < m15_close").left
    assert isinstance(one, ShiftRef) and one.periods == 1 and one.inner == PriceRef("close", "m15")
    three = parse_expression("prev(close, 3) < close").left
    assert isinstance(three, ShiftRef) and three.periods == 3
    nested = parse_expression("prev(ema(5), 2) < ema(5)").left
    assert isinstance(nested, ShiftRef) and nested.inner == EmaRef(5, "daily")


@pytest.mark.parametrize("text", ["prev() > 1", "prev(close, 0) > 1", "prev(close, 1, 2) > 1", "prev(close, close) > 1", "prev(close, 1.5) > 1"])
def test_prev_needs_a_value_and_a_whole_count_of_one_or_more(text):
    if text == "prev(close, 1.5) > 1":
        assert parse_expression(text).left.periods == 1  # a fractional count is cut to a whole one, like every other window here
        return
    with pytest.raises(ExpressionError):
        parse_expression(text)


def test_prev_reads_the_bar_before_in_its_own_timeframe():
    c = ctx(daily_closes=(10, 20, 30), intraday={"15min": bars([1, 2, 3, 4])})
    assert evaluate_expression(parse_expression("m15_close == 4"), c)
    assert evaluate_expression(parse_expression("prev(m15_close) == 3"), c)
    assert evaluate_expression(parse_expression("prev(m15_close, 3) == 1"), c)
    assert evaluate_expression(parse_expression("prev(close, 2) == 10"), c)  # the daily bar, two days back
    assert not evaluate_expression(parse_expression("prev(m15_close, 9) > 0"), c)  # further back than there are bars: false, not an error


def test_a_15_minute_crossover_uses_the_previous_bar():
    c = ctx(intraday={"15min": bars([10, 10, 10, 10, 10, 12])})
    assert evaluate_expression(parse_expression("m15_close crosses_above m15_ema(3)"), c)
    assert not evaluate_expression(parse_expression("m15_close crosses_below m15_ema(3)"), c)


def test_offsets_work_inside_rolling_windows_and_on_indicators():
    c = ctx(intraday={"15min": bars([5, 6, 7, 8, 9, 10])})
    # lows are 4..9. min(m15_low, 3) is the lowest low of the 3 bars BEFORE the latest (6,7,8 -> 6 is wrong: 7,8,9 excluded) i.e. 6;
    # prev() of it is the same thing one bar earlier: the lowest low of the 3 bars before the previous bar (lows 5,6,7) = 5
    assert evaluate_expression(parse_expression("min(m15_low, 3) == 6"), c)
    assert evaluate_expression(parse_expression("prev(min(m15_low, 3)) == 5"), c)
    assert evaluate_expression(parse_expression("prev(m15_ema(2)) < m15_ema(2)"), c)


def test_a_higher_timeframe_and_a_lower_one_can_be_mixed_in_one_expression():
    c = ctx(daily_closes=(100, 110, 120), intraday={"15min": bars([119, 121]), "5min": bars([121, 122], "5min", step=5)})
    assert evaluate_expression(parse_expression("close > 100 and prev(m15_close) < 120 and m5_close > m15_close"), c)
    assert expression_timeframes(parse_expression("close > 100 and prev(m15_close) < 120 and weekly_close > m5_close")) == {"daily", "m15", "weekly", "m5"}


def test_intraday_names_without_a_feed_are_unavailable_not_false():
    with pytest.raises(IntradayUnavailable):
        evaluate_expression(parse_expression("m15_close > 1"), EvalContext(daily_bars=daily([1, 2, 3])))


def test_the_feed_is_only_asked_when_evaluation_reaches_an_intraday_name():
    calls: list[str] = []
    c = ctx(daily_closes=(100, 90), intraday={"15min": bars([1, 2])}, calls=calls)
    # the daily condition fails first, so "and" never reads the intraday bars
    assert not evaluate_expression(parse_expression("close > 95 and m15_close > 0"), c)
    assert calls == []
    c = ctx(daily_closes=(100, 110), intraday={"15min": bars([1, 2])}, calls=calls)
    assert evaluate_expression(parse_expression("close > 95 and m15_close > 0 and prev(m15_close) > 0"), c)
    assert calls == ["15min"]  # once, however many times the 15 minute bars are used


# ---- running a screen ----------------------------------------------------------------------------------------------------

def candidate(symbol, closes):
    return ScreenCandidate(symbol=symbol, exchange="NSE", close=closes[-1], bars=daily(closes))


def test_a_screen_fetches_intraday_only_for_the_stocks_that_get_that_far():
    fetched: list[tuple[str, str]] = []

    def feed(c, interval):
        fetched.append((c.symbol, interval))
        return bars([1, 2, 3])

    run = run_screen("close > 100 and m15_close > prev(m15_close)", [candidate("LOW", [50]), candidate("HIGH", [150])], intraday=feed)
    assert [m.symbol for m in run.matches] == ["HIGH"]
    assert fetched == [("HIGH", "15min")]  # LOW failed the cheap daily test and never cost a fetch
    assert run.skipped == 0 and run.uses_intraday is True


def test_stocks_the_feed_gave_up_on_are_skipped_and_counted():
    def feed(c, interval):
        if c.symbol == "BUDGET":
            raise IntradayUnavailable("limit")
        return bars([1, 2, 3])

    run = run_screen("m15_close > 0", [candidate("OK", [10]), candidate("BUDGET", [10]), candidate("OK2", [10])], intraday=feed)
    assert [m.symbol for m in run.matches] == ["OK", "OK2"] and run.skipped == 1


def test_a_daily_only_screen_never_touches_the_feed():
    def feed(c, interval):
        raise AssertionError("not needed")

    run = run_screen("close > 100", [candidate("A", [150])], intraday=feed)
    assert [m.symbol for m in run.matches] == ["A"] and run.uses_intraday is False and run.skipped == 0


def test_the_existing_daily_and_weekly_screens_are_unchanged():
    run = run_screen("close > 100 and weekly_close > 100", [candidate("A", [150] * 10)])
    assert [m.symbol for m in run.matches] == ["A"]
