"""Tests for option_position_manager.preview_option_legs - the read-only counterpart to
open_manual_option_group's own leg-selection block, backing the Scan page's bias-driven
option panel. Plain fakes for resolve_underlying/get_expiry_list/get_option_chain, same
chain fixture shape test_option_templates.py already established."""

import pytest

from app.domain.option_position_manager import OptionLegPreviewError, preview_option_legs


def _leg(security_id: str, moneyness: str, oi: int) -> dict:
    return {"security_id": security_id, "moneyness": moneyness, "oi": oi}


def _make_chain(strikes: list[dict], expiry: str = "2026-08-14") -> dict:
    return {"underlying_symbol": "RELIANCE", "underlying_exchange": "NSE", "expiry": expiry, "underlying_last_price": 2500.0, "strikes": strikes}


def _default_strikes() -> list[dict]:
    return [
        {"strike": 2400.0, "ce": _leg("ce-2400", "ITM", 5000), "pe": _leg("pe-2400", "OTM", 5000)},
        {"strike": 2450.0, "ce": _leg("ce-2450", "ITM", 5000), "pe": _leg("pe-2450", "OTM", 5000)},
        {"strike": 2500.0, "ce": _leg("ce-2500", "ATM", 5000), "pe": _leg("pe-2500", "ATM", 5000)},
        {"strike": 2550.0, "ce": _leg("ce-2550", "OTM", 5000), "pe": _leg("pe-2550", "ITM", 5000)},
        {"strike": 2600.0, "ce": _leg("ce-2600", "OTM", 5000), "pe": _leg("pe-2600", "ITM", 5000)},
    ]


def _resolve_underlying(segment, symbol):
    return {"chart_symbol": symbol, "chart_exchange": segment, "trade_symbol": symbol, "trade_exchange": segment, "lot_size": 1, "expiry": None}


def _get_expiry_list(exchange, symbol):
    return ["2026-08-14", "2026-08-21"]


def _get_option_chain(exchange, symbol, expiry):
    return _make_chain(_default_strikes(), expiry)


def _resolve_symbol_by_security_id(segment, security_id):
    return f"SYM-{security_id}"


def _get_ltp_batch(segment, symbols):
    # A stable, made-up premium per symbol so assertions can key off the security_id suffix.
    return {s: 100.0 + i for i, s in enumerate(symbols)}


def preview(
    action="BUY",
    style="spread",
    moneyness="ATM",
    expiry=None,
    get_option_chain=_get_option_chain,
    resolve_symbol_by_security_id=None,
    get_ltp_batch=None,
    spread_width=None,
):
    return preview_option_legs(
        "NSE", "RELIANCE", action, style, moneyness, expiry, _resolve_underlying, _get_expiry_list, get_option_chain,
        resolve_symbol_by_security_id, get_ltp_batch, spread_width,
    )


def test_bullish_spread_is_a_bull_call_spread():
    out = preview(action="BUY", style="spread")
    assert out["strategy_type"] == "bull_call_spread"
    assert out["expiry"] == "2026-08-14"  # nearest, since none was given
    assert [leg["option_type"] for leg in out["legs"]] == ["CE", "CE"]
    assert [leg["action"] for leg in out["legs"]] == ["BUY", "SELL"]


def test_bearish_spread_is_a_bear_put_spread():
    out = preview(action="SELL", style="spread")
    assert out["strategy_type"] == "bear_put_spread"
    assert [leg["option_type"] for leg in out["legs"]] == ["PE", "PE"]


def test_bullish_credit_spread_is_a_bull_put_spread():
    out = preview(action="BUY", style="credit_spread")
    assert out["strategy_type"] == "bull_put_spread"
    assert [leg["option_type"] for leg in out["legs"]] == ["PE", "PE"]
    assert [leg["action"] for leg in out["legs"]] == ["SELL", "BUY"]


def test_spread_width_override_moves_only_the_short_leg():
    default_out = preview(action="BUY", style="spread")
    narrower_out = preview(action="BUY", style="spread", spread_width=1)

    assert default_out["legs"][0]["strike"] == narrower_out["legs"][0]["strike"] == 2500.0  # primary leg untouched
    assert default_out["legs"][1]["strike"] == 2600.0  # default width 2
    assert narrower_out["legs"][1]["strike"] == 2550.0  # width override 1


def test_bearish_credit_spread_is_a_bear_call_spread():
    out = preview(action="SELL", style="credit_spread")
    assert out["strategy_type"] == "bear_call_spread"
    assert [leg["option_type"] for leg in out["legs"]] == ["CE", "CE"]
    assert [leg["action"] for leg in out["legs"]] == ["SELL", "BUY"]


def test_naked_style_is_a_single_leg():
    bullish = preview(action="BUY", style="naked")
    assert bullish["strategy_type"] == "naked_call"
    assert len(bullish["legs"]) == 1
    bearish = preview(action="SELL", style="naked")
    assert bearish["strategy_type"] == "naked_put"
    assert len(bearish["legs"]) == 1


def test_an_explicit_expiry_is_honoured_and_validated():
    out = preview(expiry="2026-08-21")
    assert out["expiry"] == "2026-08-21"
    with pytest.raises(OptionLegPreviewError, match="not a currently-tradeable expiry"):
        preview(expiry="2026-09-01")


def test_no_resolvable_underlying_raises():
    with pytest.raises(OptionLegPreviewError, match="could not resolve underlying"):
        preview_option_legs("NSE", "NOTREAL", "BUY", "spread", "ATM", None, lambda s, sym: None, _get_expiry_list, _get_option_chain)


def test_no_tradeable_expiry_raises():
    with pytest.raises(OptionLegPreviewError, match="no currently-tradeable expiry"):
        preview_option_legs("NSE", "RELIANCE", "BUY", "spread", "ATM", None, _resolve_underlying, lambda e, s: [], _get_option_chain)


def test_no_chain_raises():
    with pytest.raises(OptionLegPreviewError, match="could not resolve option chain"):
        preview(get_option_chain=lambda e, s, x: None)


def test_the_security_id_is_never_the_point_of_this_response_but_is_still_present_on_the_raw_legs():
    # OptionLegPreview (the route's response_model) drops it - this just confirms the domain
    # function itself still returns the same leg shape option_templates.py always has, so the
    # route has something to filter rather than a hand-trimmed dict that could drift.
    out = preview()
    assert all("security_id" in leg for leg in out["legs"])


def test_premium_is_none_when_the_caller_does_not_ask_for_quotes():
    out = preview()
    assert all(leg["premium"] is None for leg in out["legs"])


def test_premium_is_filled_in_for_a_credit_spread_too():
    # legs[0] is SELL (the credit leg) here, unlike a debit spread's
    # legs[0]=BUY - premium resolution is per-leg by security_id, not by
    # position, so this needs no special-casing either.
    out = preview(action="BUY", style="credit_spread", resolve_symbol_by_security_id=_resolve_symbol_by_security_id, get_ltp_batch=_get_ltp_batch)
    assert all(leg["premium"] is not None for leg in out["legs"])


def test_premium_is_filled_in_when_a_quote_source_is_given():
    out = preview(resolve_symbol_by_security_id=_resolve_symbol_by_security_id, get_ltp_batch=_get_ltp_batch)
    assert all(leg["premium"] is not None for leg in out["legs"])
    # Each leg's premium came from its own resolved symbol, not just the first one repeated.
    assert len({leg["premium"] for leg in out["legs"]}) == len(out["legs"])


def test_a_quote_lookup_failure_does_not_fail_the_whole_preview():
    def _broken_get_ltp_batch(segment, symbols):
        raise ConnectionError("provider unreachable")

    out = preview(resolve_symbol_by_security_id=_resolve_symbol_by_security_id, get_ltp_batch=_broken_get_ltp_batch)
    assert out["strategy_type"]  # the legs themselves still resolved
    assert all(leg["premium"] is None for leg in out["legs"])


def test_an_unresolvable_leg_symbol_just_leaves_that_legs_premium_none():
    # bull_call_spread @ ATM against _default_strikes resolves to long=ce-2500, short=ce-2600
    # (ATM index + SPREAD_WIDTH_STRIKES) - block just the short leg's symbol resolution.
    def _resolve_all_but_short(segment, security_id):
        return None if security_id == "ce-2600" else f"SYM-{security_id}"

    out = preview(action="BUY", style="spread", resolve_symbol_by_security_id=_resolve_all_but_short, get_ltp_batch=_get_ltp_batch)
    premiums = {leg["strike"]: leg["premium"] for leg in out["legs"]}
    assert premiums[2500.0] is not None  # long leg still priced
    assert premiums[2600.0] is None  # short leg's symbol never resolved, so no quote for it
