"""Tests for app/api/routes/strategies.py's _stop_loss_fields_for_rule -
the new consolidated helper that forces a breakout-linked strategy's
stop-loss scheme onto the rule's own htf_interval, replacing the old
Strategy-vs-rule_config cross-check this logic used to be split across
(see app/domain/rule.py's validate_breakout_interval_consistency for the
other half, now a pure Rule-internal check). Same "plain fakes, no real
Session/TestClient" convention as tests/test_backtest_universe_route.py -
there's no dedicated CRUD/HTTP route test layer anywhere in this backend
(confirmed: no conftest.py, TestClient used only in test_health.py), so
route-level correctness for create_strategy/update_strategy/rules CRUD is
verified live against the running dev stack instead, not here."""

from dataclasses import dataclass
from typing import Optional

import pytest
from fastapi import HTTPException

from app.api.routes.strategies import _stop_loss_fields_for_rule

BREAKOUT_RULE_CONFIG = {
    "type": "breakout",
    "htf_interval": "15min",
    "htf_breakout_period": 20,
    "ltf_interval": "3min",
    "ltf_breakout_period": 10,
}
CROSSOVER_RULE_CONFIG = {"type": "crossover", "indicator_id": "11111111-1111-1111-1111-111111111111"}


@dataclass
class FakeRule:
    rule_config: Optional[dict] = None


def test_stop_loss_fields_for_rule_forces_previous_candle_scheme_for_breakout():
    rule_row = FakeRule(rule_config=BREAKOUT_RULE_CONFIG)
    method, interval, percent, trailing, indicator_type, indicator_params = _stop_loss_fields_for_rule(
        rule_row, None, None, None, False
    )
    assert method == "previous_candle"
    assert interval == "15min"  # the rule's own htf_interval
    assert percent is None
    assert trailing is False
    assert indicator_type is None
    assert indicator_params is None


def test_stop_loss_fields_for_rule_overrides_whatever_was_requested_for_breakout():
    rule_row = FakeRule(rule_config=BREAKOUT_RULE_CONFIG)
    method, interval, percent, trailing, indicator_type, indicator_params = _stop_loss_fields_for_rule(
        rule_row, "indicator", None, None, True, "ema", {"period": 20}
    )
    assert method == "previous_candle"
    assert interval == "15min"
    assert percent is None
    assert trailing is False
    assert indicator_type is None
    assert indicator_params is None


def test_stop_loss_fields_for_rule_rejects_unsupported_htf_interval():
    # "daily" is a valid Interval (Rule condition timeframes allow it) but
    # deliberately excluded from StopLossInterval - the intraday
    # candle-history endpoints stop-loss fetching relies on don't serve
    # it at all (see StopLossInterval's own comment, app/domain/models.py).
    rule_row = FakeRule(rule_config={**BREAKOUT_RULE_CONFIG, "htf_interval": "daily"})
    with pytest.raises(HTTPException) as exc_info:
        _stop_loss_fields_for_rule(rule_row, None, None, None, False)
    assert exc_info.value.status_code == 422
    assert "supported stop-loss intervals" in exc_info.value.detail


def test_stop_loss_fields_for_rule_passes_through_unchanged_for_crossover():
    rule_row = FakeRule(rule_config=CROSSOVER_RULE_CONFIG)
    result = _stop_loss_fields_for_rule(rule_row, "percent", None, 5.0, True)
    assert result == ("percent", None, 5.0, True, None, None)


def test_stop_loss_fields_for_rule_passes_through_unchanged_for_indicator():
    rule_row = FakeRule(rule_config=CROSSOVER_RULE_CONFIG)
    result = _stop_loss_fields_for_rule(rule_row, "indicator", "5min", None, True, "ema", {"period": 20})
    assert result == ("indicator", "5min", None, True, "ema", {"period": 20})


def test_stop_loss_fields_for_rule_passes_through_unchanged_for_no_rule():
    # An external (webhook) strategy carries no Rule at all now (rule_id
    # is None) - not a Rule row with an empty rule_config.
    result = _stop_loss_fields_for_rule(None, "previous_candle", "5min", None, False)
    assert result == ("previous_candle", "5min", None, False, None, None)
