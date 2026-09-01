"""Tests for app/domain/oi_summary.build_oi_summary - pure aggregation
(PCR, chain-wide OI-change totals, ATM IV, per-strike breakdown) over an
already-built OptionChain, with no Dhan/network dependency. See
test_dhan_option_chain.py for the DhanProvider.get_oi_changes tests this
builds on top of."""

from app.domain.models import OptionChain, OptionChainStrike, OptionGreeks, OptionLegQuote
from app.domain.oi_summary import build_oi_summary


def _leg(oi: int, iv: float, moneyness: str, last_price: float = 100.0) -> OptionLegQuote:
    return OptionLegQuote(
        security_id="1",
        last_price=last_price,
        oi=oi,
        previous_oi=oi - 100,
        volume=1000,
        implied_volatility=iv,
        top_bid_price=last_price - 0.5,
        top_ask_price=last_price + 0.5,
        greeks=OptionGreeks(delta=0.5, theta=-2.0, gamma=0.001, vega=3.0),
        moneyness=moneyness,
    )


CHAIN = OptionChain(
    underlying_symbol="NIFTY",
    underlying_exchange="NSE",
    expiry="2026-08-28",
    underlying_last_price=24000.0,
    strikes=[
        OptionChainStrike(strike=23950.0, ce=_leg(500000, 13.0, "ITM"), pe=_leg(300000, 15.0, "OTM")),
        OptionChainStrike(strike=24000.0, ce=_leg(800000, 13.2, "ATM"), pe=_leg(750000, 13.6, "ATM")),
        OptionChainStrike(strike=24050.0, ce=_leg(300000, 12.0, "OTM"), pe=_leg(400000, 16.0, "ITM")),
    ],
)


def _no_change(strike: float, option_type: str, current_oi: int):
    return (None, None)


def test_build_oi_summary_totals_and_pcr():
    summary = build_oi_summary(CHAIN, _no_change)

    assert summary.total_call_oi == 500000 + 800000 + 300000
    assert summary.total_put_oi == 300000 + 750000 + 400000
    assert summary.pcr == summary.total_put_oi / summary.total_call_oi


def test_build_oi_summary_atm_iv_picked_from_atm_strike():
    summary = build_oi_summary(CHAIN, _no_change)

    assert summary.atm_call_iv == 13.2
    assert summary.atm_put_iv == 13.6


def test_build_oi_summary_pcr_none_when_no_call_oi():
    empty_calls_chain = OptionChain(
        underlying_symbol="NIFTY",
        underlying_exchange="NSE",
        expiry="2026-08-28",
        underlying_last_price=24000.0,
        strikes=[OptionChainStrike(strike=24000.0, ce=None, pe=_leg(750000, 13.6, "ATM"))],
    )

    summary = build_oi_summary(empty_calls_chain, _no_change)

    assert summary.total_call_oi == 0
    assert summary.pcr is None


def test_build_oi_summary_change_totals_none_when_any_leg_missing_a_sample():
    # Only the 24000 strike's CE has a known 5m change - the chain-wide
    # total must stay None (not silently sum just the known legs), same
    # reasoning as OptionOiSummary.total_call_oi_change_5m's own comment.
    def partial_change(strike: float, option_type: str, current_oi: int):
        if strike == 24000.0 and option_type == "CE":
            return (1234, 5678)
        return (None, None)

    summary = build_oi_summary(CHAIN, partial_change)

    assert summary.total_call_oi_change_5m is None
    assert summary.total_call_oi_change_15m is None
    assert summary.total_put_oi_change_5m is None


def test_build_oi_summary_change_totals_sum_when_every_leg_has_a_sample():
    def flat_change(strike: float, option_type: str, current_oi: int):
        return (10, 100)

    summary = build_oi_summary(CHAIN, flat_change)

    assert summary.total_call_oi_change_5m == 30  # 3 CE legs x 10
    assert summary.total_put_oi_change_15m == 300  # 3 PE legs x 100


def test_build_oi_summary_total_buildup_none_without_spot_price_changes_callback():
    # No spot_price_changes callback passed at all - same "None until the
    # caller actually supplies it" convention as price_changes/buildup on
    # OptionOiLeg (test_build_oi_summary_buildup_none_without_price_changes_callback).
    def flat_change(strike: float, option_type: str, current_oi: int):
        return (10, 100)

    summary = build_oi_summary(CHAIN, flat_change)

    assert summary.total_call_buildup is None
    assert summary.total_put_buildup is None


def test_build_oi_summary_total_call_buildup_classified_against_spot_not_any_legs_premium():
    # CE OI rises (flat_change) while spot also rises - long_buildup, using
    # the underlying's own spot direction (24050.0 - 24000.0 = +50, the 5m
    # figure - build_oi_summary deliberately classifies TOTAL buildup off
    # the 5m window, not 15m, to match the 5m change figure it's shown
    # next to - see _classify_buildup's own docstring), NOT any one leg's
    # own premium (every _leg() in CHAIN is flat at 100.0, which would
    # read as "no price change" if this were reusing OptionOiLeg's
    # per-leg classification instead).
    def flat_change(strike: float, option_type: str, current_oi: int):
        return (10, 100)

    def rising_spot(current_spot: float):
        return (50.0, 100.0)

    summary = build_oi_summary(CHAIN, flat_change, spot_price_changes=rising_spot)

    assert summary.total_call_buildup == "long_buildup"
    assert summary.total_put_buildup == "long_buildup"


def test_build_oi_summary_total_call_and_put_buildup_classified_independently():
    # Calls gain OI, puts lose OI, spot falls - short_buildup for calls
    # (OI up, price down) but long_unwinding for puts (OI down, price
    # down) - the two totals must never be merged into one blended read
    # (see OptionOiSummary.total_call_buildup's own comment).
    def mixed_change(strike: float, option_type: str, current_oi: int):
        return (10, 100) if option_type == "CE" else (-10, -100)

    def falling_spot(current_spot: float):
        return (-50.0, -100.0)

    summary = build_oi_summary(CHAIN, mixed_change, spot_price_changes=falling_spot)

    assert summary.total_call_buildup == "short_buildup"
    assert summary.total_put_buildup == "long_unwinding"


def test_build_oi_summary_per_strike_breakdown():
    summary = build_oi_summary(CHAIN, _no_change)

    atm_row = next(s for s in summary.strikes if s.strike == 24000.0)
    assert atm_row.call.oi == 800000
    assert atm_row.call.moneyness == "ATM"
    assert atm_row.put.oi == 750000
    assert atm_row.put.moneyness == "ATM"


def test_build_oi_summary_passes_through_volume_and_bid_ask():
    summary = build_oi_summary(CHAIN, _no_change)

    atm_row = next(s for s in summary.strikes if s.strike == 24000.0)
    assert atm_row.call.volume == 1000
    assert atm_row.call.top_bid_price == 99.5  # last_price 100.0 from _leg()'s default
    assert atm_row.call.top_ask_price == 100.5


def test_build_oi_summary_buildup_none_without_price_changes_callback():
    # No price_changes callback passed at all (e.g. a non-Dhan provider
    # that only supports get_oi_changes) - buildup must stay None, not
    # raise, same reasoning oi_change_5m/15m already stay None.
    summary = build_oi_summary(CHAIN, lambda strike, option_type, current_oi: (10, 100))

    atm_row = next(s for s in summary.strikes if s.strike == 24000.0)
    assert atm_row.call.buildup is None
    assert atm_row.call.price_change_15m is None


def test_build_oi_summary_buildup_classification():
    def oi_up(strike: float, option_type: str, current_oi: int):
        return (10, 100)

    def oi_down(strike: float, option_type: str, current_oi: int):
        return (-10, -100)

    def price_up(strike: float, option_type: str, current_price: float):
        return (1.0, 5.0)

    def price_down(strike: float, option_type: str, current_price: float):
        return (-1.0, -5.0)

    def price_flat(strike: float, option_type: str, current_price: float):
        return (0.0, 0.0)

    assert build_oi_summary(CHAIN, oi_up, price_up).strikes[0].call.buildup == "long_buildup"
    assert build_oi_summary(CHAIN, oi_up, price_down).strikes[0].call.buildup == "short_buildup"
    assert build_oi_summary(CHAIN, oi_down, price_up).strikes[0].call.buildup == "short_covering"
    assert build_oi_summary(CHAIN, oi_down, price_down).strikes[0].call.buildup == "long_unwinding"
    assert build_oi_summary(CHAIN, oi_up, price_flat).strikes[0].call.buildup is None
