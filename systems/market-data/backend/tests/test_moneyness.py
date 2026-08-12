import pytest

from app.domain.moneyness import classify_moneyness, infer_strike_step


def test_infer_strike_step_uniform_gaps():
    assert infer_strike_step([24000, 24050, 24100, 24150]) == 50


def test_infer_strike_step_tolerates_one_missing_strike():
    # 24100 missing - the gap between 24050 and 24150 (100) shouldn't win
    # over the dominant 50-point step.
    assert infer_strike_step([24000, 24050, 24150, 24200, 24250]) == 50


def test_infer_strike_step_requires_at_least_two_strikes():
    with pytest.raises(ValueError):
        infer_strike_step([24000])


def test_classify_moneyness_call_itm_below_spot():
    assert classify_moneyness(strike=23900, spot=24000, option_type="CE", strike_step=50) == "ITM"


def test_classify_moneyness_call_otm_above_spot():
    assert classify_moneyness(strike=24200, spot=24000, option_type="CE", strike_step=50) == "OTM"


def test_classify_moneyness_put_itm_above_spot():
    assert classify_moneyness(strike=24200, spot=24000, option_type="PE", strike_step=50) == "ITM"


def test_classify_moneyness_put_otm_below_spot():
    assert classify_moneyness(strike=23900, spot=24000, option_type="PE", strike_step=50) == "OTM"


def test_classify_moneyness_atm_exact_match():
    assert classify_moneyness(strike=24000, spot=24000, option_type="CE", strike_step=50) == "ATM"
    assert classify_moneyness(strike=24000, spot=24000, option_type="PE", strike_step=50) == "ATM"


def test_classify_moneyness_atm_within_half_step():
    # spot sits exactly between two strikes - both are within half the
    # step (25) and count as ATM.
    assert classify_moneyness(strike=24000, spot=24025, option_type="CE", strike_step=50) == "ATM"
    assert classify_moneyness(strike=24050, spot=24025, option_type="CE", strike_step=50) == "ATM"


def test_classify_moneyness_just_outside_atm_band():
    assert classify_moneyness(strike=23950, spot=24020, option_type="CE", strike_step=50) == "ITM"
