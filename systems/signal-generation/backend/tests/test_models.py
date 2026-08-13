import pytest
from pydantic import ValidationError

from app.domain.models import (
    StrategyCreate,
    StrategyUpdate,
    default_square_off_time,
    validate_contract_day_filter_fields,
    validate_rule_link_consistency,
    validate_stop_loss_fields,
)

RULE_ID = "11111111-1111-1111-1111-111111111111"


def test_strategy_create_defaults_exchange_to_nse():
    s = StrategyCreate(
        name="Bullish Breakout v1",
        source_type="chartink",
        horizon="intraday",
        instrument_type="spot",
        rule_id=RULE_ID,
        square_off_time="15:00:00",
    )
    assert s.exchange == "NSE"


def test_strategy_create_accepts_arbitrary_external_source_type():
    # source_type is free-form (any external provider name) - only
    # 'in_house' is a reserved/special value. Not in a fixed enum, so an
    # unrecognized provider name like this must be accepted, not rejected.
    s = StrategyCreate(
        name="x",
        source_type="not-a-real-provider",
        horizon="intraday",
        instrument_type="spot",
        rule_id=RULE_ID,
        square_off_time="15:00:00",
    )
    assert s.source_type == "not-a-real-provider"


def test_strategy_create_rejects_empty_source_type():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x",
            source_type="",
            horizon="intraday",
            instrument_type="spot",
            rule_id=RULE_ID,
            square_off_time="15:00:00",
        )


def test_strategy_create_requires_rule_id():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="15:00:00",
        )


def test_strategy_create_square_off_time_optional_for_non_intraday():
    # square-off doesn't apply to swing/positional - no default, no requirement either.
    s = StrategyCreate(name="x", source_type="chartink", horizon="swing", instrument_type="spot", rule_id=RULE_ID)
    assert s.square_off_time is None


def test_strategy_create_positional_square_off_time_optional():
    s = StrategyCreate(name="x", source_type="chartink", horizon="positional", instrument_type="spot", rule_id=RULE_ID)
    assert s.square_off_time is None


def test_strategy_update_all_fields_optional():
    u = StrategyUpdate()
    assert u.status is None
    assert u.horizon is None
    assert u.square_off_time is None
    assert u.segment is None
    assert u.rule_id is None


def test_strategy_update_rejects_short_name():
    with pytest.raises(ValidationError):
        StrategyUpdate(name="")


def test_strategy_create_defaults_no_stop_loss():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, square_off_time="15:00:00",
    )
    assert s.stop_loss_method is None
    assert s.trailing_stop_enabled is False


def test_strategy_create_previous_candle_method_requires_interval():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            square_off_time="15:00:00", stop_loss_method="previous_candle",
        )


def test_strategy_create_previous_candle_method_forbids_percent():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            square_off_time="15:00:00",
            stop_loss_method="previous_candle", stop_loss_interval="5min", stop_loss_percent=2.0,
        )


def test_strategy_create_percent_method_requires_percent():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            square_off_time="15:00:00", stop_loss_method="percent",
        )


def test_strategy_create_percent_method_forbids_interval():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            square_off_time="15:00:00",
            stop_loss_method="percent", stop_loss_percent=2.0, stop_loss_interval="5min",
        )


def test_strategy_create_trailing_without_method_rejected():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            square_off_time="15:00:00", trailing_stop_enabled=True,
        )


def test_strategy_create_valid_previous_candle_with_trailing():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
        square_off_time="15:00:00",
        stop_loss_method="previous_candle", stop_loss_interval="5min", trailing_stop_enabled=True,
        target_percent=4.0,
    )
    assert s.stop_loss_interval == "5min"
    assert s.target_percent == 4.0


def test_strategy_create_accepts_square_off_time_string():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, square_off_time="14:30:00",
    )
    assert s.square_off_time.isoformat() == "14:30:00"


def test_strategy_create_stop_loss_percent_out_of_bounds_rejected():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            square_off_time="15:00:00", stop_loss_method="percent", stop_loss_percent=150.0,
        )


def test_validate_stop_loss_fields_no_method_allows_no_extras():
    validate_stop_loss_fields(None, None, None, False)  # should not raise


def test_validate_stop_loss_fields_no_method_rejects_trailing():
    with pytest.raises(ValueError):
        validate_stop_loss_fields(None, None, None, True)


# --- segment-driven square_off_time defaulting ---------------------------------------------


def test_default_square_off_time_nse_intraday():
    assert default_square_off_time("intraday", "NSE").isoformat() == "15:00:00"


def test_default_square_off_time_mcx_intraday():
    assert default_square_off_time("intraday", "MCX").isoformat() == "22:00:00"


def test_default_square_off_time_crypto_intraday():
    assert default_square_off_time("intraday", "CRYPTO").isoformat() == "17:25:00"


def test_default_square_off_time_none_for_non_intraday():
    assert default_square_off_time("swing", "NSE") is None
    assert default_square_off_time("positional", "MCX") is None


def test_strategy_create_defaults_segment_to_nse():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, square_off_time="15:00:00",
    )
    assert s.segment == "NSE"


def test_strategy_create_auto_fills_square_off_time_for_nse_intraday():
    s = StrategyCreate(name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID)
    assert s.square_off_time.isoformat() == "15:00:00"


def test_strategy_create_auto_fills_square_off_time_for_mcx_intraday():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, segment="MCX",
    )
    assert s.square_off_time.isoformat() == "22:00:00"


def test_strategy_create_auto_fills_square_off_time_for_crypto_intraday():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, segment="CRYPTO",
    )
    assert s.square_off_time.isoformat() == "17:25:00"


def test_strategy_create_explicit_square_off_time_overrides_default():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, square_off_time="09:30:00",
    )
    assert s.square_off_time.isoformat() == "09:30:00"


def test_strategy_create_rejects_unknown_segment():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, segment="BSE",
        )


def test_strategy_create_defaults_signal_conflict_policy():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, square_off_time="15:00:00",
    )
    assert s.duplicate_signal_policy == "skip"
    assert s.counter_signal_policy == "close_and_flip"


def test_strategy_create_accepts_explicit_signal_conflict_policy():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, square_off_time="15:00:00",
        duplicate_signal_policy="add_position", counter_signal_policy="close_and_flip",
    )
    assert s.duplicate_signal_policy == "add_position"
    assert s.counter_signal_policy == "close_and_flip"


def test_strategy_create_defaults_option_fields():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="option", rule_id=RULE_ID, square_off_time="15:00:00",
    )
    assert s.option_position_style == "spread"
    assert s.option_strike_moneyness == "ATM"
    assert s.option_sl_scope == "combined"


def test_strategy_create_accepts_explicit_option_sl_scope():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="option", rule_id=RULE_ID, square_off_time="15:00:00",
        option_sl_scope="individual",
    )
    assert s.option_sl_scope == "individual"


def test_strategy_create_rejects_unknown_option_sl_scope():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="option", rule_id=RULE_ID, square_off_time="15:00:00",
            option_sl_scope="per_leg",
        )


def test_strategy_create_defaults_option_fixed_lots_to_none():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="option", rule_id=RULE_ID, square_off_time="15:00:00",
    )
    assert s.option_fixed_lots is None


def test_strategy_create_accepts_explicit_option_fixed_lots():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="option", rule_id=RULE_ID, square_off_time="15:00:00",
        option_fixed_lots=5,
    )
    assert s.option_fixed_lots == 5


def test_strategy_create_rejects_non_positive_option_fixed_lots():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="option", rule_id=RULE_ID, square_off_time="15:00:00",
            option_fixed_lots=0,
        )


def test_strategy_create_rejects_unknown_duplicate_signal_policy():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, square_off_time="15:00:00",
            duplicate_signal_policy="always_new",
        )


def test_strategy_create_defaults_contract_day_filter_to_any():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="option", rule_id=RULE_ID, square_off_time="15:00:00",
    )
    assert s.contract_day_filter == "any"


def test_strategy_create_accepts_expiry_day_filter_for_future():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="future", rule_id=RULE_ID, square_off_time="15:00:00",
        contract_day_filter="expiry",
    )
    assert s.contract_day_filter == "expiry"


def test_strategy_create_accepts_start_day_filter_for_option():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="option", rule_id=RULE_ID, square_off_time="15:00:00",
        contract_day_filter="start",
    )
    assert s.contract_day_filter == "start"


def test_strategy_create_rejects_start_day_filter_for_future():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="future", rule_id=RULE_ID, square_off_time="15:00:00",
            contract_day_filter="start",
        )


def test_strategy_create_rejects_unknown_contract_day_filter():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="option", rule_id=RULE_ID, square_off_time="15:00:00",
            contract_day_filter="mid_cycle",
        )


def test_validate_contract_day_filter_fields_rejects_start_for_future():
    with pytest.raises(ValueError):
        validate_contract_day_filter_fields("start", "future")


def test_validate_contract_day_filter_fields_accepts_start_for_option():
    validate_contract_day_filter_fields("start", "option")


def test_validate_contract_day_filter_fields_accepts_expiry_for_future():
    validate_contract_day_filter_fields("expiry", "future")


def test_validate_contract_day_filter_fields_accepts_any_for_future():
    validate_contract_day_filter_fields("any", "future")


def test_strategy_create_rejects_unknown_counter_signal_policy():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, square_off_time="15:00:00",
            counter_signal_policy="close_only",
        )


def test_strategy_update_signal_conflict_policy_fields_optional():
    u = StrategyUpdate()
    assert u.duplicate_signal_policy is None
    assert u.counter_signal_policy is None


# --- validate_rule_link_consistency (Strategy<->Rule source_type match, checked at the route ---
# layer once the referenced Rule is loaded - see app/api/routes/strategies.py) ------------------


def test_validate_rule_link_consistency_accepts_matching_source_types():
    validate_rule_link_consistency("in_house", "in_house")  # no raise
    validate_rule_link_consistency("chartink", "chartink")  # no raise


def test_validate_rule_link_consistency_rejects_in_house_strategy_with_external_rule():
    with pytest.raises(ValueError, match="does not match"):
        validate_rule_link_consistency("in_house", "chartink")


def test_validate_rule_link_consistency_rejects_external_strategy_with_in_house_rule():
    with pytest.raises(ValueError, match="does not match"):
        validate_rule_link_consistency("chartink", "in_house")


def test_validate_rule_link_consistency_rejects_mismatched_external_providers():
    with pytest.raises(ValueError, match="does not match"):
        validate_rule_link_consistency("chartink", "tradingview")


# --- active_from_time/active_to_time (per-strategy signal-acceptance window) -----------------


def test_strategy_create_active_window_unset_by_default():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, square_off_time="15:00:00",
    )
    assert s.active_from_time is None
    assert s.active_to_time is None


def test_strategy_create_accepts_active_window():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, square_off_time="15:00:00",
        active_from_time="09:15:00", active_to_time="11:00:00",
    )
    assert s.active_from_time.isoformat() == "09:15:00"
    assert s.active_to_time.isoformat() == "11:00:00"


def test_strategy_create_rejects_active_window_missing_to():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            square_off_time="15:00:00", active_from_time="09:15:00",
        )


def test_strategy_create_rejects_active_window_missing_from():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            square_off_time="15:00:00", active_to_time="11:00:00",
        )


def test_strategy_create_rejects_active_window_to_before_from():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            square_off_time="15:00:00", active_from_time="11:00:00", active_to_time="09:15:00",
        )


def test_strategy_create_rejects_active_window_equal_from_and_to():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            square_off_time="15:00:00", active_from_time="09:15:00", active_to_time="09:15:00",
        )


def test_strategy_update_active_window_fields_optional():
    u = StrategyUpdate()
    assert u.active_from_time is None
    assert u.active_to_time is None
