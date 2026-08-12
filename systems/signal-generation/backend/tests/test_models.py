import pytest
from pydantic import ValidationError

from app.domain.models import (
    StrategyCreate,
    StrategyUpdate,
    default_square_off_time,
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


def test_strategy_create_rejects_unknown_source_type():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x",
            source_type="not-a-real-provider",
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
    assert s.duplicate_signal_policy == "add_position"
    assert s.counter_signal_policy == "skip"


def test_strategy_create_accepts_explicit_signal_conflict_policy():
    s = StrategyCreate(
        name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="15:00:00",
        duplicate_signal_policy="skip", counter_signal_policy="close_and_flip",
    )
    assert s.duplicate_signal_policy == "skip"
    assert s.counter_signal_policy == "close_and_flip"


def test_strategy_create_rejects_unknown_duplicate_signal_policy():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="15:00:00",
            duplicate_signal_policy="always_new",
        )


def test_strategy_create_rejects_unknown_counter_signal_policy():
    with pytest.raises(ValidationError):
        StrategyCreate(
            name="x", source_type="chartink", horizon="intraday", instrument_type="spot", square_off_time="15:00:00",
            counter_signal_policy="close_only",
        )


def test_strategy_update_signal_conflict_policy_fields_optional():
    u = StrategyUpdate()
    assert u.duplicate_signal_policy is None
    assert u.counter_signal_policy is None
