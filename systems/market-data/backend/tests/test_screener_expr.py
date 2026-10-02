"""Tests for app/domain/screener_expr.py - the custom screener's expression
parser and evaluator. No DB/provider dependency: EvalContext is built
directly from synthetic Candle bars."""

from datetime import date, timedelta

import pytest

from app.domain.models import Candle
from app.domain.screener_expr import (
    BoolOp, Comparison, EmaRef, EvalContext, ExpressionError, Literal, Not, PriceRef, RollRef,
    evaluate_expression, parse_expression,
)


def _bar(day: date, o: float, h: float, lo: float, cl: float, vol: float = 1000) -> Candle:
    return Candle(exchange="NSE", symbol="TCS", interval="daily", open=o, high=h, low=lo, close=cl, volume=vol, timestamp=f"{day.isoformat()}T00:00:00", provider="fake")


def _daily(closes: list[float], start: date = date(2026, 1, 5)) -> list[Candle]:
    """One bar per weekday (Mon-Fri) starting at `start`, open=high=low=close
    for simplicity except where a test needs otherwise."""
    out = []
    d = start
    for c in closes:
        out.append(_bar(d, c, c, c, c))
        d += timedelta(days=1)
        while d.weekday() >= 5:
            d += timedelta(days=1)
    return out


def _ctx(closes: list[float]) -> EvalContext:
    return EvalContext(daily_bars=_daily(closes))


# ---- parsing: happy paths ---------------------------------------------------------------------------------


def test_parses_a_plain_price_comparison():
    node = parse_expression("close > 1500")
    assert isinstance(node, Comparison)
    assert isinstance(node.left, PriceRef) and node.left.field == "close" and node.left.timeframe == "daily"
    assert node.op == ">"
    assert isinstance(node.right, Literal) and node.right.number == 1500


def test_parses_weekly_price_references():
    node = parse_expression("weekly_close < weekly_low")
    assert isinstance(node.left, PriceRef) and node.left.field == "close" and node.left.timeframe == "weekly"
    assert isinstance(node.right, PriceRef) and node.right.field == "low" and node.right.timeframe == "weekly"


def test_parses_ema_with_a_period():
    node = parse_expression("ema(5) crosses_below ema(20)")
    assert isinstance(node.left, EmaRef) and node.left.period == 5 and node.left.timeframe == "daily"
    assert isinstance(node.right, EmaRef) and node.right.period == 20
    assert node.op == "crosses_below"


def test_parses_weekly_ema():
    node = parse_expression("weekly_ema(10) > close")
    assert isinstance(node.left, EmaRef) and node.left.timeframe == "weekly" and node.left.period == 10


def test_parses_min_and_max_with_an_inner_price_ref():
    node = parse_expression("weekly_close < min(weekly_low, 20)")
    assert isinstance(node.right, RollRef) and node.right.kind == "min" and node.right.window == 20
    assert isinstance(node.right.inner, PriceRef) and node.right.inner.field == "low" and node.right.inner.timeframe == "weekly"


def test_min_max_can_wrap_an_ema():
    node = parse_expression("close < min(ema(20), 10)")
    assert isinstance(node.right, RollRef)
    assert isinstance(node.right.inner, EmaRef) and node.right.inner.period == 20


def test_parses_and_or_left_to_right_and_not():
    node = parse_expression("close > 100 and high > 200 or not low < 50")
    assert isinstance(node, BoolOp) and node.op == "or"
    assert isinstance(node.operands[0], BoolOp) and node.operands[0].op == "and"
    assert isinstance(node.operands[1], Not)


def test_all_comparators_parse():
    for text, op in [("close<1", "<"), ("close<=1", "<="), ("close>1", ">"), ("close>=1", ">="), ("close==1", "=="), ("close!=1", "!=")]:
        assert parse_expression(text).op == op


def test_the_exact_bearish_breakout_example():
    node = parse_expression("weekly_close < min(weekly_low, 20) and ema(5) crosses_below ema(20)")
    assert isinstance(node, BoolOp) and node.op == "and"
    left, right = node.operands
    assert isinstance(left, Comparison) and isinstance(left.right, RollRef)
    assert isinstance(right, Comparison) and right.op == "crosses_below"


def test_case_and_whitespace_do_not_matter():
    a = parse_expression("Close > 100 AND High > 200")
    b = parse_expression("  close>100   and   high>200  ")
    assert a == b


# ---- parsing: error paths ----------------------------------------------------------------------------------


def test_blank_expression_is_refused_in_words():
    with pytest.raises(ExpressionError, match="Type a condition"):
        parse_expression("")
    with pytest.raises(ExpressionError):
        parse_expression("   ")


def test_an_unknown_name_says_so():
    with pytest.raises(ExpressionError, match="Unknown name 'banana'"):
        parse_expression("banana > 100")


def test_a_missing_comparator_is_refused_not_silently_accepted():
    with pytest.raises(ExpressionError, match="Expected a comparison"):
        parse_expression("close")


def test_a_price_field_refuses_arguments():
    with pytest.raises(ExpressionError, match="does not take arguments"):
        parse_expression("close(5) > 100")


def test_ema_without_a_period_is_refused():
    with pytest.raises(ExpressionError, match="needs exactly one number"):
        parse_expression("ema() > 100")
    with pytest.raises(ExpressionError):
        parse_expression("ema(low) > 100")  # not a literal period


def test_min_needs_a_window_number():
    with pytest.raises(ExpressionError, match="needs a value and a whole-number window"):
        parse_expression("close < min(low)")


def test_trailing_garbage_after_a_complete_expression_is_refused():
    with pytest.raises(ExpressionError, match="Unexpected"):
        parse_expression("close > 100 banana")


def test_an_unterminated_call_is_refused_in_words_not_a_traceback():
    with pytest.raises(ExpressionError):
        parse_expression("close > min(low, 20")


def test_keywords_cannot_be_used_as_values():
    with pytest.raises(ExpressionError, match="can't be used as a value"):
        parse_expression("and > 100")


def test_a_stray_character_is_refused():
    with pytest.raises(ExpressionError):
        parse_expression("close > 100 @ high")


# ---- evaluation: price refs and comparisons --------------------------------------------------------------


def test_evaluates_a_plain_close_comparison():
    ctx = _ctx([10, 20, 30])
    assert evaluate_expression(parse_expression("close > 25"), ctx) is True
    assert evaluate_expression(parse_expression("close > 35"), ctx) is False


def test_weekly_close_is_the_latest_forming_or_completed_weeks_close():
    # Mon-Fri closes 10..14 are all one ISO week; weekly_close is that week's own close (14, the Friday).
    ctx = _ctx([10, 11, 12, 13, 14])
    assert evaluate_expression(parse_expression("weekly_close == 14"), ctx) is True


def test_missing_history_makes_the_comparison_false_not_an_error():
    ctx = _ctx([10])  # not enough bars for ema(20)
    assert evaluate_expression(parse_expression("ema(20) > 1"), ctx) is False


def test_and_or_not_combine_as_expected():
    ctx = _ctx([10, 20, 30])
    assert evaluate_expression(parse_expression("close > 25 and close < 35"), ctx) is True
    assert evaluate_expression(parse_expression("close > 25 and close < 28"), ctx) is False
    assert evaluate_expression(parse_expression("close > 100 or close < 35"), ctx) is True
    assert evaluate_expression(parse_expression("not close > 100"), ctx) is True


# ---- evaluation: ema ----------------------------------------------------------------------------------------


def test_ema_matches_compute_ema_directly():
    from app.domain.indicators import compute_ema

    closes = [10, 12, 14, 11, 9, 15, 16]
    ctx = _ctx(closes)
    expected = compute_ema(closes, 3)[-1]
    node = parse_expression(f"ema(3) == {expected}")
    assert evaluate_expression(node, ctx) is True


# ---- evaluation: crossovers --------------------------------------------------------------------------------


def test_crosses_below_fires_only_on_the_bar_it_actually_crosses():
    # ema(2) starts above ema(4), then flips below on the last close.
    closes = [100, 100, 100, 100, 100, 60]
    ctx = _ctx(closes)
    assert evaluate_expression(parse_expression("ema(2) crosses_below ema(4)"), ctx) is True


def test_crosses_below_does_not_fire_if_it_already_crossed_earlier():
    closes = [100, 100, 100, 100, 60, 55]  # crossed on the second-to-last bar, not the latest
    ctx = _ctx(closes)
    assert evaluate_expression(parse_expression("ema(2) crosses_below ema(4)"), ctx) is False


def test_crosses_above_is_the_mirror_of_crosses_below():
    closes = [50, 50, 50, 50, 50, 90]
    ctx = _ctx(closes)
    assert evaluate_expression(parse_expression("ema(2) crosses_above ema(4)"), ctx) is True
    assert evaluate_expression(parse_expression("ema(2) crosses_below ema(4)"), ctx) is False


def test_a_crossover_against_a_literal_works_too():
    closes = [10, 10, 10, 10, 10, 20]
    ctx = _ctx(closes)
    assert evaluate_expression(parse_expression("close crosses_above 15"), ctx) is True


def test_crossover_with_insufficient_history_is_false_not_an_error():
    ctx = _ctx([10])  # only one bar: no "prior" value exists
    assert evaluate_expression(parse_expression("close crosses_above 5"), ctx) is False


# ---- evaluation: rolling min/max, the stated "20-week low" example ------------------------------------------


def test_rolling_min_over_weekly_lows_excludes_the_current_week_the_stated_example():
    # 25 weekday closes = 5 ISO weeks; the last week's own low (100) sits well below
    # every earlier week's low (all >= 150). min(weekly_low, 4) at the latest week
    # (back=0) is the min of the 4 weeks BEFORE it, weeks 1-4 - NOT week 5's own low,
    # which is exactly what lets "weekly_close < min(weekly_low, 4)" recognise week 5
    # as a breakout on the very week it happens (see RollRef's own docstring for why
    # an inclusive window could never do that: a close can't be below its own low).
    weeks_closes = [
        [150, 152, 151, 153, 155],  # week 1
        [156, 154, 157, 158, 159],  # week 2
        [160, 161, 159, 162, 163],  # week 3
        [164, 165, 163, 166, 167],  # week 4
        [140, 130, 120, 110, 100],  # week 5: breaks below every prior week's low
    ]
    ctx = _ctx([c for week in weeks_closes for c in week])
    inner = RollRef(inner=PriceRef("low", "weekly"), window=4, kind="min")
    assert inner.value_at(ctx, back=0) == 150  # week 1's own low, the smallest of weeks 1-4
    assert evaluate_expression(parse_expression("weekly_close < min(weekly_low, 4)"), ctx) is True


def test_rolling_max_over_daily_highs_excludes_the_reference_bar():
    closes = [10, 12, 9, 15, 8]
    ctx = _ctx(closes)
    node = RollRef(inner=PriceRef("high", "daily"), window=3, kind="max")
    # at back=0 (today, close 8), the 3 PRECEDING highs are [12,9,15] - today's own 8 is excluded
    assert node.value_at(ctx, 0) == 15


def test_rolling_window_not_yet_filled_is_none():
    ctx = _ctx([10, 20, 30])  # only 2 bars exist BEFORE "today" - window=5 needs 5
    node = RollRef(inner=PriceRef("close", "daily"), window=5, kind="min")
    assert node.value_at(ctx, 0) is None
