"""Indian charges model (app/domain/india_charges.py). Expected values are
computed by hand from the schedule in that module, so a change to a rate shows
up here. The RATES THEMSELVES are unverified against current circulars - these
tests pin the arithmetic and the structure, not the law."""

import pytest

from app.domain import india_charges as ic
from app.domain.india_charges import (
    MCX_FUTURES, MCX_OPTIONS, NSE_EQUITY_DELIVERY, NSE_EQUITY_INTRADAY, NSE_FUTURES, NSE_OPTIONS,
    group_charges, kind_for, leg_charges, round_trip_charges,
)


def test_intraday_equity_buy_leg_by_hand():
    # turnover 50,000: brokerage min(20, 0.03% = 15) = 15; no STT on buy; exchange 1.485;
    # SEBI 0.05; stamp 0.003% = 1.5; GST 18% of (15 + 1.485 + 0.05) = 2.9763
    b = leg_charges(NSE_EQUITY_INTRADAY, "BUY", 50000)
    assert b.brokerage == pytest.approx(15.0) and b.tax == 0.0
    assert b.exchange == pytest.approx(1.485) and b.sebi == pytest.approx(0.05) and b.stamp == pytest.approx(1.5)
    assert b.gst == pytest.approx(0.18 * (15 + 1.485 + 0.05))


def test_intraday_equity_sell_leg_pays_stt_and_no_stamp():
    b = leg_charges(NSE_EQUITY_INTRADAY, "SELL", 51000)
    assert b.tax == pytest.approx(12.75) and b.stamp == 0.0 and b.brokerage == pytest.approx(15.3)


def test_brokerage_is_capped_at_the_flat_fee():
    assert leg_charges(NSE_EQUITY_INTRADAY, "BUY", 1_000_000).brokerage == 20.0
    assert leg_charges(NSE_FUTURES, "BUY", 1_000_000).brokerage == 20.0


def test_options_brokerage_is_flat_even_on_a_tiny_premium():
    assert leg_charges(NSE_OPTIONS, "BUY", 500).brokerage == 20.0


def test_delivery_has_no_brokerage_and_stt_on_both_sides():
    buy, sell = leg_charges(NSE_EQUITY_DELIVERY, "BUY", 100000), leg_charges(NSE_EQUITY_DELIVERY, "SELL", 100000)
    assert buy.brokerage == 0 and sell.brokerage == 0
    assert buy.tax == pytest.approx(100.0) and sell.tax == pytest.approx(100.0)
    assert buy.stamp == pytest.approx(15.0) and sell.stamp == 0.0


def test_futures_and_options_tax_falls_on_the_sell_side_only():
    for kind in (NSE_FUTURES, NSE_OPTIONS, MCX_FUTURES, MCX_OPTIONS):
        assert leg_charges(kind, "BUY", 100000).tax == 0.0
        assert leg_charges(kind, "SELL", 100000).tax > 0.0


def test_gst_applies_to_brokerage_exchange_and_sebi_but_not_the_tax_or_stamp():
    b = leg_charges(NSE_FUTURES, "SELL", 400000)
    assert b.gst == pytest.approx(ic.GST_RATE * (b.brokerage + b.exchange + b.sebi))


def test_total_is_the_sum_of_its_parts():
    b = leg_charges(NSE_OPTIONS, "SELL", 25000)
    assert b.total == pytest.approx(b.brokerage + b.tax + b.exchange + b.sebi + b.stamp + b.gst)


def test_zero_turnover_costs_nothing():
    assert leg_charges(NSE_OPTIONS, "BUY", 0).total == 0.0


def test_round_trip_is_the_open_leg_plus_the_opposite_close_leg():
    rt = round_trip_charges(NSE_EQUITY_INTRADAY, "BUY", 500.0, 510.0, 100)
    assert rt.total == pytest.approx(leg_charges(NSE_EQUITY_INTRADAY, "BUY", 50000).total + leg_charges(NSE_EQUITY_INTRADAY, "SELL", 51000).total)


def test_a_short_round_trip_charges_stt_on_the_opening_sell():
    rt = round_trip_charges(NSE_FUTURES, "SELL", 100.0, 90.0, 1000)
    assert rt.tax == pytest.approx(100.0 * 1000 * 0.0002)  # the SELL is the OPEN leg here
    assert rt.stamp == pytest.approx(90.0 * 1000 * 0.00002)  # the BUY is the close leg


def test_a_spread_sums_its_legs():
    legs = [("BUY", 100.0, 120.0, 50), ("SELL", 40.0, 45.0, 50)]
    total = group_charges(NSE_OPTIONS, legs)
    expected = sum(round_trip_charges(NSE_OPTIONS, s, e, x, q).total for s, e, x, q in legs)
    assert total.total == pytest.approx(expected)


def test_a_thin_scalp_is_visibly_eaten_by_charges():
    """The point of the model: a Rs 1 move on 100 shares (Rs 100 gross) loses a third or more to charges."""
    gross = (501.0 - 500.0) * 100
    assert round_trip_charges(NSE_EQUITY_INTRADAY, "BUY", 500.0, 501.0, 100).total > 0.3 * gross


@pytest.mark.parametrize(
    "segment, instrument, horizon, expected",
    [
        ("NSE", "spot", "intraday", NSE_EQUITY_INTRADAY),
        ("NSE", "spot", "positional", NSE_EQUITY_DELIVERY),
        ("NSE", "future", "intraday", NSE_FUTURES),
        ("NSE", "option", "positional", NSE_OPTIONS),
        ("MCX", "future", "intraday", MCX_FUTURES),
        ("MCX", "option", "intraday", MCX_OPTIONS),
        ("MCX", "spot", "intraday", MCX_FUTURES),  # no cash market on MCX
        ("CRYPTO", "future", "intraday", None),  # has its own fee simulation
        ("CRYPTO", "option", "intraday", None),
    ],
)
def test_kind_for(segment, instrument, horizon, expected):
    assert kind_for(segment, instrument, horizon) == expected


def test_the_breakdown_dict_is_rounded_and_carries_the_schedule_version():
    d = leg_charges(NSE_FUTURES, "SELL", 123456.789).as_dict()
    assert d["schedule"] == ic.SCHEDULE_VERSION and d["total"] == round(d["total"], 2)
    assert set(d) == {"brokerage", "tax", "exchange", "sebi", "stamp", "gst", "total", "schedule"}


def test_every_kind_has_a_schedule():
    for kind in (NSE_EQUITY_INTRADAY, NSE_EQUITY_DELIVERY, NSE_FUTURES, NSE_OPTIONS, MCX_FUTURES, MCX_OPTIONS):
        assert kind in ic.RATES
