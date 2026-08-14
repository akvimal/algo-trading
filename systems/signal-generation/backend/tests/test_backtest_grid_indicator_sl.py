"""RuleBacktestGridRequest used to reject stop_loss_method='indicator'
outright (a 422, Literal["previous_candle", "percent"] didn't include
it) - grid search's own shared helpers (_exit_config_for/_sl_candles_for
in app/api/routes/rules.py) already handled either request type via
getattr, but _sl_candles_for's indicator branch reads
payload.stop_loss_indicator_params directly (no getattr) - once the
Literal was widened without also adding that field to the grid request
model, this would have raised AttributeError instead. These tests cover
both: the model accepts the field, and the two helpers actually use it
correctly for a grid-shaped payload."""

from dataclasses import dataclass
from datetime import date

import pytest
from pydantic import ValidationError

import app.api.routes.rules as rules_route
from app.domain.rule import RuleBacktestGridRequest


@dataclass
class FakeRule:
    interval: str = "5min"


@dataclass
class FakeResolved:
    chart_exchange: str = "NSE"
    chart_symbol: str = "NIFTY"


def test_grid_request_accepts_indicator_stop_loss():
    payload = RuleBacktestGridRequest(
        param_grid={"period": [10, 14]},
        stop_loss_method="indicator",
        stop_loss_interval="5min",
        stop_loss_indicator_type="ema",
        stop_loss_indicator_params={"period": 20},
    )
    assert payload.stop_loss_method == "indicator"
    assert payload.stop_loss_indicator_type == "ema"
    assert payload.stop_loss_indicator_params == {"period": 20}


def test_grid_request_rejects_unknown_stop_loss_method():
    with pytest.raises(ValidationError):
        RuleBacktestGridRequest(param_grid={"period": [10]}, stop_loss_method="not_a_real_method")


def test_exit_config_for_grid_request_carries_indicator_fields():
    payload = RuleBacktestGridRequest(
        param_grid={"period": [10]},
        stop_loss_method="indicator",
        stop_loss_interval="5min",
        stop_loss_indicator_type="ema",
        stop_loss_indicator_params={"period": 20},
    )
    exit_config = rules_route._exit_config_for(payload)
    assert exit_config.stop_loss_method == "indicator"
    assert exit_config.stop_loss_indicator_type == "ema"
    assert exit_config.stop_loss_indicator_params == {"period": 20}


def test_sl_candles_for_grid_request_fetches_indicator_history(monkeypatch):
    payload = RuleBacktestGridRequest(
        param_grid={"period": [10]},
        stop_loss_method="indicator",
        stop_loss_interval="5min",
        stop_loss_indicator_type="ema",
        stop_loss_indicator_params={"period": 20},
    )
    calls = []

    def fake_get_candle_history(exchange, symbol, interval, from_date, to_date):
        calls.append((exchange, symbol, interval))
        return ["fake-candles"]

    monkeypatch.setattr(rules_route, "get_candle_history", fake_get_candle_history)

    result = rules_route._sl_candles_for(
        payload, FakeRule(), FakeResolved(), candles=[], fetch_from=date(2026, 8, 1), to=date(2026, 8, 13)
    )

    assert result == ["fake-candles"]
    assert calls == [("NSE", "NIFTY", "5min")]


def test_sl_candles_for_grid_request_previous_candle_still_works(monkeypatch):
    # Guards against the widened indicator support having broken the
    # pre-existing previous_candle branch on the same shared helper.
    payload = RuleBacktestGridRequest(param_grid={"period": [10]}, stop_loss_method="previous_candle", stop_loss_interval="15min")
    calls = []

    def fake_get_candle_history(exchange, symbol, interval, from_date, to_date):
        calls.append((exchange, symbol, interval))
        return ["fake-candles"]

    monkeypatch.setattr(rules_route, "get_candle_history", fake_get_candle_history)

    result = rules_route._sl_candles_for(
        payload, FakeRule(interval="5min"), FakeResolved(), candles=["reused"], fetch_from=date(2026, 8, 1), to=date(2026, 8, 13)
    )

    # stop_loss_interval (15min) differs from rule_row.interval (5min) -
    # fetches its own series rather than reusing `candles`.
    assert result == ["fake-candles"]
    assert calls == [("NSE", "NIFTY", "15min")]
