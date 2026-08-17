"""evaluate_crossover/evaluate/bars_needed tests. The two crossover
fixtures below are hand-traced against Wilder's RSI formula with
rsi_period=sma_period=2 (kept small so the trace is checkable by hand):

closes=[10,11,10,13,20,15] -> rsi=[None,None,50.0,87.5,97.2222,46.0541],
sma=[None,None,None,68.75,92.3611,71.6382] -> last two (rsi,sma) pairs are
(97.2222,92.3611) then (46.0541,71.6382): RSI was above its SMA, then
dropped below -> bearish crossover on the last bar.

closes=[20,19,20,17,10,15] -> rsi=[None,None,50.0,12.5,2.7778,53.9459],
sma=[None,None,None,31.25,7.6389,28.3619] -> RSI was below its SMA, then
rose above -> bullish crossover on the last bar.
"""

import pytest

from app.domain.indicators import compute_rsi, compute_sma
from app.domain.rule import CrossoverRuleConfig, RangeBreakoutRuleConfig
from app.domain.rules import CandleClose, bars_needed, build_crossover_bias_fn, evaluate, evaluate_crossover, evaluate_crossover_at

RULE = CrossoverRuleConfig(indicator_id="11111111-1111-1111-1111-111111111111")
RSI_PARAMS = {"period": 2, "sma_period": 2}


def _candles(closes: list[float]) -> list[CandleClose]:
    # high=low=close - these fixtures only exercise indicator/rule math
    # (which only ever reads .close), not backtest.py's SL/target
    # intrabar logic, which is what high/low exist for.
    return [CandleClose(timestamp=f"t{i}", close=c, high=c, low=c) for i, c in enumerate(closes)]


# --- evaluate_crossover: takes two plain already-computed series --------------------------


def test_evaluate_crossover_detects_bearish_cross():
    value = compute_rsi([10, 11, 10, 13, 20, 15], period=2)
    signal = compute_sma(value, period=2)
    assert evaluate_crossover(value, signal) == "bearish"


def test_evaluate_crossover_detects_bullish_cross():
    value = compute_rsi([20, 19, 20, 17, 10, 15], period=2)
    signal = compute_sma(value, period=2)
    assert evaluate_crossover(value, signal) == "bullish"


def test_evaluate_crossover_no_fresh_cross_returns_none():
    # RSI already above its SMA on both of the last two bars - not fresh.
    value = compute_rsi([10, 11, 10, 13, 20], period=2)
    signal = compute_sma(value, period=2)
    assert evaluate_crossover(value, signal) is None


def test_evaluate_crossover_insufficient_data_returns_none():
    value = compute_rsi([10, 11, 12], period=2)
    signal = compute_sma(value, period=2)
    assert evaluate_crossover(value, signal) is None


def test_evaluate_crossover_empty_series_returns_none():
    assert evaluate_crossover([], []) is None


# --- evaluate_crossover_at: indexed version build_crossover_bias_fn actually uses -------------


def test_evaluate_crossover_at_matches_evaluate_crossover_at_last_index():
    value = compute_rsi([10, 11, 10, 13, 20, 15], period=2)
    signal = compute_sma(value, period=2)
    assert evaluate_crossover_at(value, signal, len(value) - 1) == evaluate_crossover(value, signal) == "bearish"


def test_evaluate_crossover_at_bullish_fixture():
    value = compute_rsi([20, 19, 20, 17, 10, 15], period=2)
    signal = compute_sma(value, period=2)
    assert evaluate_crossover_at(value, signal, len(value) - 1) == "bullish"


def test_evaluate_crossover_at_index_zero_returns_none():
    value = compute_rsi([10, 11, 10, 13, 20, 15], period=2)
    signal = compute_sma(value, period=2)
    assert evaluate_crossover_at(value, signal, 0) is None


def test_evaluate_crossover_at_negative_index_returns_none():
    assert evaluate_crossover_at([1.0], [1.0], -1) is None


# --- build_crossover_bias_fn: the O(1)-per-bar precomputed replacement for evaluate() ----------


def test_build_crossover_bias_fn_matches_evaluate_bar_by_bar():
    """The equivalence build_crossover_bias_fn's whole optimization relies
    on: for every bar i of a real scan, calling the precomputed bias_fn
    with candles[:i] must return EXACTLY what evaluate() would compute
    fresh from that same candles[:i] slice - proving the precompute-once
    approach isn't an approximation, just a faster way to get the same
    answer (both closes fixtures from this file's own module docstring,
    scanned bar by bar, not just checked at the final bar)."""
    for closes in ([10, 11, 10, 13, 20, 15], [20, 19, 20, 17, 10, 15]):
        candles = _candles(closes)
        bias_fn = build_crossover_bias_fn(RULE, "rsi", RSI_PARAMS, candles)
        for i in range(1, len(candles) + 1):
            window = candles[:i]
            assert bias_fn(window) == evaluate(RULE, "rsi", RSI_PARAMS, window)


def test_build_crossover_bias_fn_rejects_non_crossover_rule():
    with pytest.raises(ValueError):
        build_crossover_bias_fn(RangeBreakoutRuleConfig(breakout_period=4), "rsi", RSI_PARAMS, _candles([1, 2, 3]))


# --- evaluate/bars_needed: the top-level (rule, indicator) dispatchers -----------------------


def test_evaluate_dispatches_through_indicator_and_rule():
    result = evaluate(RULE, "rsi", RSI_PARAMS, _candles([10, 11, 10, 13, 20, 15]))
    assert result == "bearish"


def test_bars_needed_is_the_indicators_own_warmup():
    # rsi period=2 + sma_period=2 -> 4 - the rule itself carries no
    # extra bars-needed, that's entirely the indicator's own concern now.
    assert bars_needed(RULE, "rsi", RSI_PARAMS) == 4
