"""Tests for app/domain/sentiment.py - pure aggregation over an already-
built OptionOiSummary, no Dhan/network dependency. See test_oi_summary.py
for the summary-building tests this sits on top of."""

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from app.domain.models import OptionOiLeg, OptionOiSummary, OptionOiSummaryStrike
from app.domain.sentiment import aggregate_exchange, exchange_for_symbol, is_within_session, score_underlying, session_bounds


def _summary(call_oi: int, put_oi: int, call_chg_5m, put_chg_5m, call_chg_15m, put_chg_15m) -> OptionOiSummary:
    return OptionOiSummary(
        underlying_symbol="NIFTY",
        underlying_exchange="NSE",
        expiry="2026-08-28",
        underlying_last_price=24000.0,
        total_call_oi=call_oi,
        total_put_oi=put_oi,
        total_call_oi_change_5m=call_chg_5m,
        total_put_oi_change_5m=put_chg_5m,
        total_call_oi_change_15m=call_chg_15m,
        total_put_oi_change_15m=put_chg_15m,
        strikes=[],
    )


def test_score_underlying_no_summary_is_neutral_with_error():
    result = score_underlying("NIFTY", None, error="Dhan API rejected the access token (401)")

    assert result.direction == "neutral"
    assert result.strength is None
    assert result.error == "Dhan API rejected the access token (401)"


def test_score_underlying_put_oi_outgrowing_call_oi_is_bullish():
    # total OI 1,000,000; put grew 20,000 more than call -> +2% shift
    summary = _summary(500000, 500000, call_chg_5m=0, put_chg_5m=20000, call_chg_15m=0, put_chg_15m=20000)

    result = score_underlying("NIFTY", summary)

    assert result.direction == "bullish"
    assert result.score_15m == 2.0
    # 5m and 15m agree in direction -> bumped up a notch from the 15m-only bucket (strong, since 2.0 >= 1.5)
    assert result.strength == "very_strong"


def test_score_underlying_call_oi_outgrowing_put_oi_is_bearish():
    summary = _summary(500000, 500000, call_chg_5m=20000, put_chg_5m=0, call_chg_15m=20000, put_chg_15m=0)

    result = score_underlying("NIFTY", summary)

    assert result.direction == "bearish"
    assert result.score_15m == -2.0


def test_score_underlying_small_shift_is_neutral():
    # 0.1% shift - below the mild threshold
    summary = _summary(500000, 500000, call_chg_5m=0, put_chg_5m=1000, call_chg_15m=0, put_chg_15m=1000)

    result = score_underlying("NIFTY", summary)

    assert result.direction == "neutral"
    assert result.strength is None


def test_score_underlying_conflicting_5m_and_15m_capped_at_mild():
    # 15m says bullish +2% (would bucket as "strong" alone), 5m says
    # bearish -1% - conflicting signals cap the result at mild regardless
    # of the 15m magnitude.
    summary = _summary(500000, 500000, call_chg_5m=10000, put_chg_5m=0, call_chg_15m=0, put_chg_15m=20000)

    result = score_underlying("NIFTY", summary)

    assert result.direction == "bullish"  # driven by the 15m primary read
    assert result.strength == "mild"  # capped despite the underlying magnitude


def test_score_underlying_missing_change_data_is_neutral():
    summary = _summary(500000, 500000, call_chg_5m=None, put_chg_5m=None, call_chg_15m=None, put_chg_15m=None)

    result = score_underlying("NIFTY", summary)

    assert result.direction == "neutral"
    assert result.score_5m is None
    assert result.score_15m is None


def test_score_underlying_zero_total_oi_is_neutral_not_a_crash():
    summary = _summary(0, 0, call_chg_5m=0, put_chg_5m=0, call_chg_15m=0, put_chg_15m=0)

    result = score_underlying("NIFTY", summary)

    assert result.direction == "neutral"


def test_aggregate_exchange_averages_across_underlyings():
    bullish = score_underlying("NIFTY", _summary(500000, 500000, 0, 20000, 0, 20000))  # +2%
    neutral = score_underlying("BANKNIFTY", _summary(500000, 500000, 0, 0, 0, 0))  # 0%

    result = aggregate_exchange([bullish, neutral])

    assert result.score == 1.0  # mean of +2% and 0%
    assert result.direction == "bullish"
    assert result.underlyings == [bullish, neutral]


def test_aggregate_exchange_skips_underlyings_with_no_data():
    bullish = score_underlying("NIFTY", _summary(500000, 500000, 0, 20000, 0, 20000))  # +2%
    missing = score_underlying("BANKNIFTY", None, error="fetch failed")

    result = aggregate_exchange([bullish, missing])

    assert result.score == 2.0  # missing excluded from the mean, not treated as 0


def test_aggregate_exchange_all_missing_is_neutral_with_no_score():
    missing_a = score_underlying("NIFTY", None, error="fetch failed")
    missing_b = score_underlying("BANKNIFTY", None, error="fetch failed")

    result = aggregate_exchange([missing_a, missing_b])

    assert result.direction == "neutral"
    assert result.score is None


def _leg(moneyness: str, buildup) -> OptionOiLeg:
    return OptionOiLeg(
        oi=100000,
        implied_volatility=15.0,
        last_price=100.0,
        volume=1000,
        top_bid_price=99.5,
        top_ask_price=100.5,
        moneyness=moneyness,
        buildup=buildup,
    )


def test_score_underlying_surfaces_the_atm_strikes_own_call_and_put_buildup():
    """The ATM strike's own per-leg buildup (already computed by
    build_oi_summary/_classify_buildup - that leg's own OI change vs its
    own PREMIUM change) should pass through onto UnderlyingSentiment,
    deliberately as two separate values rather than one merged label - a
    rising call OI and a rising put OI mean different things."""
    summary = _summary(500000, 500000, 0, 20000, 0, 20000)
    summary = summary.model_copy(
        update={
            "strikes": [
                OptionOiSummaryStrike(strike=23900, call=_leg("OTM", "short_covering"), put=_leg("OTM", "long_unwinding")),
                OptionOiSummaryStrike(strike=24000, call=_leg("ATM", "long_buildup"), put=_leg("ATM", "short_buildup")),
                OptionOiSummaryStrike(strike=24100, call=_leg("ITM", None), put=_leg("ITM", None)),
            ]
        }
    )

    result = score_underlying("NIFTY", summary)

    assert result.atm_call_buildup == "long_buildup"
    assert result.atm_put_buildup == "short_buildup"


def test_score_underlying_atm_buildup_none_when_no_strike_is_marked_atm():
    summary = _summary(500000, 500000, 0, 20000, 0, 20000)
    summary = summary.model_copy(
        update={"strikes": [OptionOiSummaryStrike(strike=23900, call=_leg("OTM", "short_covering"), put=_leg("ITM", "long_unwinding"))]}
    )

    result = score_underlying("NIFTY", summary)

    assert result.atm_call_buildup is None
    assert result.atm_put_buildup is None


def test_score_underlying_atm_buildup_none_when_no_summary():
    result = score_underlying("NIFTY", None, error="fetch failed")

    assert result.atm_call_buildup is None
    assert result.atm_put_buildup is None


IST = ZoneInfo("Asia/Kolkata")


def test_is_within_session_nse_open_and_closed():
    assert is_within_session("NSE", datetime(2026, 8, 31, 10, 0, tzinfo=IST)) is True
    assert is_within_session("NSE", datetime(2026, 8, 31, 9, 15, tzinfo=IST)) is True  # boundary, inclusive
    assert is_within_session("NSE", datetime(2026, 8, 31, 15, 30, tzinfo=IST)) is True  # boundary, inclusive
    assert is_within_session("NSE", datetime(2026, 8, 31, 8, 59, tzinfo=IST)) is False
    assert is_within_session("NSE", datetime(2026, 8, 31, 15, 31, tzinfo=IST)) is False


def test_is_within_session_mcx_wider_window():
    assert is_within_session("MCX", datetime(2026, 8, 31, 22, 0, tzinfo=IST)) is True
    assert is_within_session("MCX", datetime(2026, 8, 31, 23, 45, tzinfo=IST)) is False


def test_is_within_session_unconfigured_exchange_always_true():
    # CRYPTO (and anything else with no SEGMENT_SESSION_HOURS entry) trades
    # 24/7 - always in session, any time of day.
    assert is_within_session("CRYPTO", datetime(2026, 8, 31, 3, 0, tzinfo=IST)) is True


def test_exchange_for_symbol_known_and_unknown():
    assert exchange_for_symbol("NIFTY") == "NSE"
    assert exchange_for_symbol("GOLDM") == "MCX"
    assert exchange_for_symbol("NOT_A_WATCHLIST_SYMBOL") is None


def test_session_bounds_resolves_to_that_days_configured_window():
    start, end = session_bounds("NSE", date(2026, 8, 31), IST)

    assert start == datetime(2026, 8, 31, 9, 15, tzinfo=IST)
    assert end == datetime(2026, 8, 31, 15, 30, tzinfo=IST)


def test_session_bounds_unconfigured_exchange_spans_whole_day():
    start, end = session_bounds("CRYPTO", date(2026, 8, 31), IST)

    assert start == datetime(2026, 8, 31, 0, 0, tzinfo=IST)
    assert end == datetime.combine(date(2026, 8, 31), time.max, tzinfo=IST)
