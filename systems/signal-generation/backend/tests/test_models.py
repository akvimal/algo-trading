import pytest
from pydantic import ValidationError

from app.domain.models import (
    StrategyCreate,
    StrategyUpdate,
    validate_contract_day_filter_fields,
    validate_stop_loss_fields,
)

RULE_ID = "11111111-1111-1111-1111-111111111111"


def test_strategy_create_defaults_exchange_to_nse():
    s = StrategyCreate(
        name="Bullish Breakout v1",
        source_type="in_house",
        horizon="intraday",
        instrument_type="spot",
        rule_id=RULE_ID,
    )
    assert s.exchange == "NSE"


def test_strategy_create_accepts_arbitrary_external_source_type():
    # source_type is free-form (any external provider name) - only
    # 'in_house' is a reserved/special value. Not in a fixed enum, so an
    # unrecognized provider name like this must be accepted, not rejected.
    # No rule_id - external strategies carry no Rule at all (see
    # validate_strategy_rule_requirement).
    s = StrategyCreate(
        name="x",
        source_type="not-a-real-provider",
        horizon="intraday",
        instrument_type="spot",
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
        )


def test_strategy_create_requires_rule_id_for_in_house():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot",
        )


def test_strategy_create_forbids_rule_id_for_external():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
        )


def test_strategy_update_all_fields_optional():
    u = StrategyUpdate()
    assert u.status is None
    assert u.horizon is None
    assert u.segment is None
    assert u.rule_id is None


def test_strategy_update_rejects_short_name():
    with pytest.raises(ValidationError):
        StrategyUpdate(name="")


def test_strategy_create_defaults_no_stop_loss():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
    )
    assert s.stop_loss_method is None
    assert s.trailing_stop_enabled is False


def test_strategy_create_previous_candle_method_requires_interval():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            stop_loss_method="previous_candle",
        )


def test_strategy_create_previous_candle_method_forbids_percent():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            stop_loss_method="previous_candle", stop_loss_interval="5min", stop_loss_percent=2.0,
        )


def test_strategy_create_percent_method_requires_percent():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            stop_loss_method="percent",
        )


def test_strategy_create_percent_method_forbids_interval():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            stop_loss_method="percent", stop_loss_percent=2.0, stop_loss_interval="5min",
        )


def test_strategy_create_trailing_without_method_rejected():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            trailing_stop_enabled=True,
        )


def test_strategy_create_valid_previous_candle_with_trailing():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
        stop_loss_method="previous_candle", stop_loss_interval="5min", trailing_stop_enabled=True,
        target_percent=4.0,
    )
    assert s.stop_loss_interval == "5min"
    assert s.target_percent == 4.0


def test_strategy_create_stop_loss_percent_out_of_bounds_rejected():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            stop_loss_method="percent", stop_loss_percent=150.0,
        )


def test_strategy_create_indicator_method_requires_interval():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            stop_loss_method="indicator", stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 20},
        )


def test_strategy_create_indicator_method_requires_indicator_type_and_params():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            stop_loss_method="indicator", stop_loss_interval="5min",
        )


def test_strategy_create_indicator_method_forbids_percent():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            stop_loss_method="indicator", stop_loss_interval="5min",
            stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 20},
            stop_loss_percent=2.0,
        )


def test_strategy_create_indicator_method_rejects_malformed_params():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            stop_loss_method="indicator", stop_loss_interval="5min",
            stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 1},
        )


def test_strategy_create_indicator_method_rejects_unknown_indicator_type():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            stop_loss_method="indicator", stop_loss_interval="5min",
            stop_loss_indicator_type="supertrend", stop_loss_indicator_params={"period": 20},
        )


def test_strategy_create_valid_indicator_with_trailing():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
        stop_loss_method="indicator", stop_loss_interval="5min",
        stop_loss_indicator_type="ema", stop_loss_indicator_params={"period": 20},
        trailing_stop_enabled=True,
    )
    assert s.stop_loss_indicator_type == "ema"
    assert s.stop_loss_indicator_params == {"period": 20}


def test_validate_stop_loss_fields_no_method_allows_no_extras():
    validate_stop_loss_fields(None, None, None, False)  # should not raise


def test_validate_stop_loss_fields_no_method_rejects_trailing():
    with pytest.raises(ValueError):
        validate_stop_loss_fields(None, None, None, True)


def test_strategy_create_defaults_segment_to_nse():
    s = StrategyCreate(name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID)
    assert s.segment == "NSE"


def test_strategy_create_rejects_unknown_segment():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID, segment="BSE",
        )


def test_strategy_create_defaults_signal_conflict_policy():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
    )
    assert s.duplicate_signal_policy == "skip"
    assert s.counter_signal_policy == "close_and_flip"


def test_strategy_create_accepts_explicit_signal_conflict_policy():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
        duplicate_signal_policy="add_position", counter_signal_policy="close_and_flip",
    )
    assert s.duplicate_signal_policy == "add_position"
    assert s.counter_signal_policy == "close_and_flip"


def test_strategy_create_defaults_option_fields():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="option", rule_id=RULE_ID,
    )
    assert s.option_position_style == "spread"
    assert s.option_strike_moneyness == "ATM"
    assert s.option_sl_scope == "combined"


def test_strategy_create_accepts_explicit_option_sl_scope():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="option", rule_id=RULE_ID,
        option_sl_scope="individual",
    )
    assert s.option_sl_scope == "individual"


def test_strategy_create_rejects_unknown_option_sl_scope():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="option", rule_id=RULE_ID,
            option_sl_scope="per_leg",
        )


def test_strategy_create_defaults_option_fixed_lots_to_none():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="option", rule_id=RULE_ID,
    )
    assert s.option_fixed_lots is None


def test_strategy_create_accepts_explicit_option_fixed_lots():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="option", rule_id=RULE_ID,
        option_fixed_lots=5,
    )
    assert s.option_fixed_lots == 5


def test_strategy_create_rejects_non_positive_option_fixed_lots():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="option", rule_id=RULE_ID,
            option_fixed_lots=0,
        )


def test_strategy_create_rejects_unknown_duplicate_signal_policy():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            duplicate_signal_policy="always_new",
        )


def test_strategy_create_defaults_contract_day_filter_to_any():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="option", rule_id=RULE_ID,
    )
    assert s.contract_day_filter == "any"


def test_strategy_create_accepts_expiry_day_filter_for_future():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="future", rule_id=RULE_ID,
        contract_day_filter="expiry",
    )
    assert s.contract_day_filter == "expiry"


def test_strategy_create_accepts_start_day_filter_for_option():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="option", rule_id=RULE_ID,
        contract_day_filter="start",
    )
    assert s.contract_day_filter == "start"


def test_strategy_create_rejects_start_day_filter_for_future():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="future", rule_id=RULE_ID,
            contract_day_filter="start",
        )


def test_strategy_create_rejects_unknown_contract_day_filter():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="option", rule_id=RULE_ID,
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
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            counter_signal_policy="close_only",
        )


def test_strategy_update_signal_conflict_policy_fields_optional():
    u = StrategyUpdate()
    assert u.duplicate_signal_policy is None
    assert u.counter_signal_policy is None


# --- active_windows (per-strategy signal-acceptance window(s)) -------------------------------


def test_strategy_create_active_windows_empty_by_default():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
    )
    assert s.active_windows == []


def test_strategy_create_accepts_one_active_window():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
        active_windows=[{"start": "09:15:00", "end": "11:00:00"}],
    )
    assert len(s.active_windows) == 1
    assert s.active_windows[0].start.isoformat() == "09:15:00"
    assert s.active_windows[0].end.isoformat() == "11:00:00"


def test_strategy_create_accepts_multiple_active_windows():
    s = StrategyCreate(
        name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
        active_windows=[
            {"start": "09:15:00", "end": "10:30:00"},
            {"start": "13:00:00", "end": "14:30:00"},
        ],
    )
    assert len(s.active_windows) == 2
    assert s.active_windows[1].start.isoformat() == "13:00:00"


def test_strategy_create_rejects_active_window_end_before_start():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            active_windows=[{"start": "11:00:00", "end": "09:15:00"}],
        )


def test_strategy_create_rejects_active_window_equal_start_and_end():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            active_windows=[{"start": "09:15:00", "end": "09:15:00"}],
        )


def test_strategy_create_rejects_one_bad_window_even_with_others_valid():
    # A typo/backwards window in the list must reject the whole request,
    # not silently drop just that one entry.
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="in_house", horizon="intraday", instrument_type="spot", rule_id=RULE_ID,
            active_windows=[
                {"start": "09:15:00", "end": "10:30:00"},
                {"start": "14:30:00", "end": "13:00:00"},
            ],
        )


def test_strategy_update_active_windows_omitted_by_default():
    u = StrategyUpdate()
    assert u.active_windows is None


def test_strategy_update_accepts_active_windows():
    u = StrategyUpdate(active_windows=[{"start": "09:15:00", "end": "11:00:00"}])
    assert len(u.active_windows) == 1


def test_strategy_update_accepts_empty_active_windows_list_explicitly():
    # Distinct from omitting the field entirely (None, above) - the route
    # layer (model_fields_set) is what tells these apart; the model
    # itself just needs to accept [] as a valid value.
    u = StrategyUpdate(active_windows=[])
    assert u.active_windows == []
