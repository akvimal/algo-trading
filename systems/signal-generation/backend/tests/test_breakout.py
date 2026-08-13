from datetime import datetime, time, timedelta

import pytest

from app.domain.breakout import (
    breakout_warmup,
    compute_donchian_high,
    compute_donchian_low,
    evaluate_breakout_live,
    replay_breakout,
    simulate_breakout_trades,
)
from app.domain.rule import BreakoutRuleConfig
from app.domain.rules import CandleClose

BASE = datetime(2026, 8, 12, 9, 15)


def _htf(minute_offset: int, close: float, high: float, low: float) -> CandleClose:
    return CandleClose(timestamp=(BASE + timedelta(minutes=minute_offset)).isoformat(), close=close, high=high, low=low)


def _ltf(minute_offset: int, close: float, wick: float = 1.0) -> CandleClose:
    ts = (BASE + timedelta(minutes=minute_offset)).isoformat()
    return CandleClose(timestamp=ts, close=close, high=close + wick, low=close - wick)


RULE = BreakoutRuleConfig(
    htf_interval="15min", htf_breakout_period=2, ltf_interval="5min", ltf_breakout_period=2
)


# --- compute_donchian_high/low -----------------------------------------------------------------


def test_compute_donchian_high_excludes_current_bar():
    # donchian[i] = max of the PRIOR period values, not including i itself.
    values = [10.0, 20.0, 5.0, 30.0, 1.0]
    result = compute_donchian_high(values, period=2)
    assert result == [None, None, 20.0, 20.0, 30.0]


def test_compute_donchian_low_excludes_current_bar():
    values = [10.0, 20.0, 5.0, 30.0, 1.0]
    result = compute_donchian_low(values, period=2)
    assert result == [None, None, 10.0, 5.0, 5.0]


def test_breakout_warmup_positive():
    htf_bars, ltf_bars = breakout_warmup(RULE)
    assert htf_bars > 0
    assert ltf_bars > 0


# --- simulate_breakout_trades: clean entry -----------------------------------------------------
#
# HTF (period=2), 15min apart starting 09:15:
#   k=0: close=98  (h=100, l=95)
#   k=1: close=100 (h=102, l=97)
#   k=2: close=108 (h=110, l=99)  -> donchian_high[2]=max(100,102)=102, 108>102 -> BULLISH ARM
#   k=3: close=103 (h=105, l=100) -> only bounds window k=2, never itself iterated (4 HTF candles -> k in {0,1,2})
#
# LTF (period=2), 5min apart starting 09:15 (indices 0-8; window k=2 is [09:45,10:00) = indices 6,7,8):
#   closes: [98, 99, 97, 98, 99, 100, 103, 104, 105]
#   donchian_high[6] = max(high[4],high[5]) = max(100,101) = 101; close[6]=103 > 101 -> TRIGGER at index 6 (09:45)


def _entry_fixture_htf():
    return [
        _htf(0, close=98, high=100, low=95),
        _htf(15, close=100, high=102, low=97),
        _htf(30, close=108, high=110, low=99),
        _htf(45, close=103, high=105, low=100),
    ]


def _entry_fixture_ltf():
    closes = [98, 99, 97, 98, 99, 100, 103, 104, 105]
    return [_ltf(i * 5, c) for i, c in enumerate(closes)]


def test_simulate_breakout_trades_clean_entry():
    trades = simulate_breakout_trades(RULE, _entry_fixture_htf(), _entry_fixture_ltf())

    assert len(trades) == 1
    trade = trades[0]
    assert trade.direction == "bullish"
    assert trade.entry_price == 103.0
    assert trade.entry_time == (BASE + timedelta(minutes=30)).isoformat()  # ltf index 6 = 09:45
    assert trade.exit_reason == "end_of_data"
    assert trade.exit_price == 105.0  # last ltf candle's close
    assert trade.pnl == pytest.approx(2.0)


def test_replay_breakout_matches_simulate():
    result = replay_breakout(RULE, _entry_fixture_htf(), _entry_fixture_ltf())
    assert result["trade_count"] == 1
    assert result["hypothetical_pnl"] == pytest.approx(2.0)
    assert result["trades"][0]["exit_reason"] == "end_of_data"


# --- arm expiry: no LTF trigger within the window -> must not fire later -----------------------


def test_simulate_breakout_trades_arm_expires_without_ltf_trigger():
    # Same HTF setup (arms at k=2), but the LTF stays flat through window k=2
    # (indices 6,7,8) - no breakout there. Extend one more HTF candle (k=3,
    # itself NOT a fresh breakout) and let the LTF break out later, in
    # window k=3 - since k=2's arm already expired at k=3 (per the "valid
    # only until next HTF close" rule) and k=3 itself doesn't re-arm, that
    # later LTF breakout must NOT open a position.
    htf = _entry_fixture_htf() + [_htf(60, close=101, high=103, low=98)]  # k=3 stays flat, no fresh breakout, no reversal (net position is None so reversal doesn't apply)
    ltf_closes = [98, 99, 97, 98, 99, 100, 100, 99, 100, 150, 160, 170]  # indices 6,7,8 (window k=2) flat; 9,10,11 (window k=3) break out hard
    ltf = [_ltf(i * 5, c) for i, c in enumerate(ltf_closes)]

    trades = simulate_breakout_trades(RULE, htf, ltf)

    assert trades == []  # the expired k=2 arm must not be triggered by window k=3's breakout


# --- newer HTF confirmation replaces the pending arm (reset) -----------------------------------


def test_simulate_breakout_trades_newer_confirmation_replaces_pending_arm():
    # k=2 arms bullish (as in the clean-entry fixture), but the LTF window
    # k=2 never triggers (flat). k=3 ALSO confirms a fresh bullish breakout
    # (its own close beats the k=1..k=2 donchian high) before anything
    # fired - the reference should move to k=3, so the eventual entry's
    # initial_stop must be k=3's low, NOT k=2's low.
    htf = [
        _htf(0, close=98, high=100, low=95),
        _htf(15, close=100, high=102, low=97),
        _htf(30, close=108, high=110, low=99),  # k=2 arms (low=99)
        _htf(45, close=120, high=125, low=115),  # k=3: donchian_high[3]=max(102,110)=110, 120>110 -> re-arms (low=115)
        _htf(60, close=118, high=122, low=112),  # k=4: window bound only
    ]
    ltf_closes = [98, 99, 97, 98, 99, 100, 100, 99, 100, 100, 101, 130]
    # indices 6,7,8 = window k=2 (flat, no trigger); 9,10,11 = window k=3 - index 11 breaks out hard
    ltf = [_ltf(i * 5, c) for i, c in enumerate(ltf_closes)]

    trades = simulate_breakout_trades(RULE, htf, ltf)

    assert len(trades) == 1
    assert trades[0].direction == "bullish"
    # initial stop only observable via a stop-loss hit - open a follow-up
    # scenario check instead: re-run with a bar whose low pierces k=3's
    # low (115) but NOT k=2's low (99), and confirm it stops out.
    htf_with_dip = htf + [_htf(75, close=118, high=120, low=116)]
    ltf_with_dip = ltf + [_ltf(65, close=116, wick=3)]  # low = 113, below 115 but nowhere near 99
    trades_with_dip = simulate_breakout_trades(RULE, htf_with_dip, ltf_with_dip)
    assert trades_with_dip[0].exit_reason == "initial_stop_loss"
    assert trades_with_dip[0].exit_price == 115.0  # k=3's low, not k=2's (99)


# --- initial stop-loss ---------------------------------------------------------------------------


def test_simulate_breakout_trades_initial_stop_loss_hit():
    htf = _entry_fixture_htf()
    # Same entry as the clean-entry fixture (triggers at ltf index 6,
    # entry_price=103, initial_stop = htf[2].low = 99) - append a bar
    # whose low pierces 99, still within window k=2 ([09:45, 10:00) =
    # offsets [30, 45)).
    ltf = _entry_fixture_ltf() + [_ltf(41, close=97, wick=3)]  # low = 94, below 99
    trades = simulate_breakout_trades(RULE, htf, ltf)
    assert len(trades) == 1
    assert trades[0].exit_reason == "initial_stop_loss"
    assert trades[0].exit_price == 99.0


# --- reversal exit: closes only, never flips ----------------------------------------------------


def test_simulate_breakout_trades_reversal_exit_closes_only():
    # Built from scratch (not the shared entry fixture) so k=3's close is
    # deliberately HIGHER than k=2's - otherwise k=2(108)->k=3(103) is
    # already itself a 1-bar decline and spuriously arms a reversal one
    # bar too early. k=4's low (102) is deliberately ABOVE the initial
    # stop (99, from k=2's low) so a bar that breaches the reversal level
    # without also breaching the SL can isolate the reversal-exit path -
    # the SL is checked first in priority order, so a bar tripping both
    # would always report "initial_stop_loss" instead.
    htf = [
        _htf(0, close=98, high=100, low=95),
        _htf(15, close=100, high=102, low=97),
        _htf(30, close=108, high=110, low=99),  # k=2: donchian_high=102, 108>102 -> bullish entry arm (initial stop = low = 99)
        _htf(45, close=112, high=114, low=106),  # k=3: higher than k=2's close - no spurious reversal
        _htf(60, close=90, high=104, low=102),  # k=4: close(90) < prev close(112) -> reversal arm, level = low = 102
        _htf(75, close=98, high=103, low=95),  # k=5: window bound only
    ]
    # window k=2 = [09:45,10:00) -> ltf indices 6,7,8 (entry triggers at 6)
    # window k=4 = [10:15,10:30) -> ltf indices 12,13,14 (index 14 closes below 102, low stays above 99)
    ltf_closes = [98, 99, 97, 98, 99, 100, 103, 104, 105, 104, 103, 102, 103, 102, 101]
    ltf = [_ltf(i * 5, c) for i, c in enumerate(ltf_closes)]

    trades = simulate_breakout_trades(RULE, htf, ltf)

    assert len(trades) == 1  # exactly one trade - the reversal exit must NOT also open a new (short) position
    trade = trades[0]
    assert trade.direction == "bullish"
    assert trade.entry_price == 103.0
    assert trade.exit_reason == "reversal_exit"
    assert trade.exit_price == 101.0  # the LTF candle's own close, not the breached level


# --- square-off takes priority over a pending reversal arm --------------------------------------


def test_simulate_breakout_trades_square_off_closes_ahead_of_reversal():
    htf = _entry_fixture_htf() + [
        _htf(60, close=90, high=104, low=88),  # k=3: reversal arm, level=88
        _htf(75, close=85, high=91, low=80),
    ]
    ltf_closes = [98, 99, 97, 98, 99, 100, 103, 104, 105, 104, 103, 102]  # index 11 (10:15) does NOT breach 88
    ltf = [_ltf(i * 5, c) for i, c in enumerate(ltf_closes)]
    # square_off_time is 10:05 - the bar at offset 50 (index 10, 10:05) should close the position there.
    trades = simulate_breakout_trades(RULE, htf, ltf, square_off_time=time(10, 5))

    assert len(trades) == 1
    assert trades[0].exit_reason == "square_off"
    assert trades[0].exit_time == (BASE + timedelta(minutes=50)).isoformat()


# --- EMA filter blocks an otherwise-valid HTF breakout -------------------------------------------


def test_simulate_breakout_trades_ema_filter_blocks_arm():
    rule = BreakoutRuleConfig(
        htf_interval="15min", htf_breakout_period=2, ltf_interval="5min", ltf_breakout_period=2,
        ema_filter_enabled=True, ema_period=2,
    )
    # Same HTF prices as the clean-entry fixture, but k=2's close (108) -
    # while still a Donchian breakout - must ALSO be compared against
    # EMA(2) of HTF closes; construct closes so EMA(2) at k=2 sits above
    # 108, so the filter blocks the arm even though the raw breakout holds.
    htf = [
        _htf(0, close=200, high=205, low=195),
        _htf(15, close=200, high=202, low=197),
        _htf(30, close=108, high=110, low=99),  # Donchian breaks out (108 > 102) but EMA(2) is dragged high by the 200s above
    ]
    ltf = _entry_fixture_ltf()

    trades = simulate_breakout_trades(rule, htf, ltf)
    assert trades == []


# --- evaluate_breakout_live: only the latest HTF candle's arm is live-relevant -------------------


def test_evaluate_breakout_live_fresh_arm_triggers():
    htf = _entry_fixture_htf()[:3]  # k=0,1,2 - k=2 (the latest) arms bullish
    ltf = _entry_fixture_ltf()[:7]  # through index 6, which triggers
    result = evaluate_breakout_live(RULE, htf, ltf)
    assert result is not None
    bias, ts = result
    assert bias == "bullish"
    assert ts == (BASE + timedelta(minutes=30)).isoformat()


def test_evaluate_breakout_live_older_expired_arm_does_not_fire():
    # k=2 arms bullish, but a NEWER HTF candle (k=3, not itself a fresh
    # breakout) has since closed - live evaluation only ever looks at the
    # LATEST completed HTF candle (k=3 here), which has no arm of its own,
    # so nothing should fire even though the LTF later breaks out.
    htf = _entry_fixture_htf()  # includes k=3 (close=103, not a fresh breakout beyond k=2's own high)
    ltf_closes = [98, 99, 97, 98, 99, 100, 100, 99, 100, 150]  # index 9 breaks out hard, well after k=2's window
    ltf = [_ltf(i * 5, c) for i, c in enumerate(ltf_closes)]
    result = evaluate_breakout_live(RULE, htf, ltf)
    assert result is None


def test_evaluate_breakout_live_too_little_data_returns_none():
    assert evaluate_breakout_live(RULE, [_htf(0, 100, 101, 99)], [_ltf(0, 100)]) is None
