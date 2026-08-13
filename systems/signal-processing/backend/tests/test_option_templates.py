"""Tests for app/domain/resolution/option_templates.py - the fixed
bias->template option-strategy leg builders (Phase 4b of the options
trading module, see docs/architecture.md). Pure functions, hand-built
fake chains matching market-data's real OptionChain JSON shape - no
network/mocking needed."""

from datetime import date

import pytest

from app.domain.resolution.option_templates import (
    MIN_SHORT_LEG_OI,
    _find_primary_leg_index,
    bear_put_spread,
    bull_call_spread,
    choose_expiry,
    naked_call,
    naked_put,
)


def _leg(security_id: str, moneyness: str, oi: int) -> dict:
    return {"security_id": security_id, "moneyness": moneyness, "oi": oi}


def _make_chain(strikes: list[dict], expiry: str = "2026-08-14") -> dict:
    return {
        "underlying_symbol": "NIFTY",
        "underlying_exchange": "NSE",
        "expiry": expiry,
        "underlying_last_price": 24000.0,
        "strikes": strikes,
    }


# 5 strikes, ATM in the middle (index 2) - enough room for SPREAD_WIDTH_STRIKES=2 on both sides,
# every leg well above MIN_SHORT_LEG_OI (1000) unless a test overrides one specifically.
def _default_strikes() -> list[dict]:
    return [
        {"strike": 23900.0, "ce": _leg("ce-23900", "ITM", 5000), "pe": _leg("pe-23900", "OTM", 5000)},
        {"strike": 23950.0, "ce": _leg("ce-23950", "ITM", 5000), "pe": _leg("pe-23950", "OTM", 5000)},
        {"strike": 24000.0, "ce": _leg("ce-24000", "ATM", 5000), "pe": _leg("pe-24000", "ATM", 5000)},
        {"strike": 24050.0, "ce": _leg("ce-24050", "OTM", 5000), "pe": _leg("pe-24050", "ITM", 5000)},
        {"strike": 24100.0, "ce": _leg("ce-24100", "OTM", 5000), "pe": _leg("pe-24100", "ITM", 5000)},
    ]


# --- choose_expiry ---------------------------------------------------------------------------


def test_choose_expiry_intraday_picks_nearest():
    expiries = ["2026-08-21", "2026-08-14", "2026-08-28"]
    assert choose_expiry(expiries, "intraday", today=date(2026, 8, 12)) == "2026-08-14"


def test_choose_expiry_positional_skips_too_near_expiry():
    # 2026-08-14 is only 2 days out from 2026-08-12 - below the 7-day
    # positional floor - so 2026-08-21 (9 days out) should win instead.
    expiries = ["2026-08-14", "2026-08-21", "2026-08-28"]
    assert choose_expiry(expiries, "positional", today=date(2026, 8, 12)) == "2026-08-21"


def test_choose_expiry_positional_falls_back_to_furthest_if_none_qualify():
    expiries = ["2026-08-13", "2026-08-14"]
    assert choose_expiry(expiries, "positional", today=date(2026, 8, 12)) == "2026-08-14"


def test_choose_expiry_empty_list_returns_none():
    assert choose_expiry([], "intraday", today=date(2026, 8, 12)) is None


# --- bull_call_spread --------------------------------------------------------------------------


def test_bull_call_spread_picks_atm_long_and_otm_short():
    chain = _make_chain(_default_strikes())

    legs = bull_call_spread(chain)

    assert legs == [
        {"action": "BUY", "option_type": "CE", "strike": 24000.0, "expiry": "2026-08-14", "security_id": "ce-24000"},
        {"action": "SELL", "option_type": "CE", "strike": 24100.0, "expiry": "2026-08-14", "security_id": "ce-24100"},
    ]


def test_bull_call_spread_nudges_short_leg_further_otm_when_illiquid():
    strikes = _default_strikes()
    strikes[4]["ce"] = _leg("ce-24100", "OTM", MIN_SHORT_LEG_OI - 1)  # ideal short strike, too illiquid
    strikes.append({"strike": 24150.0, "ce": _leg("ce-24150", "OTM", 5000), "pe": _leg("pe-24150", "ITM", 5000)})
    chain = _make_chain(strikes)

    legs = bull_call_spread(chain)

    assert legs[1]["strike"] == 24150.0
    assert legs[1]["security_id"] == "ce-24150"


def test_bull_call_spread_falls_back_to_ideal_strike_if_nothing_liquid():
    strikes = _default_strikes()
    strikes[4]["ce"] = _leg("ce-24100", "OTM", MIN_SHORT_LEG_OI - 1)  # last strike - nowhere further to nudge
    chain = _make_chain(strikes)

    legs = bull_call_spread(chain)

    assert legs[1]["strike"] == 24100.0  # fell back to the ideal (illiquid) strike, not None


def test_bull_call_spread_raises_when_no_atm_strike():
    strikes = [s for s in _default_strikes() if s["strike"] != 24000.0]
    chain = _make_chain(strikes)

    with pytest.raises(ValueError, match="no ATM call"):
        bull_call_spread(chain)


# --- bear_put_spread ----------------------------------------------------------------------------


def test_bear_put_spread_picks_atm_long_and_otm_short():
    chain = _make_chain(_default_strikes())

    legs = bear_put_spread(chain)

    assert legs == [
        {"action": "BUY", "option_type": "PE", "strike": 24000.0, "expiry": "2026-08-14", "security_id": "pe-24000"},
        {"action": "SELL", "option_type": "PE", "strike": 23900.0, "expiry": "2026-08-14", "security_id": "pe-23900"},
    ]


def test_bear_put_spread_nudges_short_leg_further_otm_when_illiquid():
    strikes = _default_strikes()
    strikes[0]["pe"] = _leg("pe-23900", "OTM", MIN_SHORT_LEG_OI - 1)  # ideal short strike, too illiquid
    strikes.insert(0, {"strike": 23850.0, "ce": _leg("ce-23850", "ITM", 5000), "pe": _leg("pe-23850", "OTM", 5000)})
    chain = _make_chain(strikes)

    legs = bear_put_spread(chain)

    assert legs[1]["strike"] == 23850.0
    assert legs[1]["security_id"] == "pe-23850"


def test_bear_put_spread_raises_when_no_atm_strike():
    strikes = [s for s in _default_strikes() if s["strike"] != 24000.0]
    chain = _make_chain(strikes)

    with pytest.raises(ValueError, match="no ATM put"):
        bear_put_spread(chain)


# --- naked_call / naked_put (option_position_style='naked') -----------------------------------


def test_naked_call_picks_only_atm_long_leg():
    chain = _make_chain(_default_strikes())

    legs = naked_call(chain)

    assert legs == [
        {"action": "BUY", "option_type": "CE", "strike": 24000.0, "expiry": "2026-08-14", "security_id": "ce-24000"},
    ]


def test_naked_call_raises_when_no_atm_strike():
    strikes = [s for s in _default_strikes() if s["strike"] != 24000.0]
    chain = _make_chain(strikes)

    with pytest.raises(ValueError, match="no ATM call"):
        naked_call(chain)


def test_naked_put_picks_only_atm_long_leg():
    chain = _make_chain(_default_strikes())

    legs = naked_put(chain)

    assert legs == [
        {"action": "BUY", "option_type": "PE", "strike": 24000.0, "expiry": "2026-08-14", "security_id": "pe-24000"},
    ]


def test_naked_put_raises_when_no_atm_strike():
    strikes = [s for s in _default_strikes() if s["strike"] != 24000.0]
    chain = _make_chain(strikes)

    with pytest.raises(ValueError, match="no ATM put"):
        naked_put(chain)


# --- _find_primary_leg_index / option_strike_moneyness --------------------------------------------


def test_find_primary_leg_index_call_offsets_match_default_strikes():
    strikes = _default_strikes()  # ATM at index 2, exactly 2 strikes on each side
    assert _find_primary_leg_index(strikes, "ce", "ITM2") == 0
    assert _find_primary_leg_index(strikes, "ce", "ITM1") == 1
    assert _find_primary_leg_index(strikes, "ce", "ATM") == 2
    assert _find_primary_leg_index(strikes, "ce", "OTM1") == 3
    assert _find_primary_leg_index(strikes, "ce", "OTM2") == 4


def test_find_primary_leg_index_put_offsets_are_mirrored():
    # For a put, OTM is the LOWER strike (lower index) - the opposite
    # direction from a call, same convention _pick_short_leg_index's own
    # direction=-1 for "pe" already encodes.
    strikes = _default_strikes()
    assert _find_primary_leg_index(strikes, "pe", "ITM2") == 4
    assert _find_primary_leg_index(strikes, "pe", "ITM1") == 3
    assert _find_primary_leg_index(strikes, "pe", "ATM") == 2
    assert _find_primary_leg_index(strikes, "pe", "OTM1") == 1
    assert _find_primary_leg_index(strikes, "pe", "OTM2") == 0


def test_find_primary_leg_index_clamps_when_chain_too_narrow():
    # Only 1 strike on either side of ATM (index 1) - ITM2/OTM2 clamp to
    # the edge rather than going out of range.
    strikes = _default_strikes()[1:4]  # ITM1(0), ATM(1), OTM1(2) after reindexing
    assert _find_primary_leg_index(strikes, "ce", "ITM2") == 0
    assert _find_primary_leg_index(strikes, "ce", "OTM2") == 2


def test_find_primary_leg_index_returns_none_without_atm():
    strikes = [s for s in _default_strikes() if s["strike"] != 24000.0]
    assert _find_primary_leg_index(strikes, "ce", "OTM1") is None


def _wide_strikes() -> list[dict]:
    """9 strikes, ATM at index 4 - wide enough to place a non-ATM primary
    leg (up to +/-2) AND still have room for the spread's own
    SPREAD_WIDTH_STRIKES=2 beyond THAT, with no clamping on either move."""
    base = 23800.0
    return [
        {
            "strike": base + i * 50,
            "ce": _leg(f"ce-{int(base + i * 50)}", "ATM" if i == 4 else ("ITM" if i < 4 else "OTM"), 5000),
            "pe": _leg(f"pe-{int(base + i * 50)}", "ATM" if i == 4 else ("ITM" if i > 4 else "OTM"), 5000),
        }
        for i in range(9)
    ]


def test_bull_call_spread_with_otm1_moneyness_shifts_both_legs():
    chain = _make_chain(_wide_strikes())

    legs = bull_call_spread(chain, moneyness="OTM1")

    # Primary leg: ATM(index 4, 24000) + 1 -> index 5 (24050).
    # Short leg: primary(5) + SPREAD_WIDTH_STRIKES(2) -> index 7 (24150) -
    # NOT index 6 (24100), which is what it would be if the short leg were
    # still computed relative to the original ATM index instead.
    assert legs[0]["strike"] == 24050.0
    assert legs[1]["strike"] == 24150.0


def test_bear_put_spread_with_itm1_moneyness_shifts_both_legs():
    chain = _make_chain(_wide_strikes())

    legs = bear_put_spread(chain, moneyness="ITM1")

    # Primary leg (PE, ITM1): ATM(index 4) - direction(-1)*offset(-1) -> index 5 (24050).
    # Short leg: further OTM (lower index) by 2 from index 5 -> index 3 (23950).
    assert legs[0]["strike"] == 24050.0
    assert legs[1]["strike"] == 23950.0


def test_naked_call_with_moneyness_picks_shifted_strike_only():
    chain = _make_chain(_wide_strikes())

    legs = naked_call(chain, moneyness="ITM2")

    assert legs == [
        {"action": "BUY", "option_type": "CE", "strike": 23900.0, "expiry": "2026-08-14", "security_id": "ce-23900"},
    ]


def test_naked_put_with_moneyness_picks_shifted_strike_only():
    chain = _make_chain(_wide_strikes())

    legs = naked_put(chain, moneyness="OTM2")

    assert legs == [
        {"action": "BUY", "option_type": "PE", "strike": 23900.0, "expiry": "2026-08-14", "security_id": "pe-23900"},
    ]
