import pytest
from pydantic import ValidationError

from app.domain.models import (
    EmaStopParams,
    ManualPositionCreate,
    StopLossUpdate,
    SupertrendStopParams,
    validate_stop_loss_indicator_params,
)


def _base(**overrides) -> dict:
    payload = dict(
        segment="NSE",
        symbol="RELIANCE",
        action="BUY",
        instrument_type="spot",
        price=100.0,
        plan_checklist=[{"label": "Capital fixed", "checked": True}],
    )
    payload.update(overrides)
    return payload


def test_manual_position_create_no_stop_loss_is_valid():
    m = ManualPositionCreate(**_base())
    assert m.stop_loss_price is None
    assert m.stop_loss_method is None


def test_manual_position_create_fixed_stop_loss_price_is_valid():
    m = ManualPositionCreate(**_base(stop_loss_price=95.0))
    assert m.stop_loss_price == 95.0


def test_manual_position_create_rejects_both_fixed_price_and_method():
    with pytest.raises(ValidationError, match="mutually exclusive"):
        ManualPositionCreate(**_base(stop_loss_price=95.0, stop_loss_method="percent", stop_loss_percent=2.0))


def test_manual_position_create_trailing_without_method_is_rejected():
    with pytest.raises(ValidationError, match="trailing_stop_enabled requires a stop_loss_method"):
        ManualPositionCreate(**_base(trailing_stop_enabled=True))


def test_manual_position_create_percent_method_valid():
    m = ManualPositionCreate(**_base(stop_loss_method="percent", stop_loss_percent=2.0, trailing_stop_enabled=True))
    assert m.stop_loss_method == "percent"
    assert m.trailing_stop_enabled is True


def test_manual_position_create_percent_method_requires_percent():
    with pytest.raises(ValidationError, match="requires stop_loss_percent"):
        ManualPositionCreate(**_base(stop_loss_method="percent"))


def test_manual_position_create_breakeven_method_valid():
    m = ManualPositionCreate(**_base(stop_loss_method="breakeven", stop_loss_percent=0.5, trailing_stop_enabled=True))
    assert m.stop_loss_method == "breakeven"
    assert m.trailing_stop_enabled is True


def test_manual_position_create_breakeven_method_requires_percent():
    with pytest.raises(ValidationError, match="requires stop_loss_percent"):
        ManualPositionCreate(**_base(stop_loss_method="breakeven", trailing_stop_enabled=True))


def test_manual_position_create_breakeven_method_requires_trailing_enabled():
    with pytest.raises(ValidationError, match="requires trailing_stop_enabled"):
        ManualPositionCreate(**_base(stop_loss_method="breakeven", stop_loss_percent=0.5))


def test_manual_position_create_previous_candle_requires_interval():
    with pytest.raises(ValidationError, match="requires stop_loss_interval"):
        ManualPositionCreate(**_base(stop_loss_method="previous_candle"))


def test_manual_position_create_previous_candle_valid():
    m = ManualPositionCreate(**_base(stop_loss_method="previous_candle", stop_loss_interval="5min"))
    assert m.stop_loss_interval == "5min"


def test_manual_position_create_indicator_requires_type_and_params():
    with pytest.raises(ValidationError, match="requires stop_loss_indicator_type"):
        ManualPositionCreate(**_base(stop_loss_method="indicator", stop_loss_interval="5min"))


def test_manual_position_create_indicator_valid_ema():
    m = ManualPositionCreate(
        **_base(
            stop_loss_method="indicator",
            stop_loss_interval="5min",
            stop_loss_indicator_type="ema",
            stop_loss_indicator_params={"period": 20},
        )
    )
    assert m.stop_loss_indicator_type == "ema"


def test_manual_position_create_indicator_rejects_malformed_params():
    with pytest.raises(ValidationError):
        ManualPositionCreate(
            **_base(
                stop_loss_method="indicator",
                stop_loss_interval="5min",
                stop_loss_indicator_type="ema",
                stop_loss_indicator_params={"not_period": 20},
            )
        )


def test_stop_loss_update_requires_price_or_method():
    with pytest.raises(ValidationError, match="must supply either"):
        StopLossUpdate()


def test_stop_loss_update_fixed_price_is_valid():
    u = StopLossUpdate(stop_loss_price=95.0)
    assert u.stop_loss_price == 95.0
    assert u.stop_loss_method is None


def test_stop_loss_update_rejects_both_price_and_method():
    with pytest.raises(ValidationError, match="mutually exclusive"):
        StopLossUpdate(stop_loss_price=95.0, stop_loss_method="percent", stop_loss_percent=2.0)


def test_stop_loss_update_indicator_method_valid():
    u = StopLossUpdate(
        stop_loss_method="indicator",
        stop_loss_interval="5min",
        stop_loss_indicator_type="supertrend",
        stop_loss_indicator_params={"period": 10, "multiplier": 3.0},
        trailing_stop_enabled=True,
    )
    assert u.stop_loss_indicator_type == "supertrend"
    assert u.trailing_stop_enabled is True


def test_stop_loss_update_previous_candle_requires_interval():
    with pytest.raises(ValidationError, match="requires stop_loss_interval"):
        StopLossUpdate(stop_loss_method="previous_candle")


def test_validate_stop_loss_indicator_params_accepts_valid_ema():
    params = validate_stop_loss_indicator_params("ema", {"period": 20})
    assert isinstance(params, EmaStopParams)
    assert params.period == 20


def test_validate_stop_loss_indicator_params_accepts_valid_supertrend():
    params = validate_stop_loss_indicator_params("supertrend", {"period": 10, "multiplier": 3.0})
    assert isinstance(params, SupertrendStopParams)
    assert params.multiplier == 3.0


def test_validate_stop_loss_indicator_params_rejects_unknown_type():
    with pytest.raises(ValueError, match="unknown stop_loss_indicator_type"):
        validate_stop_loss_indicator_params("macd", {})
