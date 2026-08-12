import pytest

from app.domain.indicators import compute_indicator, compute_indicator_signal, compute_rsi, compute_sma, indicator_warmup


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
    assert compute_indicator("rsi", {"period": 2}, closes) == compute_rsi(closes, period=2)


def test_compute_indicator_unknown_type_raises():
    with pytest.raises(ValueError, match="no compute rule"):
        compute_indicator("macd", {}, [10.0, 11.0])


def test_compute_indicator_signal_dispatches_rsi_sma():
    # RSI's own signal line is the SMA of its own value series - bundled
    # into the indicator's params (sma_period), not a rule parameter.
    closes = [10.0, 11.0, 10.0, 13.0, 20.0]
    rsi = compute_rsi(closes, period=2)
    expected = compute_sma(rsi, period=2)
    assert compute_indicator_signal("rsi", {"period": 2, "sma_period": 2}, closes) == expected


def test_compute_indicator_signal_unknown_type_raises():
    with pytest.raises(ValueError, match="no signal rule"):
        compute_indicator_signal("macd", {}, [10.0, 11.0])


def test_indicator_warmup_rsi_is_period_plus_sma_period():
    assert indicator_warmup("rsi", {"period": 14, "sma_period": 9}) == 23


def test_indicator_warmup_unknown_type_raises():
    with pytest.raises(ValueError, match="no warmup rule"):
        indicator_warmup("macd", {})
