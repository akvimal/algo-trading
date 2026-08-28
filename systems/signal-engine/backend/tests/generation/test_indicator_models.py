import pytest
from pydantic import ValidationError

from app.domain.generation.rule import (
    EmaStopParams,
    IndicatorCreate,
    IndicatorUpdate,
    RsiParams,
    SupertrendParams,
    SupertrendStopParams,
    validate_indicator_params,
    validate_stop_loss_indicator_params,
)


def test_validate_indicator_params_accepts_valid_rsi():
    params = validate_indicator_params("rsi", {"period": 14, "sma_period": 9})
    assert isinstance(params, RsiParams)
    assert params.period == 14
    assert params.sma_period == 9


def test_validate_indicator_params_rejects_non_positive_period():
    with pytest.raises(ValidationError):
        validate_indicator_params("rsi", {"period": 1, "sma_period": 9})


def test_validate_indicator_params_rejects_missing_period():
    with pytest.raises(ValidationError):
        validate_indicator_params("rsi", {"sma_period": 9})


def test_validate_indicator_params_rejects_missing_sma_period():
    with pytest.raises(ValidationError):
        validate_indicator_params("rsi", {"period": 14})


def test_validate_indicator_params_accepts_valid_supertrend():
    params = validate_indicator_params("supertrend", {"period": 10, "multiplier": 3.0})
    assert isinstance(params, SupertrendParams)
    assert params.period == 10
    assert params.multiplier == 3.0


def test_validate_indicator_params_supertrend_rejects_non_positive_multiplier():
    with pytest.raises(ValidationError):
        validate_indicator_params("supertrend", {"period": 10, "multiplier": 0})


def test_indicator_create_valid_supertrend():
    ind = IndicatorCreate(name="SuperTrend 10/3", type="supertrend", params={"period": 10, "multiplier": 3.0})
    assert ind.name == "SuperTrend 10/3"
    assert ind.type == "supertrend"


def test_indicator_create_valid():
    ind = IndicatorCreate(name="RSI 14", type="rsi", params={"period": 14, "sma_period": 9})
    assert ind.name == "RSI 14"
    assert ind.type == "rsi"


def test_indicator_create_rejects_unknown_type():
    with pytest.raises(ValidationError):
        IndicatorCreate(name="MACD", type="macd", params={})


def test_indicator_create_rejects_params_mismatched_with_type():
    with pytest.raises(ValidationError):
        IndicatorCreate(name="RSI", type="rsi", params={"fast": 12, "slow": 26})


def test_indicator_create_rejects_empty_name():
    with pytest.raises(ValidationError):
        IndicatorCreate(name="", type="rsi", params={"period": 14})


def test_indicator_update_all_fields_optional():
    upd = IndicatorUpdate()
    assert upd.name is None
    assert upd.params is None


def test_indicator_update_rejects_empty_name():
    with pytest.raises(ValidationError):
        IndicatorUpdate(name="")


def test_validate_stop_loss_indicator_params_accepts_valid_ema():
    params = validate_stop_loss_indicator_params("ema", {"period": 20})
    assert isinstance(params, EmaStopParams)
    assert params.period == 20


def test_validate_stop_loss_indicator_params_rejects_non_positive_period():
    with pytest.raises(ValidationError):
        validate_stop_loss_indicator_params("ema", {"period": 1})


def test_validate_stop_loss_indicator_params_rejects_missing_period():
    with pytest.raises(ValidationError):
        validate_stop_loss_indicator_params("ema", {})


def test_validate_stop_loss_indicator_params_rejects_unknown_type():
    with pytest.raises(ValueError):
        validate_stop_loss_indicator_params("parabolic_sar", {"period": 10})


def test_validate_stop_loss_indicator_params_accepts_valid_supertrend():
    params = validate_stop_loss_indicator_params("supertrend", {"period": 10, "multiplier": 3.0})
    assert isinstance(params, SupertrendStopParams)
    assert params.period == 10
    assert params.multiplier == 3.0


def test_validate_stop_loss_indicator_params_supertrend_rejects_non_positive_multiplier():
    with pytest.raises(ValidationError):
        validate_stop_loss_indicator_params("supertrend", {"period": 10, "multiplier": 0})


def test_validate_stop_loss_indicator_params_supertrend_rejects_missing_multiplier():
    with pytest.raises(ValidationError):
        validate_stop_loss_indicator_params("supertrend", {"period": 10})
