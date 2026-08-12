import pytest
from pydantic import ValidationError

from app.domain.models import (
    BreakoutRuleConfig,
    CrossoverRuleConfig,
    StrategyCreate,
    validate_in_house_fields,
    validate_rule_config,
)

INDICATOR_ID = "11111111-1111-1111-1111-111111111111"
RULE_CONFIG = {"type": "crossover", "indicator_id": INDICATOR_ID}
BREAKOUT_RULE_CONFIG = {
    "type": "breakout",
    "htf_interval": "15min",
    "htf_breakout_period": 20,
    "ltf_interval": "3min",
    "ltf_breakout_period": 10,
}


def _in_house(**overrides) -> dict:
    defaults = dict(
        name="GOLDM RSI",
        source_type="in_house",
        horizon="intraday",
        instrument_type="future",
        segment="MCX",
        underlying="GOLDM",
        rule_config=RULE_CONFIG,
        interval="5min",
    )
    defaults.update(overrides)
    return defaults


# --- validate_rule_config -------------------------------------------------------------------


def test_validate_rule_config_accepts_valid_crossover():
    rule = validate_rule_config(RULE_CONFIG)
    assert isinstance(rule, CrossoverRuleConfig)
    assert rule.indicator_id == INDICATOR_ID


def test_validate_rule_config_rejects_unknown_type():
    with pytest.raises(ValidationError):
        validate_rule_config({"type": "threshold", "indicator_id": INDICATOR_ID})


def test_validate_rule_config_rejects_missing_indicator_id():
    with pytest.raises(ValidationError):
        validate_rule_config({"type": "crossover"})


# --- BreakoutRuleConfig / RuleConfig Union --------------------------------------------------


def test_validate_rule_config_accepts_valid_breakout():
    rule = validate_rule_config(BREAKOUT_RULE_CONFIG)
    assert isinstance(rule, BreakoutRuleConfig)
    assert rule.htf_interval == "15min"
    assert rule.htf_breakout_period == 20
    assert rule.ltf_interval == "3min"
    assert rule.ltf_breakout_period == 10
    assert rule.ema_filter_enabled is False  # default
    assert rule.ema_period == 20  # default


def test_validate_rule_config_breakout_ema_filter_fields():
    rule = validate_rule_config({**BREAKOUT_RULE_CONFIG, "ema_filter_enabled": True, "ema_period": 50})
    assert isinstance(rule, BreakoutRuleConfig)
    assert rule.ema_filter_enabled is True
    assert rule.ema_period == 50


def test_breakout_rule_config_rejects_htf_period_not_greater_than_one():
    with pytest.raises(ValidationError):
        BreakoutRuleConfig(htf_interval="15min", htf_breakout_period=1, ltf_interval="3min", ltf_breakout_period=10)


def test_breakout_rule_config_rejects_ltf_period_not_greater_than_one():
    with pytest.raises(ValidationError):
        BreakoutRuleConfig(htf_interval="15min", htf_breakout_period=20, ltf_interval="3min", ltf_breakout_period=1)


def test_breakout_rule_config_rejects_bad_interval():
    with pytest.raises(ValidationError):
        BreakoutRuleConfig(htf_interval="not_a_real_interval", htf_breakout_period=20, ltf_interval="3min", ltf_breakout_period=10)


def test_validate_rule_config_still_resolves_crossover_correctly_alongside_breakout():
    # Regression guard for extending RuleConfig into a two-member Union -
    # the discriminator must still route each shape to its own model.
    crossover = validate_rule_config(RULE_CONFIG)
    breakout = validate_rule_config(BREAKOUT_RULE_CONFIG)
    assert isinstance(crossover, CrossoverRuleConfig)
    assert isinstance(breakout, BreakoutRuleConfig)


# --- validate_in_house_fields ---------------------------------------------------------------


def test_validate_in_house_fields_accepts_complete_config():
    validate_in_house_fields("in_house", "GOLDM", RULE_CONFIG, "5min")  # no raise


def test_validate_in_house_fields_requires_underlying():
    with pytest.raises(ValueError, match="requires underlying"):
        validate_in_house_fields("in_house", None, RULE_CONFIG, "5min")


def test_validate_in_house_fields_requires_rule_config():
    with pytest.raises(ValueError, match="requires rule_config"):
        validate_in_house_fields("in_house", "GOLDM", None, "5min")


def test_validate_in_house_fields_requires_interval():
    with pytest.raises(ValueError, match="requires interval"):
        validate_in_house_fields("in_house", "GOLDM", RULE_CONFIG, None)


def test_validate_in_house_fields_forbids_underlying_for_webhook_source():
    with pytest.raises(ValueError, match="only applies to source_type='in_house'"):
        validate_in_house_fields("chartink", "GOLDM", None, None)


def test_validate_in_house_fields_forbids_rule_config_for_webhook_source():
    with pytest.raises(ValueError, match="only applies to source_type='in_house'"):
        validate_in_house_fields("chartink", None, RULE_CONFIG, None)


def test_validate_in_house_fields_webhook_source_with_nothing_set_is_fine():
    validate_in_house_fields("chartink", None, None, None)  # no raise


# --- StrategyCreate integration --------------------------------------------------------------


def test_strategy_create_in_house_valid():
    s = StrategyCreate(**_in_house())
    assert s.underlying == "GOLDM"
    assert s.rule_config == RULE_CONFIG
    assert s.segment == "MCX"


def test_strategy_create_in_house_missing_underlying_rejected():
    with pytest.raises(ValidationError, match="requires underlying"):
        StrategyCreate(**_in_house(underlying=None))


def test_strategy_create_in_house_missing_rule_config_rejected():
    with pytest.raises(ValidationError, match="requires rule_config"):
        StrategyCreate(**_in_house(rule_config=None))


def test_strategy_create_in_house_missing_interval_rejected():
    with pytest.raises(ValidationError, match="requires interval"):
        StrategyCreate(**_in_house(interval=None))


def test_strategy_create_in_house_bad_rule_type_rejected():
    with pytest.raises(ValidationError):
        StrategyCreate(**_in_house(rule_config={"type": "unknown_rule"}))


def test_strategy_create_chartink_with_underlying_rejected():
    with pytest.raises(ValidationError, match="only applies to source_type='in_house'"):
        StrategyCreate(
            name="x",
            source_type="chartink",
            horizon="intraday",
            instrument_type="spot",
            square_off_time="15:00:00",
            underlying="GOLDM",
        )


def test_strategy_create_chartink_without_in_house_fields_still_works():
    s = StrategyCreate(
        name="x",
        source_type="chartink",
        horizon="intraday",
        instrument_type="spot",
        square_off_time="15:00:00",
    )
    assert s.underlying is None
    assert s.rule_config is None
