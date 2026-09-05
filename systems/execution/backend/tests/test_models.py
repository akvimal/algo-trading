import pytest
from pydantic import ValidationError

from app.domain.models import (
    AccountUpdate,
    EmaStopParams,
    ManualPositionCreate,
    NotesUpdate,
    StopLossUpdate,
    SupertrendStopParams,
    TradeTagsUpdate,
    validate_stop_loss_indicator_params,
)


def test_notes_update_defaults_to_empty_and_accepts_text():
    assert NotesUpdate().notes == ""
    assert NotesUpdate(notes="chased the entry, missed the retest").notes.startswith("chased")


def test_notes_update_rejects_an_overlong_note():
    with pytest.raises(ValidationError):
        NotesUpdate(notes="x" * 2001)


def test_manual_position_create_accepts_setup_tag_and_confidence():
    p = ManualPositionCreate(**_base(setup_tag="OB retest", confidence=4))
    assert p.setup_tag == "OB retest"
    assert p.confidence == 4


def test_manual_position_create_rejects_confidence_out_of_range():
    with pytest.raises(ValidationError):
        ManualPositionCreate(**_base(confidence=6))
    with pytest.raises(ValidationError):
        ManualPositionCreate(**_base(confidence=0))


def test_trade_tags_update_is_partial_and_bounded():
    assert TradeTagsUpdate(setup_tag="Breakout").model_dump(exclude_unset=True) == {"setup_tag": "Breakout"}
    assert TradeTagsUpdate(confidence=3).model_dump(exclude_unset=True) == {"confidence": 3}
    assert TradeTagsUpdate().model_dump(exclude_unset=True) == {}
    with pytest.raises(ValidationError):
        TradeTagsUpdate(confidence=9)


def test_manual_position_create_accepts_a_known_entry_interval():
    p = ManualPositionCreate(**_base(entry_interval="5min"))
    assert p.entry_interval == "5min"


def test_manual_position_create_rejects_an_unknown_entry_interval():
    with pytest.raises(ValidationError):
        ManualPositionCreate(**_base(entry_interval="2min"))


def test_account_update_accepts_known_intervals_and_an_explicit_null():
    # default_interval/default_higher_interval follow the same
    # model_fields_set-distinguished pattern as square_off_time/
    # max_daily_loss - an explicit null is a real "clear it" value, not
    # "leave unchanged" (that's just omitting the key entirely).
    u = AccountUpdate(default_interval="1min", default_higher_interval="5min")
    assert "default_interval" in u.model_fields_set
    assert u.default_interval == "1min"
    assert u.default_higher_interval == "5min"

    cleared = AccountUpdate(default_interval=None)
    assert "default_interval" in cleared.model_fields_set
    assert cleared.default_interval is None

    unset = AccountUpdate()
    assert "default_interval" not in unset.model_fields_set


def test_account_update_rejects_an_unknown_interval():
    with pytest.raises(ValidationError):
        AccountUpdate(default_interval="2min")
    with pytest.raises(ValidationError):
        AccountUpdate(default_higher_interval="45min")


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


def test_manual_position_create_flat_target_valid_and_flags_pass_through():
    m = ManualPositionCreate(**_base(stop_loss_price=95.0, target_price=110.0, trend_followed=True, risk_managed=True))
    assert m.target_price == 110.0
    assert m.trend_followed is True
    assert m.risk_managed is True


def test_manual_position_create_rejects_target_on_wrong_side_of_entry():
    with pytest.raises(ValidationError, match="target_price .* must be above entry"):
        ManualPositionCreate(**_base(target_price=95.0))  # BUY, entry 100 -> target must be > 100
    with pytest.raises(ValidationError, match="target_price .* must be below entry"):
        ManualPositionCreate(**_base(action="SELL", target_price=110.0))


def test_manual_position_create_rejects_flat_stop_loss_on_wrong_side_of_entry():
    with pytest.raises(ValidationError, match="stop_loss_price .* must be below entry"):
        ManualPositionCreate(**_base(stop_loss_price=105.0))  # BUY
    with pytest.raises(ValidationError, match="stop_loss_price .* must be above entry"):
        ManualPositionCreate(**_base(action="SELL", stop_loss_price=95.0))


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
