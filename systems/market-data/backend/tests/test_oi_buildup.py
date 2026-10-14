"""Tests for app/domain/oi_buildup.compute_eod_buildup - pure day-over-day
diffing/classification for the OI-buildup EOD screener (GET /oi-buildup),
with no Dhan/DB dependency. See app/scheduler.py's _record_oi_eod_snapshot
for the job that calls this against a real previous DB row."""

from app.domain.oi_buildup import PreviousSnapshot, compute_eod_buildup


def test_no_previous_snapshot_returns_all_none():
    result = compute_eod_buildup(total_call_oi=100_000, total_put_oi=80_000, spot_price=1000.0, previous=None)

    assert result.call_oi_change_pct is None
    assert result.put_oi_change_pct is None
    assert result.price_change_pct is None
    assert result.call_buildup is None
    assert result.put_buildup is None


def test_long_buildup_when_oi_and_price_both_rise():
    previous = PreviousSnapshot(total_call_oi=100_000, total_put_oi=80_000, spot_price=1000.0)
    result = compute_eod_buildup(total_call_oi=110_000, total_put_oi=80_000, spot_price=1010.0, previous=previous)

    assert result.call_oi_change_pct == 10.0
    assert result.put_oi_change_pct == 0.0
    assert result.price_change_pct == 1.0
    assert result.call_buildup == "long_buildup"
    # put OI unchanged (0 diff) - _classify_buildup's "not oi_change" guard
    # treats a flat 0 the same as "nothing to classify yet".
    assert result.put_buildup is None


def test_short_buildup_when_oi_rises_and_price_falls():
    previous = PreviousSnapshot(total_call_oi=100_000, total_put_oi=80_000, spot_price=1000.0)
    result = compute_eod_buildup(total_call_oi=100_000, total_put_oi=90_000, spot_price=980.0, previous=previous)

    assert result.put_buildup == "short_buildup"


def test_short_covering_when_oi_falls_and_price_rises():
    previous = PreviousSnapshot(total_call_oi=100_000, total_put_oi=80_000, spot_price=1000.0)
    result = compute_eod_buildup(total_call_oi=90_000, total_put_oi=80_000, spot_price=1020.0, previous=previous)

    assert result.call_buildup == "short_covering"


def test_long_unwinding_when_oi_and_price_both_fall():
    previous = PreviousSnapshot(total_call_oi=100_000, total_put_oi=80_000, spot_price=1000.0)
    result = compute_eod_buildup(total_call_oi=90_000, total_put_oi=80_000, spot_price=980.0, previous=previous)

    assert result.call_buildup == "long_unwinding"


def test_zero_previous_oi_gives_none_pct_but_still_classifies():
    # A symbol with genuinely zero call OI yesterday - pct change is
    # undefined (division by zero), but the raw diff is still a perfectly
    # good non-zero number to classify against.
    previous = PreviousSnapshot(total_call_oi=0, total_put_oi=80_000, spot_price=1000.0)
    result = compute_eod_buildup(total_call_oi=5_000, total_put_oi=80_000, spot_price=1010.0, previous=previous)

    assert result.call_oi_change_pct is None
    assert result.call_buildup == "long_buildup"


# ---- who moved the open interest (the option's own premium) ----------------------------------------------------------------------------------------
from app.domain.models import OptionChain, OptionChainStrike, OptionGreeks, OptionLegQuote
from app.domain.oi_buildup import PreviousSnapshot, classify_activity, compute_eod_activity, weighted_premium_change_pct


def _leg(oi, last, prev_close):
    return OptionLegQuote(
        security_id="1", last_price=last, oi=oi, previous_oi=oi, previous_close_price=prev_close, volume=1, implied_volatility=12.0,
        top_bid_price=last, top_ask_price=last, greeks=OptionGreeks(delta=0.5, theta=-1.0, gamma=0.001, vega=2.0), moneyness="ATM",
    )


def _chain(ce, pe, spot=100.0):
    return OptionChain(
        underlying_symbol="X", underlying_exchange="NSE", expiry="2026-10-27", underlying_last_price=spot,
        strikes=[OptionChainStrike(strike=100.0, ce=ce, pe=pe)],
    )


def test_premium_change_is_the_open_interest_weighted_move_since_the_previous_close():
    c = _chain(_leg(1000, 12.0, 10.0), _leg(1000, 4.0, 5.0))
    assert weighted_premium_change_pct(c, "ce") == 20.0
    assert weighted_premium_change_pct(c, "pe") == -20.0


def test_a_leg_with_no_usable_previous_close_is_left_out():
    assert weighted_premium_change_pct(_chain(_leg(1000, 12.0, None), _leg(1000, 4.0, 0.4)), "ce") is None
    assert weighted_premium_change_pct(_chain(_leg(1000, 12.0, None), _leg(1000, 4.0, 0.4)), "pe") is None  # under a rupee


def test_the_four_activities():
    assert classify_activity(500, 10) == "buying"
    assert classify_activity(500, -10) == "writing"
    assert classify_activity(-500, 10) == "writers_covering"
    assert classify_activity(-500, -10) == "unwinding"
    assert classify_activity(0, 10) is None and classify_activity(500, None) is None and classify_activity(500, 0) is None


def test_a_put_whose_oi_grew_as_the_stock_rose_is_writing_when_its_premium_fell():
    # CANBK on 14 Oct: stock up, put OI up 28.7% - the put premium fell, so those puts were written.
    c = _chain(_leg(1300, 9.0, 8.0), _leg(1287, 2.0, 3.0))
    prev = PreviousSnapshot(total_call_oi=1000, total_put_oi=1000, spot_price=95.0)
    r = compute_eod_activity(c, 1300, 1287, prev)
    assert (r.call_activity, r.put_activity) == ("buying", "writing")


def test_on_a_first_day_the_premium_change_is_kept_but_there_is_no_activity():
    r = compute_eod_activity(_chain(_leg(1000, 12.0, 10.0), _leg(1000, 4.0, 5.0)), 1000, 1000, None)
    assert r.call_premium_change_pct == 20.0 and r.call_activity is None and r.put_activity is None
