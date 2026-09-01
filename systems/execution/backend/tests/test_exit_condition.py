"""Unit tests for the ported exit_condition evaluator (app/domain/
exit_condition.py) - the subset of signal-engine's Term/Condition
evaluation execution re-implements locally for a live per-tick exit
watch."""

import pytest

from app.domain.exit_condition import (
    compute_cci,
    evaluate_exit_condition,
    exit_condition_warmup,
)


def _candles(*closes: float):
    return [{"open": c, "high": c, "low": c, "close": c, "volume": 0.0} for c in closes]


def test_compute_cci_matches_reference_shape():
    # 2 flat bars + 1 outlier below always lands CCI at exactly -100 for
    # period 3 (Lambert's 0.015 constant is calibrated so ~1.5 mean
    # deviations == 100) - a clean, hand-verifiable reference point.
    series = compute_cci(_candles(110, 110, 110, 110, 110, 110, 95), period=3)
    assert series[0] is None and series[1] is None  # warm-up
    assert series[-1] == pytest.approx(-100.0)


def test_evaluate_exit_condition_cci_below_level_true_when_price_crashes():
    condition = {
        "interval": "5min",
        "left": {"kind": "cci", "period": 3, "offset_bars": 0, "scale": 1.0, "value": None, "field": None},
        "operator": "<",
        "right": {"kind": "constant", "period": None, "offset_bars": 0, "scale": 1.0, "value": -90.0, "field": None},
    }
    assert evaluate_exit_condition(condition, _candles(110, 110, 110, 110, 110, 110, 95)) is True
    assert evaluate_exit_condition(condition, _candles(90, 95, 100, 105, 110, 115, 120)) is False


def test_evaluate_exit_condition_none_when_still_warming_up():
    condition = {
        "interval": "5min",
        "left": {"kind": "cci", "period": 20, "offset_bars": 0, "scale": 1.0, "value": None, "field": None},
        "operator": "<",
        "right": {"kind": "constant", "period": None, "offset_bars": 0, "scale": 1.0, "value": 0.0, "field": None},
    }
    assert evaluate_exit_condition(condition, _candles(1, 2, 3)) is None
    assert evaluate_exit_condition(condition, []) is None


def test_evaluate_exit_condition_price_vs_ema():
    condition = {
        "interval": "15min",
        "left": {"kind": "price", "field": "close", "period": None, "offset_bars": 0, "scale": 1.0, "value": None},
        "operator": "<",
        "right": {"kind": "ema", "field": "close", "period": 3, "offset_bars": 0, "scale": 1.0, "value": None},
    }
    # last close (90) well under a still-elevated EMA of a falling series
    assert evaluate_exit_condition(condition, _candles(120, 118, 115, 108, 100, 90)) is True


def test_unsupported_term_kind_raises():
    condition = {
        "interval": "5min",
        "left": {"kind": "volume", "field": None, "period": None, "offset_bars": 0, "scale": 1.0, "value": None},
        "operator": ">",
        "right": {"kind": "constant", "period": None, "offset_bars": 0, "scale": 1.0, "value": 0.0, "field": None},
    }
    with pytest.raises(ValueError):
        evaluate_exit_condition(condition, _candles(1, 2, 3, 4))


def test_exit_condition_warmup_is_max_period_plus_offset():
    condition = {
        "interval": "5min",
        "left": {"kind": "cci", "period": 200, "offset_bars": 1, "scale": 1.0, "value": None, "field": None},
        "operator": "<",
        "right": {"kind": "constant", "period": None, "offset_bars": 0, "scale": 1.0, "value": 200.0, "field": None},
    }
    assert exit_condition_warmup(condition) == 201
