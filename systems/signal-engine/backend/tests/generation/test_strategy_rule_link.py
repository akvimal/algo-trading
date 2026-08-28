"""Tests for app/api/routes/strategies.py's _stop_loss_fields_for_rule -
the consolidated helper that (a) forces a breakout-linked strategy's
stop-loss scheme onto the rule's own ltf_interval (HTF only ever arms the
setup - entry and the stop are both LTF-only), replacing the old
Strategy-vs-rule_config cross-check this logic used to be split across
(see app/domain/rule.py's validate_breakout_interval_consistency for the
other half, now a pure Rule-internal check), and (b) soft-defaults a
SuperTrend-crossover-linked strategy's stop-loss onto the SAME SuperTrend
line (added 2026-08-21) when the caller left stop_loss_method unset
entirely - see the function's own docstring for why this one is
overridable where breakout's is not. Same "plain fakes, no real
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
    interval: Optional[str] = None


@dataclass
class FakeIndicator:
    type: str
    params: dict


class FakeDb:
    """Stands in for the real Session - .get(model, id) ignores `model`
    (there's only ever one kind of row fetched here) and returns whatever
    indicator was configured, or raises if none was expected at all (lets
    the "must not override an explicit stop_loss_method" tests below prove
    the DB is never even consulted in that case)."""

    def __init__(self, indicator: Optional[FakeIndicator] = None):
        self._indicator = indicator

    def get(self, model, id):
        if self._indicator is None:
            raise AssertionError("db.get() should not have been called")
        return self._indicator


def test_stop_loss_fields_for_rule_forces_previous_candle_scheme_for_breakout():
    rule_row = FakeRule(rule_config=BREAKOUT_RULE_CONFIG)
    method, interval, percent, trailing, indicator_type, indicator_params = _stop_loss_fields_for_rule(
        FakeDb(), rule_row, None, None, None, False
    )
    assert method == "previous_candle"
    assert interval == "3min"  # the rule's own ltf_interval
    assert percent is None
    assert trailing is False
    assert indicator_type is None
    assert indicator_params is None


def test_stop_loss_fields_for_rule_overrides_whatever_was_requested_for_breakout():
    rule_row = FakeRule(rule_config=BREAKOUT_RULE_CONFIG)
    method, interval, percent, trailing, indicator_type, indicator_params = _stop_loss_fields_for_rule(
        FakeDb(), rule_row, "indicator", None, None, True, "ema", {"period": 20}
    )
    assert method == "previous_candle"
    assert interval == "3min"
    assert percent is None
    assert trailing is False
    assert indicator_type is None
    assert indicator_params is None


def test_stop_loss_fields_for_rule_rejects_unsupported_ltf_interval():
    # "daily" is a valid Interval (Rule condition timeframes allow it) but
    # deliberately excluded from StopLossInterval - the intraday
    # candle-history endpoints stop-loss fetching relies on don't serve
    # it at all (see StopLossInterval's own comment, app/domain/models.py).
    rule_row = FakeRule(rule_config={**BREAKOUT_RULE_CONFIG, "ltf_interval": "daily"})
    with pytest.raises(HTTPException) as exc_info:
        _stop_loss_fields_for_rule(FakeDb(), rule_row, None, None, None, False)
    assert exc_info.value.status_code == 422
    assert "supported stop-loss intervals" in exc_info.value.detail


def test_stop_loss_fields_for_rule_passes_through_unchanged_for_no_rule():
    # An external (webhook) strategy carries no Rule at all now (rule_id
    # is None) - not a Rule row with an empty rule_config.
    result = _stop_loss_fields_for_rule(FakeDb(), None, "previous_candle", "5min", None, False)
    assert result == ("previous_candle", "5min", None, False, None, None)


# --- SuperTrend-crossover soft default (added 2026-08-21) -------------------

ST_INDICATOR = FakeIndicator(type="supertrend", params={"period": 10, "multiplier": 3.0})
RSI_INDICATOR = FakeIndicator(type="rsi", params={"period": 14, "sma_period": 9})


def test_stop_loss_fields_for_rule_defaults_to_supertrend_when_unset():
    rule_row = FakeRule(rule_config=CROSSOVER_RULE_CONFIG, interval="5min")
    result = _stop_loss_fields_for_rule(FakeDb(ST_INDICATOR), rule_row, None, None, None, False)
    assert result == ("indicator", "5min", None, True, "supertrend", {"period": 10, "multiplier": 3.0})


def test_stop_loss_fields_for_rule_does_not_override_explicit_percent_for_supertrend_crossover():
    # db.get() must never be called here - FakeDb() with no indicator
    # raises if it is, proving the explicit request short-circuits the
    # default before any lookup.
    rule_row = FakeRule(rule_config=CROSSOVER_RULE_CONFIG, interval="5min")
    result = _stop_loss_fields_for_rule(FakeDb(), rule_row, "percent", None, 5.0, True)
    assert result == ("percent", None, 5.0, True, None, None)


def test_stop_loss_fields_for_rule_does_not_override_explicit_indicator_for_supertrend_crossover():
    rule_row = FakeRule(rule_config=CROSSOVER_RULE_CONFIG, interval="5min")
    result = _stop_loss_fields_for_rule(FakeDb(), rule_row, "indicator", "15min", None, True, "ema", {"period": 20})
    assert result == ("indicator", "15min", None, True, "ema", {"period": 20})


def test_stop_loss_fields_for_rule_skips_default_for_non_supertrend_crossover_indicator():
    # The rule's own crossover indicator is "rsi", not "supertrend" - no
    # default to apply, passes stop_loss_method=None straight through
    # (same as before this feature existed).
    rule_row = FakeRule(rule_config=CROSSOVER_RULE_CONFIG, interval="5min")
    result = _stop_loss_fields_for_rule(FakeDb(RSI_INDICATOR), rule_row, None, None, None, False)
    assert result == (None, None, None, False, None, None)


def test_stop_loss_fields_for_rule_skips_default_when_rule_interval_is_daily():
    # 'daily' isn't a valid stop_loss_interval (same restriction breakout's
    # own ltf_interval check enforces) - unlike breakout, this is a soft
    # default, so it's silently skipped rather than a 422: the caller can
    # still configure a stop-loss by hand, just not this auto-derived one.
    rule_row = FakeRule(rule_config=CROSSOVER_RULE_CONFIG, interval="daily")
    result = _stop_loss_fields_for_rule(FakeDb(), rule_row, None, None, None, False)
    assert result == (None, None, None, False, None, None)
