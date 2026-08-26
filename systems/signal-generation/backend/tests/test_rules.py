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

from datetime import datetime

import pytest

from app.domain.indicators import compute_rsi, compute_sma
from app.domain.rule import CrossoverRuleConfig, RangeBreakoutRuleConfig
from app.domain.rules import (
    CandleClose,
    bars_needed,
    build_crossover_bias_fn,
    evaluate,
    evaluate_crossover,
    evaluate_crossover_at,
    find_crossovers_since,
)

RULE = CrossoverRuleConfig(indicator_id="11111111-1111-1111-1111-111111111111")
RSI_PARAMS = {"period": 2, "sma_period": 2}


def _candles(closes: list[float]) -> list[CandleClose]:
    # high=low=close - these fixtures only exercise indicator/rule math
    # (which only ever reads .close), not backtest.py's SL/target
    # intrabar logic, which is what high/low exist for.
    return [CandleClose(timestamp=f"t{i}", close=c, high=c, low=c) for i, c in enumerate(closes)]


def _candles_with_ts(closes: list[float], start_minute: int = 0) -> list[CandleClose]:
    # Real, one-per-minute ISO timestamps - find_crossovers_since actually
    # parses .timestamp (via datetime.fromisoformat) to compare against
    # since_ts, unlike every indicator-math fixture above (_candles' bare
    # "t{i}" strings), which only ever reads .close.
    return [
        CandleClose(timestamp=f"2026-08-21T11:{start_minute + i:02d}:00+00:00", close=c, high=c, low=c)
        for i, c in enumerate(closes)
    ]


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


# --- find_crossovers_since: engine.py's own multi-bar backfill scan (added 2026-08-21) --------
#
# Exists because a live tick's 60s poll isn't guaranteed to align with the
# candle cadence - if 2+ candles complete between one tick and the next,
# evaluate()/evaluate_crossover's own "just the newest bar-pair" scope can
# silently miss a crossover-then-reversal entirely inside the skipped
# bars. Reproduced live 2026-08-21: an RSI/SMA crossover reversed on the
# very next 1min bar and was never posted as a signal.


def test_find_crossovers_since_none_checks_only_the_latest_bar():
    # since_ts=None - same scope evaluate()/evaluate_crossover already
    # have: only the newest bar, never a replay of history - activating a
    # strategy for the first time must not burst-post its whole fetched
    # window as backdated signals.
    candles = _candles_with_ts([10, 11, 10, 13, 20, 15])
    assert find_crossovers_since(RULE, "rsi", RSI_PARAMS, candles, None) == [(5, "bearish")]


def test_find_crossovers_since_none_no_cross_on_latest_bar_returns_empty():
    candles = _candles_with_ts([10, 11, 10, 13, 20])
    assert find_crossovers_since(RULE, "rsi", RSI_PARAMS, candles, None) == []


def test_find_crossovers_since_rejects_non_crossover_rule():
    with pytest.raises(ValueError):
        find_crossovers_since(RangeBreakoutRuleConfig(breakout_period=4), "rsi", RSI_PARAMS, _candles_with_ts([1, 2, 3]), None)


def test_find_crossovers_since_empty_candles_returns_empty():
    assert find_crossovers_since(RULE, "rsi", RSI_PARAMS, [], None) == []


def test_find_crossovers_since_already_at_latest_bar_returns_empty():
    # since_ts is the LATEST bar's own timestamp - nothing newer to scan,
    # same as check_exits-style "already acted on this exact bar" dedup.
    candles = _candles_with_ts([10, 11, 10, 13, 20, 15])
    since_ts = datetime.fromisoformat(candles[-1].timestamp)
    assert find_crossovers_since(RULE, "rsi", RSI_PARAMS, candles, since_ts) == []


def test_find_crossovers_since_finds_every_crossover_after_since_ts():
    # A longer, organically-reversing series - ground truth (which bars
    # actually cross, and which way) is derived directly from
    # evaluate_crossover_at itself (already covered by its own tests
    # above), not hand-traced - the point here is purely that
    # find_crossovers_since finds EVERY one of them since since_ts in one
    # scan, not just the newest.
    closes = [10, 11, 10, 13, 20, 15, 12, 18, 25, 9, 30]
    candles = _candles_with_ts(closes)
    value = compute_rsi(closes, period=2)
    signal = compute_sma(value, period=2)
    all_crossovers = [(i, evaluate_crossover_at(value, signal, i)) for i in range(len(closes))]
    all_crossovers = [(i, bias) for i, bias in all_crossovers if bias is not None]
    # Sanity: this fixture must actually contain more than one crossover,
    # or the test below isn't exercising the multi-bar scan at all.
    assert len(all_crossovers) >= 2

    since_index = 3
    since_ts = datetime.fromisoformat(candles[since_index].timestamp)
    expected = [(i, bias) for i, bias in all_crossovers if i > since_index]
    assert find_crossovers_since(RULE, "rsi", RSI_PARAMS, candles, since_ts) == expected


def test_find_crossovers_since_reproduces_the_missed_reversal_scenario():
    # The exact bug this exists to fix, reproduced directly: an oscillating
    # price series whose RSI(2)/SMA(2) crosses on EVERY bar from index 4
    # on - bearish, bullish, bearish, bullish - the same "up-cross then
    # down-cross the very next bar" shape reported live. evaluate()'s own
    # "just the last two bars" scope would only ever have seen the LAST
    # one (bullish, index 7); this must return all four, in order,
    # including the ones a delayed tick would otherwise have skipped.
    closes = [10, 20, 10, 20, 10, 20, 10, 20]
    candles = _candles_with_ts(closes)
    since_ts = datetime.fromisoformat(candles[0].timestamp)  # as if last signaled before this whole window

    result = find_crossovers_since(RULE, "rsi", RSI_PARAMS, candles, since_ts)

    assert result == [(4, "bearish"), (5, "bullish"), (6, "bearish"), (7, "bullish")]
    # Confirms evaluate()'s pre-fix behavior really would have only found
    # the last one - proving this isn't a redundant test of the same thing.
    assert evaluate(RULE, "rsi", RSI_PARAMS, candles) == "bullish"


# --- SuperTrend as a crossover indicator (added 2026-08-21) -----------------------------------
#
# "value crosses signal" = close price crossing the SuperTrend line - the
# standard "SuperTrend flip" entry signal. Only the dispatch/wiring is
# tested here (evaluate/build_crossover_bias_fn correctly delegate to
# compute_indicator/compute_indicator_signal's "supertrend" branches,
# app/domain/indicators.py) - the SuperTrend math itself is already
# exhaustively covered in test_regime.py's compute_supertrend tests.

ST_RULE = CrossoverRuleConfig(indicator_id="22222222-2222-2222-2222-222222222222")
ST_PARAMS = {"period": 2, "multiplier": 3.0}

# A real high/low range (not high=low=close) - SuperTrend's ATR needs a
# genuine range, unlike RSI/SMA which only ever read .close.
ST_CANDLES = [
    CandleClose(timestamp="t0", close=10.0, high=11.0, low=9.0),
    CandleClose(timestamp="t1", close=11.0, high=12.0, low=10.0),
    CandleClose(timestamp="t2", close=12.0, high=13.0, low=11.0),
    CandleClose(timestamp="t3", close=13.0, high=14.0, low=12.0),
    CandleClose(timestamp="t4", close=6.0, high=7.0, low=5.0),
    CandleClose(timestamp="t5", close=5.0, high=6.0, low=4.0),
]


def test_evaluate_dispatches_supertrend_crossover():
    from app.domain.indicators import compute_indicator, compute_indicator_signal

    value_series = compute_indicator("supertrend", ST_PARAMS, ST_CANDLES)
    signal_series = compute_indicator_signal("supertrend", ST_PARAMS, ST_CANDLES)
    assert evaluate(ST_RULE, "supertrend", ST_PARAMS, ST_CANDLES) == evaluate_crossover(value_series, signal_series)


def test_build_crossover_bias_fn_matches_evaluate_for_supertrend_bar_by_bar():
    bias_fn = build_crossover_bias_fn(ST_RULE, "supertrend", ST_PARAMS, ST_CANDLES)
    for i in range(1, len(ST_CANDLES) + 1):
        window = ST_CANDLES[:i]
        assert bias_fn(window) == evaluate(ST_RULE, "supertrend", ST_PARAMS, window)


def test_bars_needed_supertrend_is_period_plus_one():
    assert bars_needed(ST_RULE, "supertrend", ST_PARAMS) == 3
