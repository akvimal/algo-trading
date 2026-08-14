from datetime import datetime, time, timedelta

import pytest

from app.domain import backtest as backtest_module
from app.domain.backtest import (
    MAX_GRID_COMBINATIONS,
    ExitConfig,
    expand_grid,
    expand_stop_loss_grid,
    grid_search,
    replay,
    simulate_trades,
)
from app.domain.rule import CrossoverRuleConfig, RangeBreakoutRuleConfig
from app.domain.range_breakout import evaluate_range_breakout
from app.domain.rules import CandleClose, bars_needed, evaluate

RULE = CrossoverRuleConfig(indicator_id="11111111-1111-1111-1111-111111111111")
RSI_PARAMS = {"period": 2, "sma_period": 2}


def _bias_fn(window: list[CandleClose]):
    """simulate_trades/replay took (rule, indicator_type, indicator_params)
    directly before being generalized to accept any bias_fn - this closure
    reproduces the exact same crossover bias computation these tests
    already relied on, so every existing call site below only needs its
    first three positional args collapsed into (_bias_fn, _MIN_BARS)."""
    return evaluate(RULE, "rsi", RSI_PARAMS, window)


_MIN_BARS = bars_needed(RULE, "rsi", RSI_PARAMS) + 1

# Same fixture as test_rules.py's hand-traced bearish-crossover case: the
# first 5 bars produce no signal, the 6th does (bearish, entry price=15).
_ENTRY_CLOSES = [10, 11, 10, 13, 20, 15]

_BASE_TS = datetime(2026, 8, 12, 9, 15)


def _ts(minute_offset: int) -> str:
    """Real, parseable ISO timestamps (not bare "t0" tags) - simulate_trades
    calls datetime.fromisoformat internally (square-off/previous-candle
    lookups), so every fixture needs genuinely parseable timestamps."""
    return (_BASE_TS + timedelta(minutes=minute_offset)).isoformat()


def _bar(minute_offset: int, close: float, high: float | None = None, low: float | None = None) -> CandleClose:
    return CandleClose(timestamp=_ts(minute_offset), close=close, high=high if high is not None else close, low=low if low is not None else close)


def _flat_candles(closes: list[float]) -> list[CandleClose]:
    """high=low=close - fine for fixtures that only exercise indicator/rule
    math (test_rules.py already covers that RSI math itself is correct),
    not backtest.py's intrabar SL/target logic."""
    return [_bar(i, c) for i, c in enumerate(closes)]


def _entry_fixture() -> list[CandleClose]:
    return _flat_candles(_ENTRY_CLOSES)


# --- expand_grid: cartesian product + validation -------------------------------------------


def test_expand_grid_cartesian_product_merged_onto_base_params():
    base = {"period": 14, "sma_period": 9}
    combos = expand_grid(base, {"period": [7, 21]})
    assert combos == [{"period": 7, "sma_period": 9}, {"period": 21, "sma_period": 9}]


def test_expand_grid_multiple_params_full_cartesian_product():
    base = {"period": 14, "sma_period": 9}
    combos = expand_grid(base, {"period": [7, 21], "sma_period": [5, 10]})
    assert combos == [
        {"period": 7, "sma_period": 5},
        {"period": 7, "sma_period": 10},
        {"period": 21, "sma_period": 5},
        {"period": 21, "sma_period": 10},
    ]


def test_expand_grid_unknown_param_name_raises():
    with pytest.raises(ValueError, match="unknown indicator param"):
        expand_grid({"period": 14, "sma_period": 9}, {"macd_fast": [12, 26]})


def test_expand_grid_empty_value_list_raises():
    with pytest.raises(ValueError, match="at least one candidate value"):
        expand_grid({"period": 14, "sma_period": 9}, {"period": []})


def test_expand_grid_too_many_combinations_raises():
    base = {"period": 14, "sma_period": 9}
    too_many = {"period": list(range(1, MAX_GRID_COMBINATIONS + 2))}
    with pytest.raises(ValueError, match="max is"):
        expand_grid(base, too_many)


# --- replay: shape + the "no exit config" case -----------------------------------------------


def test_replay_finds_the_single_known_signal_and_reports_end_of_data():
    # No exit_config -> no SL/target/square-off, and there's no opposite
    # signal after the only one - the trade stays open through the last
    # available bar, reported as "end_of_data".
    result = replay(_bias_fn, _MIN_BARS, _entry_fixture())

    assert result["trade_count"] == 1
    trade = result["trades"][0]
    assert trade["entry_time"] == _ts(5)
    assert trade["direction"] == "bearish"
    assert trade["entry_price"] == 15.0
    assert trade["exit_reason"] == "end_of_data"
    assert trade["exit_price"] == 15.0  # last candle's own close (itself)
    assert result["hypothetical_pnl"] == 0.0


def test_replay_too_few_candles_finds_nothing():
    candles = _flat_candles([10, 11, 12])
    result = replay(_bias_fn, _MIN_BARS, candles)
    assert result == {"trade_count": 0, "hypothetical_pnl": 0.0, "trades": []}


# --- simulate_trades: stop-loss / target / square-off / trailing -----------------------------


def test_simulate_trades_stop_loss_percent_hit():
    candles = _entry_fixture()
    # bearish entry@15, 10% stop = 15*1.10 = 16.5 - this bar's high spikes past it.
    candles.append(_bar(6, 18.0, high=20.0, low=17.0))

    trades = simulate_trades(_bias_fn, _MIN_BARS, candles, ExitConfig(stop_loss_method="percent", stop_loss_percent=10.0))

    assert len(trades) == 1
    trade = trades[0]
    assert trade.exit_reason == "stop_loss"
    assert trade.exit_price == pytest.approx(16.5)
    assert trade.pnl == pytest.approx(15.0 - 16.5)


def test_simulate_trades_target_percent_hit():
    candles = _entry_fixture()
    # bearish entry@15, 10% target = 15*0.90 = 13.5 - this bar's low dips past it.
    candles.append(_bar(6, 13.0, high=15.5, low=12.0))

    trades = simulate_trades(_bias_fn, _MIN_BARS, candles, ExitConfig(target_percent=10.0))

    assert len(trades) == 1
    trade = trades[0]
    assert trade.exit_reason == "target"
    assert trade.exit_price == pytest.approx(13.5)
    assert trade.pnl == pytest.approx(15.0 - 13.5)


def test_simulate_trades_stop_loss_takes_priority_over_target_on_same_bar():
    candles = _entry_fixture()
    # A single wide bar spans both the 10% stop (16.5) and 10% target (13.5).
    candles.append(_bar(6, 15.0, high=20.0, low=10.0))

    trades = simulate_trades(
        _bias_fn, _MIN_BARS, candles, ExitConfig(stop_loss_method="percent", stop_loss_percent=10.0, target_percent=10.0)
    )

    assert trades[0].exit_reason == "stop_loss"


def test_simulate_trades_neither_sl_nor_target_hit_keeps_scanning():
    candles = _entry_fixture()
    # Stays comfortably inside both the 10% stop (16.5) and target (13.5).
    candles.append(_bar(6, 15.0, high=15.5, low=14.5))

    trades = simulate_trades(
        _bias_fn, _MIN_BARS, candles, ExitConfig(stop_loss_method="percent", stop_loss_percent=10.0, target_percent=10.0)
    )

    assert len(trades) == 1
    assert trades[0].exit_reason == "end_of_data"  # ran out of bars, never hit either level


def test_simulate_trades_square_off_closes_at_bar_close():
    candles = _entry_fixture()
    candles[-1] = CandleClose(timestamp="2026-08-12T14:57:00", close=15.0, high=15.0, low=15.0)
    candles.append(CandleClose(timestamp="2026-08-12T15:03:00", close=14.2, high=14.5, low=14.0))

    trades = simulate_trades(_bias_fn, _MIN_BARS, candles, ExitConfig(square_off_time=time(15, 0)))

    assert len(trades) == 1
    trade = trades[0]
    assert trade.exit_reason == "square_off"
    assert trade.exit_price == 14.2  # square-off closes at CMP (the bar's close), not a level


def test_simulate_trades_entry_at_or_after_square_off_time_never_opens():
    candles = _entry_fixture()
    candles[-1] = CandleClose(timestamp="2026-08-12T15:05:00", close=15.0, high=15.0, low=15.0)

    trades = simulate_trades(_bias_fn, _MIN_BARS, candles, ExitConfig(square_off_time=time(15, 0)))

    assert trades == []  # would have been rejected outside the intraday window, same as execution


def test_simulate_trades_previous_candle_stop_loss():
    candles = _entry_fixture()  # entry at _ts(5)
    # sl_candles: a separate (lower) interval series - its last completed
    # bar strictly before the entry timestamp sets the bearish stop at
    # that bar's HIGH (16.0); the bar AFTER entry must be ignored even
    # though its high is higher still.
    sl_candles = [
        _bar(3, 12.0, high=13.0, low=9.0),
        _bar(4, 13.0, high=16.0, low=9.5),
        _bar(6, 17.0, high=18.0, low=16.0),
    ]
    candles.append(_bar(6, 17.0, high=17.5, low=16.5))  # crosses 16.0

    trades = simulate_trades(
        _bias_fn, _MIN_BARS, candles, ExitConfig(stop_loss_method="previous_candle"), sl_candles=sl_candles
    )

    assert len(trades) == 1
    assert trades[0].exit_reason == "stop_loss"
    assert trades[0].exit_price == pytest.approx(16.0)


def test_simulate_trades_previous_candle_stop_loss_missing_series_disables_sl():
    candles = _entry_fixture()
    candles.append(_bar(6, 18.0, high=20.0, low=17.0))  # would hit a percent-style stop, if one were configured

    trades = simulate_trades(_bias_fn, _MIN_BARS, candles, ExitConfig(stop_loss_method="previous_candle"), sl_candles=None)

    # No sl_candles supplied - stop-loss silently doesn't apply (no crash,
    # no stop_loss exit) - falls through to whatever else would close the
    # trade instead (here, an opposite RSI signal on that same bar).
    assert trades[0].exit_reason != "stop_loss"


def test_simulate_trades_indicator_ema_stop_loss():
    candles = _entry_fixture()  # bearish entry@15, ts(5)
    # period=2 EMA of closes strictly before ts(5) = flat 20s -> ema=20.0,
    # far above where bar(6)'s high could reach - proves the indicator
    # dispatch (not just previous_candle) drives the initial stop.
    sl_candles = [_bar(1, 20.0), _bar(2, 20.0), _bar(3, 20.0), _bar(4, 20.0)]
    candles.append(_bar(6, 21.0, high=22.0, low=19.0))  # crosses the ema=20.0 stop

    trades = simulate_trades(
        _bias_fn,
        _MIN_BARS,
        candles,
        ExitConfig(stop_loss_method="indicator", stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 2}),
        sl_candles=sl_candles,
    )

    assert len(trades) == 1
    assert trades[0].exit_reason == "stop_loss"
    assert trades[0].exit_price == pytest.approx(20.0)


def test_simulate_trades_indicator_stop_loss_missing_series_disables_sl():
    candles = _entry_fixture()
    candles.append(_bar(6, 18.0, high=20.0, low=17.0))  # would hit a percent-style stop, if one were configured

    trades = simulate_trades(
        _bias_fn,
        _MIN_BARS,
        candles,
        ExitConfig(stop_loss_method="indicator", stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 2}),
        sl_candles=None,
    )

    assert trades[0].exit_reason != "stop_loss"


def test_simulate_trades_indicator_ema_trailing_stop_ratchets_and_never_loosens():
    candles = _entry_fixture()  # bearish entry@15, ts(5)
    candles.append(_bar(6, 14.0, high=14.5, low=13.5))
    candles.append(_bar(7, 12.0, high=12.5, low=11.5))

    # Initial stop (as of ts(5), strictly-before filter) uses only offsets
    # 1-4 (flat 20s -> ema=20.0). offset 5's close=8.0 only enters the
    # window once the trailing loop evaluates bar(6) (ts(6) > ts(5)),
    # pulling the period=2 EMA down to 12.0 - a ratchet the position
    # couldn't have "seen" at entry, same as-of-this-point-in-time
    # semantics _previous_candle_stop_price already relies on.
    sl_candles = [_bar(1, 20.0), _bar(2, 20.0), _bar(3, 20.0), _bar(4, 20.0), _bar(5, 8.0)]

    trades = simulate_trades(
        _bias_fn,
        _MIN_BARS,
        candles,
        ExitConfig(
            stop_loss_method="indicator", stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 2},
            trailing_stop_enabled=True,
        ),
        sl_candles=sl_candles,
    )

    assert len(trades) == 1
    trade = trades[0]
    assert trade.exit_reason == "stop_loss"
    # Ratcheted down to the period=2 EMA of [20,20,20,20,8] = 12.0, not the
    # original 20.0 - and bar(6)'s high (14.5) didn't touch either stop, so
    # this can only be the tightened value.
    assert trade.exit_price == pytest.approx(12.0)


def test_simulate_trades_trailing_stop_ratchets_and_never_loosens():
    candles = _entry_fixture()  # bearish entry@15, initial 10% stop = 16.5
    # Price only ever moves favorably (down) for this short - the trailing
    # stop should ratchet down bar over bar, never back up.
    candles.append(_bar(6, 14.0, high=14.5, low=13.5))
    candles.append(_bar(7, 12.0, high=12.5, low=11.5))
    # Final bar's high (13.9) would NOT have hit the ORIGINAL 16.5 stop,
    # but should hit the ratcheted-down stop from bar t7 (12*1.10=13.2).
    candles.append(_bar(8, 13.5, high=13.9, low=13.0))

    trades = simulate_trades(
        _bias_fn,
        _MIN_BARS,
        candles,
        ExitConfig(stop_loss_method="percent", stop_loss_percent=10.0, trailing_stop_enabled=True),
    )

    assert len(trades) == 1
    trade = trades[0]
    assert trade.exit_reason == "stop_loss"
    assert trade.exit_price == pytest.approx(12.0 * 1.10)  # ratcheted stop from bar 7's close, not the original 16.5


def test_simulate_trades_single_signal_stays_open_to_end_of_data():
    # Sanity check that the base fixture alone only ever opens one trade
    # (no premature/duplicate entries while it's conceptually still open).
    trades = simulate_trades(_bias_fn, _MIN_BARS, _entry_fixture())
    assert len(trades) == 1


# --- simulate_trades: regime_indicators wiring ---------------------------------------------
#
# These monkeypatch backtest.evaluate_regime_indicator (the name bound in
# backtest.py's own module namespace via its `from app.domain.indicators
# import evaluate_regime_indicator`, not app.domain.indicators itself -
# simulate_trades calls the bare name, which resolves through backtest.py's
# globals) rather than engineering real price action that produces both a
# known RSI crossover AND known regime sub-values simultaneously - each
# check's own math correctness is already covered exhaustively in
# test_regime.py/test_indicators.py. What matters here is only that
# simulate_trades calls it correctly (ALL listed regime_indicators must
# agree, none by default) and skips/allows entries accordingly - the exact
# same all-must-agree gate app/domain/engine.py's _regime_confirmed uses
# live.


def _fake_regime_check(passing_types: set):
    """A stand-in for evaluate_regime_indicator: confirms `bias` for every
    (indicator_type, params) pair whose indicator_type is in
    `passing_types`, denies every other one - regardless of the actual
    candles/bias, so tests can control per-indicator pass/fail directly."""

    def _evaluate(indicator_type, params, candles, bias):
        return indicator_type in passing_types

    return _evaluate


def test_simulate_trades_regime_filter_blocks_entry_when_regime_disagrees(monkeypatch):
    monkeypatch.setattr(backtest_module, "evaluate_regime_indicator", _fake_regime_check(passing_types=set()))
    trades = simulate_trades(_bias_fn, _MIN_BARS, _entry_fixture(), regime_indicators=[("adx", {})])
    assert trades == []


def test_simulate_trades_regime_filter_allows_entry_when_regime_agrees(monkeypatch):
    monkeypatch.setattr(backtest_module, "evaluate_regime_indicator", _fake_regime_check(passing_types={"adx"}))
    trades = simulate_trades(_bias_fn, _MIN_BARS, _entry_fixture(), regime_indicators=[("adx", {})])
    assert len(trades) == 1
    assert trades[0].direction == "bearish"


def test_simulate_trades_regime_filter_requires_every_listed_indicator_to_agree(monkeypatch):
    # ADX confirms but ema_slope doesn't - ALL listed regime_indicators
    # must agree (not a majority), same all-must-agree gate engine.py's
    # _regime_confirmed uses.
    monkeypatch.setattr(backtest_module, "evaluate_regime_indicator", _fake_regime_check(passing_types={"adx"}))

    blocked = simulate_trades(
        _bias_fn, _MIN_BARS, _entry_fixture(), regime_indicators=[("adx", {}), ("ema_slope", {})]
    )
    assert blocked == []

    allowed = simulate_trades(_bias_fn, _MIN_BARS, _entry_fixture(), regime_indicators=[("adx", {})])
    assert len(allowed) == 1
    assert allowed[0].direction == "bearish"


def test_simulate_trades_regime_filter_empty_by_default_never_calls_evaluate_regime_indicator(monkeypatch):
    def _boom(*args, **kwargs):
        raise AssertionError("evaluate_regime_indicator must not be called when regime_indicators is empty")

    monkeypatch.setattr(backtest_module, "evaluate_regime_indicator", _boom)
    trades = simulate_trades(_bias_fn, _MIN_BARS, _entry_fixture())  # regime_indicators defaults to ()
    assert len(trades) == 1


def test_simulate_trades_matches_naive_pairing_when_no_exit_config():
    """Regression-equivalence check: with no SL/target/square-off
    configured, simulate_trades' walk-forward chaining must reproduce the
    OLD next-opposite-signal pairing exactly (enter on a signal, exit +
    flip on the next opposite one) for every PAIRED signal. RSI's own
    correctness is already covered by test_rules.py - this only proves
    the new engine's chaining behavior matches the old algorithm,
    reimplemented here verbatim as an oracle. One deliberate difference:
    the old pair_pnl left a final unpaired signal contributing nothing;
    simulate_trades instead marks it "end_of_data" against the last
    available close (a real improvement, not a bug) - folded into the
    oracle below rather than avoided."""
    closes = [10, 11, 10, 13, 20, 15, 12, 9, 14, 22, 18, 11, 16, 24, 19, 13, 21, 27]
    candles = _flat_candles(closes)

    min_bars = 5  # bars_needed(RULE, "rsi", RSI_PARAMS) + 1, per the hand-traced fixture above
    naive_signals = []
    for i in range(min_bars, len(candles) + 1):
        window = candles[:i]
        bias = evaluate(RULE, "rsi", RSI_PARAMS, window)
        if bias is not None:
            naive_signals.append((bias, window[-1].close))
    assert len(naive_signals) >= 2  # the fixture must actually exercise chaining to be a meaningful check

    expected_pnl = 0.0
    open_sig = None
    for direction, price in naive_signals:
        if open_sig is None:
            open_sig = (direction, price)
            continue
        open_dir, open_price = open_sig
        if direction == open_dir:
            continue
        expected_pnl += (price - open_price) if open_dir == "bullish" else (open_price - price)
        open_sig = (direction, price)
    if open_sig is not None:
        open_dir, open_price = open_sig
        last_close = candles[-1].close
        expected_pnl += (last_close - open_price) if open_dir == "bullish" else (open_price - last_close)

    trades = simulate_trades(_bias_fn, _MIN_BARS, candles)
    actual_pnl = sum(t.pnl for t in trades)

    assert actual_pnl == pytest.approx(expected_pnl)


# --- grid_search: runs replay per combination, sorted best-first ---------------------------


def test_grid_search_reports_one_row_per_combination_sorted_by_pnl_desc():
    # Swept across two period candidates so both windows still find the
    # one known signal - just checking the shape/sort here.
    candles = _entry_fixture()
    base = {"period": 2, "sma_period": 2}
    combos = expand_grid(base, {"period": [2, 3]})

    result = grid_search(RULE, "rsi", combos, candles)

    assert result["combinations_tested"] == 2
    assert len(result["results"]) == 2
    assert all("error" not in row for row in result["results"])
    pnls = [row["hypothetical_pnl"] for row in result["results"]]
    assert pnls == sorted(pnls, reverse=True)  # best first


def test_grid_search_invalid_combination_reported_as_error_not_dropped():
    candles = _entry_fixture()
    base = {"period": 2, "sma_period": 2}
    # period=1 violates RsiParams's Field(gt=1) - must surface as an error
    # row, not silently vanish or crash the whole grid.
    combos = expand_grid(base, {"period": [1, 2]})

    result = grid_search(RULE, "rsi", combos, candles)

    assert result["combinations_tested"] == 2
    errored = [row for row in result["results"] if "error" in row]
    ok = [row for row in result["results"] if "error" not in row]
    assert len(errored) == 1
    assert errored[0]["params"]["period"] == 1
    assert len(ok) == 1


def test_grid_search_all_invalid_still_returns_every_row_as_errors():
    candles = _entry_fixture()
    combos = expand_grid({"period": 2, "sma_period": 2}, {"period": [0, 1]})

    result = grid_search(RULE, "rsi", combos, candles)

    assert result["combinations_tested"] == 2
    assert all("error" in row for row in result["results"])


def test_grid_search_applies_the_same_exit_config_to_every_combination():
    candles = _entry_fixture()
    candles.append(_bar(6, 18.0, high=20.0, low=17.0))  # hits a 10% stop from entry@15
    combos = expand_grid({"period": 2, "sma_period": 2}, {"period": [2, 3]})

    result = grid_search(RULE, "rsi", combos, candles, ExitConfig(stop_loss_method="percent", stop_loss_percent=10.0))

    assert result["combinations_tested"] == 2
    assert all(row["trade_count"] == 1 for row in result["results"])
    assert all(row["hypothetical_pnl"] == pytest.approx(15.0 - 16.5) for row in result["results"])


# --- expand_stop_loss_grid: cartesian product, no base_params merge ------------------------


def test_expand_stop_loss_grid_cartesian_product():
    assert expand_stop_loss_grid({"period": [10, 20]}) == [{"period": 10}, {"period": 20}]


def test_expand_stop_loss_grid_empty_grid_raises():
    with pytest.raises(ValueError, match="at least one candidate value"):
        expand_stop_loss_grid({"period": []})


def test_expand_stop_loss_grid_too_many_combinations_raises():
    too_many = {"period": list(range(1, MAX_GRID_COMBINATIONS + 2))}
    with pytest.raises(ValueError, match="max is"):
        expand_stop_loss_grid(too_many)


# --- grid_search: stop_loss_indicator_combos second sweep dimension ------------------------


def test_grid_search_sweeps_stop_loss_indicator_params_independently():
    # period=2 EMA of [10,10,10,20] (all strictly before entry@ts(5)) =
    # 16.6667; period=4 EMA of the same 4 closes = 12.5 (mean-seeded,
    # exactly period-length) - genuinely different stop prices for the
    # SAME bearish entry, proving each row's own sl_combo actually drives
    # its own replay run rather than exit_config's single fixed value.
    sl_candles = [_bar(1, 10.0), _bar(2, 10.0), _bar(3, 10.0), _bar(4, 20.0)]
    candles = _entry_fixture()  # bearish entry@15, ts(5)
    candles.append(_bar(6, 17.0, high=17.0, low=16.0))  # crosses both candidate stops

    result = grid_search(
        RULE,
        "rsi",
        [{"period": 2, "sma_period": 2}],
        candles,
        ExitConfig(stop_loss_method="indicator", stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 999}),
        sl_candles=sl_candles,
        stop_loss_indicator_combos=[{"period": 2}, {"period": 4}],
    )

    assert result["combinations_tested"] == 2
    by_period = {row["stop_loss_indicator_params"]["period"]: row for row in result["results"]}
    assert by_period[2]["hypothetical_pnl"] == pytest.approx(15.0 - 16.666666666666668)
    assert by_period[4]["hypothetical_pnl"] == pytest.approx(15.0 - 12.5)
    # Sorted best-first - period=4's higher pnl (2.5) must lead period=2's (-1.667).
    assert result["results"][0]["stop_loss_indicator_params"]["period"] == 4


def test_grid_search_without_stop_loss_indicator_combos_keeps_old_result_shape():
    candles = _entry_fixture()
    combos = expand_grid({"period": 2, "sma_period": 2}, {"period": [2, 3]})

    result = grid_search(RULE, "rsi", combos, candles)

    assert result["combinations_tested"] == 2
    assert all("stop_loss_indicator_params" not in row for row in result["results"])


# --- range_breakout through the generalized (bias_fn) exit engine ----------------------------
# Confirms simulate_trades/replay's generalization actually works end-to-end for a rule with no
# indicator at all, not just crossover - same SL/target/square-off/opposite-signal/end-of-data
# exits, exercised via a range_breakout bias_fn instead of evaluate(rule, indicator_type, ...).

RANGE_RULE = RangeBreakoutRuleConfig(breakout_period=4)


def _range_bias_fn(window):
    return evaluate_range_breakout(RANGE_RULE, window)


_RANGE_MIN_BARS = RANGE_RULE.breakout_period + 1  # matches routes.py's backtest_strategy, not the more generous range_breakout_warmup (fetch-width padding, a separate concern)


def _range_entry_fixture() -> list[CandleClose]:
    # Flat range (10,10,10,10) then a clean bullish breakout to 15 - entry@15.
    return _flat_candles([10, 10, 10, 10, 15])


def test_replay_range_breakout_finds_the_breakout_and_reports_end_of_data():
    result = replay(_range_bias_fn, _RANGE_MIN_BARS, _range_entry_fixture())

    assert result["trade_count"] == 1
    trade = result["trades"][0]
    assert trade["direction"] == "bullish"
    assert trade["entry_price"] == 15.0
    assert trade["exit_reason"] == "end_of_data"


def test_simulate_trades_range_breakout_stop_loss_percent_hit():
    candles = _range_entry_fixture()
    candles.append(_bar(5, 13.0, high=13.5, low=13.0))  # breaches a 10% stop from entry@15 (13.5)

    trades = simulate_trades(
        _range_bias_fn, _RANGE_MIN_BARS, candles, ExitConfig(stop_loss_method="percent", stop_loss_percent=10.0)
    )

    assert len(trades) == 1
    assert trades[0].exit_reason == "stop_loss"


def test_simulate_trades_range_breakout_target_percent_hit():
    candles = _range_entry_fixture()
    candles.append(_bar(5, 17.0, high=17.0, low=16.5))  # reaches a 10% target from entry@15 (16.5)

    trades = simulate_trades(_range_bias_fn, _RANGE_MIN_BARS, candles, ExitConfig(target_percent=10.0))

    assert len(trades) == 1
    assert trades[0].exit_reason == "target"


def test_simulate_trades_range_breakout_square_off_closes_at_bar_close():
    candles = _range_entry_fixture()
    candles[-1] = CandleClose(timestamp="2026-08-12T14:57:00", close=15.0, high=15.0, low=15.0)
    candles.append(CandleClose(timestamp="2026-08-12T15:03:00", close=14.2, high=14.5, low=14.0))

    trades = simulate_trades(_range_bias_fn, _RANGE_MIN_BARS, candles, ExitConfig(square_off_time=time(15, 0)))

    assert len(trades) == 1
    assert trades[0].exit_reason == "square_off"
    assert trades[0].exit_price == 14.2


def test_simulate_trades_range_breakout_bearish_breakdown():
    candles = _flat_candles([10, 10, 10, 10, 5])  # breaks below the range low instead
    trades = simulate_trades(_range_bias_fn, _RANGE_MIN_BARS, candles)

    assert len(trades) == 1
    assert trades[0].direction == "bearish"
    assert trades[0].entry_price == 5.0
