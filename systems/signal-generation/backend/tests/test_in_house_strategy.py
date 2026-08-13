import pytest
from pydantic import ValidationError

from app.domain.rule import (
    BreakoutRuleConfig,
    CrossoverRuleConfig,
    RuleCreate,
    validate_rule_config,
    validate_rule_in_house_fields,
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


# --- validate_rule_in_house_fields -----------------------------------------------------------
# Rule is in-house only now - underlying/rule_config/interval are always
# required unconditionally, no source_type branch anymore.


def test_validate_rule_in_house_fields_accepts_complete_config():
    validate_rule_in_house_fields("GOLDM", RULE_CONFIG, "5min")  # no raise


def test_validate_rule_in_house_fields_requires_underlying():
    with pytest.raises(ValueError, match="underlying is required"):
        validate_rule_in_house_fields(None, RULE_CONFIG, "5min")


def test_validate_rule_in_house_fields_requires_rule_config():
    with pytest.raises(ValueError, match="rule_config is required"):
        validate_rule_in_house_fields("GOLDM", None, "5min")


def test_validate_rule_in_house_fields_requires_interval():
    with pytest.raises(ValueError, match="interval is required"):
        validate_rule_in_house_fields("GOLDM", RULE_CONFIG, None)


# --- RuleCreate integration --------------------------------------------------------------


def test_rule_create_in_house_valid():
    r = RuleCreate(**_in_house())
    assert r.underlying == "GOLDM"
    assert r.rule_config == RULE_CONFIG
    assert r.segment == "MCX"


def test_rule_create_in_house_missing_underlying_rejected():
    with pytest.raises(ValidationError, match="underlying is required"):
        RuleCreate(**_in_house(underlying=None))


def test_rule_create_in_house_missing_rule_config_rejected():
    with pytest.raises(ValidationError, match="rule_config is required"):
        RuleCreate(**_in_house(rule_config=None))


def test_rule_create_in_house_missing_interval_rejected():
    with pytest.raises(ValidationError, match="interval is required"):
        RuleCreate(**_in_house(interval=None))


def test_rule_create_in_house_bad_rule_type_rejected():
    with pytest.raises(ValidationError):
        RuleCreate(**_in_house(rule_config={"type": "unknown_rule"}))


def test_rule_create_breakout_requires_interval_equal_ltf_interval():
    with pytest.raises(ValidationError, match="interval must equal rule_config.ltf_interval"):
        RuleCreate(**_in_house(rule_config=BREAKOUT_RULE_CONFIG, interval="5min"))


def test_rule_create_breakout_with_matching_interval_is_fine():
    r = RuleCreate(**_in_house(rule_config=BREAKOUT_RULE_CONFIG, interval="3min"))
    assert r.interval == "3min"


def test_rule_create_universe_requires_nse_segment():
    with pytest.raises(ValidationError, match="requires segment='NSE'"):
        RuleCreate(**_in_house(segment="MCX", underlying_type="universe"))


def test_rule_create_universe_with_nse_segment_is_fine():
    r = RuleCreate(**_in_house(segment="NSE", underlying_type="universe", underlying="NIFTYBANK"))
    assert r.underlying_type == "universe"
