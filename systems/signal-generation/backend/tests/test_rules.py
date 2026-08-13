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

from app.domain.indicators import compute_rsi, compute_sma
from app.domain.rule import CrossoverRuleConfig
from app.domain.rules import CandleClose, bars_needed, evaluate, evaluate_crossover

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


# --- evaluate/bars_needed: the top-level (rule, indicator) dispatchers -----------------------


def test_evaluate_dispatches_through_indicator_and_rule():
    result = evaluate(RULE, "rsi", RSI_PARAMS, _candles([10, 11, 10, 13, 20, 15]))
    assert result == "bearish"


def test_bars_needed_is_the_indicators_own_warmup():
    # rsi period=2 + sma_period=2 -> 4 - the rule itself carries no
    # extra bars-needed, that's entirely the indicator's own concern now.
    assert bars_needed(RULE, "rsi", RSI_PARAMS) == 4
