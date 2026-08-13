import pytest
from pydantic import ValidationError

from app.domain.models import (
    StrategyCreate,
    StrategyUpdate,
    default_square_off_time,
    validate_contract_day_filter_fields,
    validate_stop_loss_fields,
)


def test_strategy_create_defaults_exchange_to_nse():
    s = StrategyCreate(
        name="Bullish Breakout v1",
        source_type="chartink",
        horizon="intraday",
        instrument_type="spot",
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
            square_off_time="15:00:00",
        )


def test_strategy_create_square_off_time_optional_for_non_intraday():
    # square-off doesn't apply to swing/positional - no default, no requirement either.
    s = StrategyCreate(name="x", source_type="chartink", horizon="swing", instrument_type="spot")
    assert s.square_off_time is None


def test_strategy_create_positional_square_off_time_optional():
    s = StrategyCreate(name="x", source_type="chartink", horizon="positional", instrument_type="spot")
    assert s.square_off_time is None


def test_strategy_update_all_fields_optional():
    u = StrategyUpdate()
    assert u.status is None
    assert u.horizon is None
    assert u.square_off_time is None
    assert u.segment is None


def test_strategy_update_rejects_short_name():
    with pytest.raises(ValidationError):
        StrategyUpdate(name="")


def test_strategy_create_defaults_no_stop_loss():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="15:00:00",
    )
    assert s.stop_loss_method is None
    assert s.trailing_stop_enabled is False


def test_strategy_create_previous_candle_method_requires_interval():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot",
            square_off_time="15:00:00", stop_loss_method="previous_candle",
        )


def test_strategy_create_previous_candle_method_forbids_percent():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot",
            square_off_time="15:00:00",
            stop_loss_method="previous_candle", stop_loss_interval="5min", stop_loss_percent=2.0,
        )


def test_strategy_create_percent_method_requires_percent():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot",
            square_off_time="15:00:00", stop_loss_method="percent",
        )


def test_strategy_create_percent_method_forbids_interval():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot",
            square_off_time="15:00:00",
            stop_loss_method="percent", stop_loss_percent=2.0, stop_loss_interval="5min",
        )


def test_strategy_create_trailing_without_method_rejected():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot",
            square_off_time="15:00:00", trailing_stop_enabled=True,
        )


def test_strategy_create_valid_previous_candle_with_trailing():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot",
        square_off_time="15:00:00",
        stop_loss_method="previous_candle", stop_loss_interval="5min", trailing_stop_enabled=True,
        target_percent=4.0,
    )
    assert s.stop_loss_interval == "5min"
    assert s.target_percent == 4.0


def test_strategy_create_accepts_square_off_time_string():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="14:30:00",
    )
    assert s.square_off_time.isoformat() == "14:30:00"


def test_strategy_create_stop_loss_percent_out_of_bounds_rejected():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot",
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
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="15:00:00",
    )
    assert s.segment == "NSE"


def test_strategy_create_auto_fills_square_off_time_for_nse_intraday():
    s = StrategyCreate(name="x", source_type="chartink", horizon="intraday", instrument_type="spot")
    assert s.square_off_time.isoformat() == "15:00:00"


def test_strategy_create_auto_fills_square_off_time_for_mcx_intraday():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", segment="MCX",
    )
    assert s.square_off_time.isoformat() == "22:00:00"


def test_strategy_create_auto_fills_square_off_time_for_crypto_intraday():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", segment="CRYPTO",
    )
    assert s.square_off_time.isoformat() == "17:25:00"


def test_strategy_create_explicit_square_off_time_overrides_default():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="09:30:00",
    )
    assert s.square_off_time.isoformat() == "09:30:00"


def test_strategy_create_rejects_unknown_segment():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", segment="BSE",
        )


def test_strategy_create_defaults_signal_conflict_policy():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="15:00:00",
    )
    assert s.duplicate_signal_policy == "skip"
    assert s.counter_signal_policy == "close_and_flip"


def test_strategy_create_accepts_explicit_signal_conflict_policy():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="15:00:00",
        duplicate_signal_policy="add_position", counter_signal_policy="close_and_flip",
    )
    assert s.duplicate_signal_policy == "add_position"
    assert s.counter_signal_policy == "close_and_flip"


def test_strategy_create_defaults_option_fields():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="option", square_off_time="15:00:00",
    )
    assert s.option_position_style == "spread"
    assert s.option_strike_moneyness == "ATM"
    assert s.option_sl_scope == "combined"


def test_strategy_create_accepts_explicit_option_sl_scope():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="option", square_off_time="15:00:00",
        option_sl_scope="individual",
    )
    assert s.option_sl_scope == "individual"


def test_strategy_create_rejects_unknown_option_sl_scope():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="option", square_off_time="15:00:00",
            option_sl_scope="per_leg",
        )


def test_strategy_create_rejects_unknown_duplicate_signal_policy():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="15:00:00",
            duplicate_signal_policy="always_new",
        )


def test_strategy_create_defaults_contract_day_filter_to_any():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="option", square_off_time="15:00:00",
    )
    assert s.contract_day_filter == "any"


def test_strategy_create_accepts_expiry_day_filter_for_future():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="future", square_off_time="15:00:00",
        contract_day_filter="expiry",
    )
    assert s.contract_day_filter == "expiry"


def test_strategy_create_accepts_start_day_filter_for_option():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="option", square_off_time="15:00:00",
        contract_day_filter="start",
    )
    assert s.contract_day_filter == "start"


def test_strategy_create_rejects_start_day_filter_for_future():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="future", square_off_time="15:00:00",
            contract_day_filter="start",
        )


def test_strategy_create_rejects_unknown_contract_day_filter():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="option", square_off_time="15:00:00",
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
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="15:00:00",
            counter_signal_policy="close_only",
        )


def _in_house_kwargs(**overrides):
    defaults = dict(
        name="x", source_type="in_house", horizon="intraday", instrument_type="spot",
        square_off_time="15:00:00", interval="5min", underlying="NIFTYBANK",
        rule_config={"type": "range_breakout", "breakout_period": 5},
    )
    defaults.update(overrides)
    return defaults


def test_strategy_create_defaults_underlying_type_to_symbol():
    s = StrategyCreate(**_in_house_kwargs(underlying="RELIANCE"))
    assert s.underlying_type == "symbol"


def test_strategy_create_accepts_universe_underlying_type_on_nse_spot():
    s = StrategyCreate(**_in_house_kwargs(underlying_type="universe"))
    assert s.underlying_type == "universe"
    assert s.underlying == "NIFTYBANK"


def test_strategy_create_rejects_universe_underlying_type_on_mcx():
    with pytest.raises(ValidationError, match="requires segment='NSE'"):
        StrategyCreate(**_in_house_kwargs(underlying_type="universe", segment="MCX"))


def test_strategy_create_rejects_universe_underlying_type_on_future():
    with pytest.raises(ValidationError, match="requires segment='NSE'"):
        StrategyCreate(**_in_house_kwargs(underlying_type="universe", instrument_type="future"))


def test_strategy_create_rejects_unknown_underlying_type():
    with pytest.raises(ValidationError):
        StrategyCreate(**_in_house_kwargs(underlying_type="watchlist"))


def test_strategy_update_underlying_type_optional():
    u = StrategyUpdate()
    assert u.underlying_type is None


# --- RangeBreakoutRuleConfig -----------------------------------------------------------------


def test_strategy_create_accepts_range_breakout_rule():
    s = StrategyCreate(**_in_house_kwargs())
    assert s.rule_config == {"type": "range_breakout", "breakout_period": 5}


def test_strategy_create_rejects_range_breakout_period_not_greater_than_one():
    with pytest.raises(ValidationError):
        StrategyCreate(**_in_house_kwargs(rule_config={"type": "range_breakout", "breakout_period": 1}))


def test_strategy_update_signal_conflict_policy_fields_optional():
    u = StrategyUpdate()
    assert u.duplicate_signal_policy is None
    assert u.counter_signal_policy is None


# --- active_from_time/active_to_time (per-strategy signal-acceptance window) -----------------


def test_strategy_create_active_window_unset_by_default():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="15:00:00",
    )
    assert s.active_from_time is None
    assert s.active_to_time is None


def test_strategy_create_accepts_active_window():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="15:00:00",
        active_from_time="09:15:00", active_to_time="11:00:00",
    )
    assert s.active_from_time.isoformat() == "09:15:00"
    assert s.active_to_time.isoformat() == "11:00:00"


def test_strategy_create_rejects_active_window_missing_to():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot",
            square_off_time="15:00:00", active_from_time="09:15:00",
        )


def test_strategy_create_rejects_active_window_missing_from():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot",
            square_off_time="15:00:00", active_to_time="11:00:00",
        )


def test_strategy_create_rejects_active_window_to_before_from():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot",
            square_off_time="15:00:00", active_from_time="11:00:00", active_to_time="09:15:00",
        )


def test_strategy_create_rejects_active_window_equal_from_and_to():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot",
            square_off_time="15:00:00", active_from_time="09:15:00", active_to_time="09:15:00",
        )


def test_strategy_update_active_window_fields_optional():
    u = StrategyUpdate()
    assert u.active_from_time is None
    assert u.active_to_time is None
