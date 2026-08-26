import pytest

from app.domain import regime as regime_module
from app.domain.indicators import (
    compute_indicator,
    compute_indicator_signal,
    compute_rsi,
    compute_sma,
    evaluate_regime_indicator,
    indicator_warmup,
    regime_indicator_warmup,
)
from app.domain.regime import compute_supertrend
from app.domain.rules import CandleClose


def _candles(closes: list[float]) -> list[CandleClose]:
    # high=low=close - matches test_rules.py's own helper; only supertrend
    # cares about high/low, exercised separately below with real ones.
    return [CandleClose(timestamp=f"t{i}", close=c, high=c, low=c) for i, c in enumerate(closes)]


def test_compute_rsi_warmup_period_is_none():
    closes = [10.0, 11.0, 12.0, 13.0]  # period=3 needs 4 closes for the first value
    rsi = compute_rsi(closes, period=3)
    assert rsi[:3] == [None, None, None]
    assert rsi[3] is not None


def test_compute_rsi_too_few_closes_all_none():
    rsi = compute_rsi([10.0, 11.0], period=5)
    assert rsi == [None, None]


def test_compute_rsi_all_gains_is_100():
    closes = [10.0, 11.0, 12.0, 13.0, 14.0, 15.0]
    rsi = compute_rsi(closes, period=3)
    assert rsi[3] == 100.0
    assert rsi[-1] == 100.0


def test_compute_rsi_all_losses_is_0():
    closes = [15.0, 14.0, 13.0, 12.0, 11.0, 10.0]
    rsi = compute_rsi(closes, period=3)
    assert rsi[3] == 0.0
    assert rsi[-1] == 0.0


def test_compute_rsi_known_values():
    # Hand-traced against Wilder's formula - see test_rules.py's docstring
    # for the full by-hand derivation this shares data with.
    closes = [10.0, 11.0, 10.0, 13.0, 20.0]
    rsi = compute_rsi(closes, period=2)
    assert rsi[2] == 50.0
    assert rsi[3] == 87.5
    assert round(rsi[4], 4) == 97.2222


def test_compute_sma_known_average():
    values = [1.0, 2.0, 3.0, 4.0, 5.0]
    sma = compute_sma(values, period=3)
    assert sma[:2] == [None, None]
    assert sma[2] == 2.0
    assert sma[3] == 3.0
    assert sma[4] == 4.0


def test_compute_sma_skips_windows_containing_none():
    values = [None, 10.0, 20.0, 30.0]
    sma = compute_sma(values, period=2)
    assert sma == [None, None, 15.0, 25.0]


# --- compute_indicator / indicator_warmup: the per-type dispatchers --------------------------


def test_compute_indicator_dispatches_rsi():
    closes = [10.0, 11.0, 10.0, 13.0, 20.0]
    assert compute_indicator("rsi", {"period": 2}, _candles(closes)) == compute_rsi(closes, period=2)


def test_compute_indicator_dispatches_supertrend_to_close_series():
    # SuperTrend's crossover VALUE series is just price itself - "value
    # crosses signal" against the ST line (compute_indicator_signal below)
    # is the standard "SuperTrend flip" entry signal.
    closes = [10.0, 11.0, 10.0, 13.0, 20.0]
    assert compute_indicator("supertrend", {"period": 2, "multiplier": 3.0}, _candles(closes)) == closes


def test_compute_indicator_unknown_type_raises():
    with pytest.raises(ValueError, match="no compute rule"):
        compute_indicator("macd", {}, _candles([10.0, 11.0]))


def test_compute_indicator_signal_dispatches_rsi_sma():
    # RSI's own signal line is the SMA of its own value series - bundled
    # into the indicator's params (sma_period), not a rule parameter.
    closes = [10.0, 11.0, 10.0, 13.0, 20.0]
    rsi = compute_rsi(closes, period=2)
    expected = compute_sma(rsi, period=2)
    assert compute_indicator_signal("rsi", {"period": 2, "sma_period": 2}, _candles(closes)) == expected


def test_compute_indicator_signal_dispatches_supertrend_line():
    # Real high/low (not high=low=close) since SuperTrend's ATR needs a
    # genuine range - mirrors test_regime.py's own compute_supertrend fixtures.
    candles = [
        CandleClose(timestamp="t0", close=10.0, high=11.0, low=9.0),
        CandleClose(timestamp="t1", close=11.0, high=12.0, low=10.0),
        CandleClose(timestamp="t2", close=12.0, high=13.0, low=11.0),
        CandleClose(timestamp="t3", close=9.0, high=10.0, low=8.0),
    ]
    params = {"period": 2, "multiplier": 3.0}
    assert compute_indicator_signal("supertrend", params, candles) == compute_supertrend(candles, period=2, multiplier=3.0)


def test_compute_indicator_signal_unknown_type_raises():
    with pytest.raises(ValueError, match="no signal rule"):
        compute_indicator_signal("macd", {}, _candles([10.0, 11.0]))


def test_indicator_warmup_rsi_is_period_plus_sma_period():
    assert indicator_warmup("rsi", {"period": 14, "sma_period": 9}) == 23


def test_indicator_warmup_supertrend_is_period_plus_one():
    assert indicator_warmup("supertrend", {"period": 10, "multiplier": 3.0}) == 11


def test_indicator_warmup_unknown_type_raises():
    with pytest.raises(ValueError, match="no warmup rule"):
        indicator_warmup("macd", {})


# --- evaluate_regime_indicator / regime_indicator_warmup: the regime-type dispatchers --------
#
# These monkeypatch app.domain.regime's own check_* functions (imported
# lazily, function-local, by evaluate_regime_indicator - see this module's
# own TYPE_CHECKING note) rather than engineering real candle fixtures -
# each check's own math correctness is already covered exhaustively in
# test_regime.py. What matters here is only that evaluate_regime_indicator
# dispatches to the right function with the right params extracted from
# the params dict.


def test_evaluate_regime_indicator_dispatches_structure(monkeypatch):
    calls = []

    def _fake(candles, bias, swing_lookback):
        calls.append((candles, bias, swing_lookback))
        return True

    monkeypatch.setattr(regime_module, "check_structure", _fake)
    result = evaluate_regime_indicator("structure", {"swing_lookback": 3}, ["candles"], "bullish")
    assert result is True
    assert calls == [(["candles"], "bullish", 3)]


def test_evaluate_regime_indicator_dispatches_efficiency_ratio(monkeypatch):
    calls = []

    def _fake(candles, bias, period, trend_threshold):
        calls.append((candles, bias, period, trend_threshold))
        return False

    monkeypatch.setattr(regime_module, "check_efficiency_ratio", _fake)
    result = evaluate_regime_indicator("efficiency_ratio", {"period": 14, "trend_threshold": 0.35}, ["c"], "bearish")
    assert result is False
    assert calls == [(["c"], "bearish", 14, 0.35)]


def test_evaluate_regime_indicator_dispatches_adx(monkeypatch):
    calls = []

    def _fake(candles, bias, period, trend_threshold):
        calls.append((candles, bias, period, trend_threshold))
        return True

    monkeypatch.setattr(regime_module, "check_adx", _fake)
    result = evaluate_regime_indicator("adx", {"period": 14, "trend_threshold": 20.0}, ["c"], "bullish")
    assert result is True
    assert calls == [(["c"], "bullish", 14, 20.0)]


def test_evaluate_regime_indicator_dispatches_dmi_direction(monkeypatch):
    calls = []

    def _fake(candles, bias, period):
        calls.append((candles, bias, period))
        return None

    monkeypatch.setattr(regime_module, "check_dmi_direction", _fake)
    result = evaluate_regime_indicator("dmi_direction", {"period": 14}, ["c"], "bullish")
    assert result is None
    assert calls == [(["c"], "bullish", 14)]


def test_evaluate_regime_indicator_dispatches_ema_slope(monkeypatch):
    calls = []

    def _fake(candles, bias, ema_period, slope_lookback, slope_threshold, atr_period):
        calls.append((candles, bias, ema_period, slope_lookback, slope_threshold, atr_period))
        return True

    monkeypatch.setattr(regime_module, "check_ema_slope", _fake)
    params = {"ema_period": 20, "slope_lookback": 5, "slope_threshold": 0.15, "atr_period": 14}
    result = evaluate_regime_indicator("ema_slope", params, ["c"], "bearish")
    assert result is True
    assert calls == [(["c"], "bearish", 20, 5, 0.15, 14)]


def test_evaluate_regime_indicator_dispatches_supertrend(monkeypatch):
    calls = []

    def _fake(candles, bias, period, multiplier):
        calls.append((candles, bias, period, multiplier))
        return True

    monkeypatch.setattr(regime_module, "check_supertrend", _fake)
    params = {"period": 10, "multiplier": 3.0}
    result = evaluate_regime_indicator("supertrend", params, ["c"], "bearish")
    assert result is True
    assert calls == [(["c"], "bearish", 10, 3.0)]


def test_evaluate_regime_indicator_unknown_type_raises():
    with pytest.raises(ValueError, match="no regime-evaluate rule"):
        evaluate_regime_indicator("rsi", {}, [], "bullish")


def test_regime_indicator_warmup_structure_is_swing_lookback_times_eight():
    assert regime_indicator_warmup("structure", {"swing_lookback": 3}) == 24


def test_regime_indicator_warmup_efficiency_ratio_is_period_plus_one():
    assert regime_indicator_warmup("efficiency_ratio", {"period": 14, "trend_threshold": 0.35}) == 15


def test_regime_indicator_warmup_adx_is_period_times_three():
    assert regime_indicator_warmup("adx", {"period": 14, "trend_threshold": 20.0}) == 42


def test_regime_indicator_warmup_dmi_direction_is_period_times_three():
    assert regime_indicator_warmup("dmi_direction", {"period": 14}) == 42


def test_regime_indicator_warmup_ema_slope_is_widest_of_ema_and_atr_settle():
    params = {"ema_period": 20, "slope_lookback": 5, "slope_threshold": 0.15, "atr_period": 14}
    assert regime_indicator_warmup("ema_slope", params) == max(20 + 5, 14 + 1)


def test_regime_indicator_warmup_supertrend_is_period_plus_one():
    assert regime_indicator_warmup("supertrend", {"period": 10, "multiplier": 3.0}) == 11


def test_regime_indicator_warmup_unknown_type_raises():
    with pytest.raises(ValueError, match="no regime-warmup rule"):
        regime_indicator_warmup("rsi", {})
