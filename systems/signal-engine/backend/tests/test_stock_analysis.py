"""The combined chart + business read of one stock (app/domain/stock_analysis.py and GET /analysis/{symbol}). Plain fakes, direct calls."""

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.api.routes import analysis as route
from app.auth import Caller
from app.domain import stock_analysis as sa
from app.domain.weekly_advisor.contracts import TechnicalSnapshot, Zone
from app.domain.weekly_advisor.regime_engine import OrderBlockZone
from app.domain.weekly_advisor.screener_fetch import FundamentalAnalysis

ME = Caller(user_id=uuid.UUID("11111111-1111-1111-1111-111111111111"), is_admin=False, enforced=True)
TODAY = date(2026, 10, 12)


def snap(timeframe="weekly", close=100.0, ema50=90.0, adx=30.0, slope="rising", volume_ok=True, support=(), resistance=()):
    return TechnicalSnapshot(
        timeframe=timeframe, close=close, ema20=95.0, ema50=ema50, adx14=adx, adx14_slope=slope, atr14=2.0,
        support_zones=[Zone(low=lo, high=hi, basis=f"support {lo}") for lo, hi in support],
        resistance_zones=[Zone(low=lo, high=hi, basis=f"resistance {lo}") for lo, hi in resistance],
        volume=1000.0, volume_sma20=800.0 if volume_ok else 2000.0, volume_confirmed=volume_ok,
    )


def fundamentals(bias="bullish", confidence=0.7, pros=("Debt free", "Profit up 5 years", "Good cash flow", "Fourth pro"), cons=("High valuation",)):
    return FundamentalAnalysis(
        symbol="X", bias=bias, confidence=confidence, summary="A decent business." if bias else None, pros=list(pros), cons=list(cons),
        reasons=["Profit up"], fetched_at=datetime.now(timezone.utc) - timedelta(days=2),
    )


def build(weekly=None, daily=None, fund=None, note=None, **kw):
    return sa.build_analysis("X", weekly or snap(), daily or snap("daily"), kw.get("wb"), kw.get("db"), fund, note, TODAY)


UP = dict(weekly=snap(close=100, ema50=90), daily=snap("daily", close=100, ema50=92))
DOWN = dict(weekly=snap(close=80, ema50=90), daily=snap("daily", close=80, ema50=88))
FLAT = dict(weekly=snap(close=90, ema50=90, adx=15, slope="flat"), daily=snap("daily", close=90, ema50=90, adx=15, slope="flat"))


class TestTheVerdict:
    def test_a_rising_chart_and_a_good_business_agree(self):
        a = build(**UP, fund=fundamentals("bullish"))
        assert (a.technical.bias, a.fundamental.bias, a.verdict.agreement) == ("bullish", "bullish", "aligned")
        assert a.verdict.headline == "The trend and the business both point up" and a.verdict.bias == "bullish"

    def test_a_rising_chart_with_a_weak_business_conflicts_and_says_so(self):
        a = build(**UP, fund=fundamentals("bearish"))
        assert a.verdict.agreement == "conflicting" and a.verdict.headline == "Price is rising, but the business case is weak"
        assert "disagree" in a.verdict.reading

    def test_a_falling_chart_with_a_good_business(self):
        a = build(**DOWN, fund=fundamentals("bullish"))
        assert a.verdict.agreement == "conflicting" and a.verdict.headline == "The business looks good, but the trend is down"

    def test_a_neutral_side_makes_it_mixed(self):
        a = build(**UP, fund=fundamentals("neutral"))
        assert a.verdict.agreement == "mixed" and a.verdict.headline == "The trend is up; the business read is mixed"

    def test_no_edge_either_way(self):
        a = build(**FLAT, fund=fundamentals("neutral"))
        assert a.technical.bias == "neutral" and a.verdict.headline == "No clear edge from the chart or the business"

    def test_a_ranging_chart_is_flagged_as_less_reliable(self):
        a = build(weekly=snap(close=100, ema50=90, adx=15, slope="flat"), daily=snap("daily", close=100, ema50=90), fund=fundamentals("bullish"))
        assert a.technical.trend_strength == "ranging" and "range-bound" in a.verdict.reading

    def test_every_headline_exists_for_every_pairing(self):
        for t in ("bullish", "bearish", "neutral"):
            for f in ("bullish", "bearish", "neutral"):
                assert sa.verdict_of(t, f, "neutral", 0.0, "trending").headline


class TestWithoutTheBusinessRead:
    def test_the_chart_is_still_returned_with_the_reason_and_the_key_hint(self):
        a = build(**UP, fund=None, note="Fundamentals are read by AI and need an OpenRouter key.")
        assert a.fundamental.available is False and "OpenRouter key" in a.fundamental.note
        assert a.verdict.agreement == "technical_only" and "business read not available" in a.verdict.headline
        assert a.technical.bias == "bullish"

    def test_a_stored_page_with_no_read_counts_as_not_available(self):
        a = build(**UP, fund=fundamentals(bias=None))
        assert a.fundamental.available is False


class TestTheChartInPlainWords:
    def test_the_points_say_what_is_going_on(self):
        a = build(**UP, fund=None)
        text = " | ".join(a.technical.points)
        assert "Weekly: price is above its 50-week average" in text
        assert "Daily: price is above its 50-day average" in text
        assert "Trend strength is strong (ADX 30, rising)" in text
        assert "Volume is above its 20-bar average" in text

    def test_a_weak_down_trend_with_light_volume(self):
        a = build(weekly=snap(close=80, ema50=90, adx=18, slope="falling", volume_ok=False), daily=snap("daily", close=80, ema50=88, volume_ok=False), fund=None)
        text = " | ".join(a.technical.points)
        assert "below its 50-week average" in text and "weak (range-bound)" in text and "Volume is light" in text

    def test_order_block_and_structure_reads_are_added_in_words(self):
        wb = [OrderBlockZone(kind="demand", proximal=101.0, distal=95.0, mitigated=False)]
        a = build(**UP, fund=None, wb=wb)
        assert len(a.technical.points) > 4  # the plain four plus what structure / order blocks said

    def test_the_nearest_support_and_resistance_are_listed_nearest_first_without_overlaps(self):
        weekly = snap(close=100, support=[(80, 85), (92, 96)], resistance=[(110, 115), (130, 140)])
        daily = snap("daily", close=100, support=[(94, 97), (70, 75)], resistance=[(105, 108)])
        a = build(weekly=weekly, daily=daily, fund=None)
        assert [(l.low, l.high, l.timeframe) for l in a.technical.support] == [(94, 97, "daily"), (80, 85, "weekly")]  # (92-96) overlaps the daily zone: dropped
        assert [(l.low, l.high) for l in a.technical.resistance] == [(105, 108), (110, 115)]
        assert a.technical.resistance[0].distance_pct == 5.0 and a.technical.support[0].distance_pct == 3.0

    def test_zones_on_the_wrong_side_of_the_price_are_not_support_or_resistance(self):
        a = build(weekly=snap(close=100, support=[(105, 110)], resistance=[(80, 90)]), daily=snap("daily", close=100), fund=None)
        assert a.technical.support == [] and a.technical.resistance == []


class TestTheBusinessInShortForm:
    def test_pros_and_cons_are_trimmed_to_three_and_a_line(self):
        long_con = "x" * 300
        a = build(**UP, fund=fundamentals(cons=(long_con,)))
        assert len(a.fundamental.pros) == 3 and a.fundamental.pros[0] == "Debt free"
        assert a.fundamental.cons[0].endswith("…") and len(a.fundamental.cons[0]) <= 140
        assert a.fundamental.summary == "A decent business." and a.fundamental.reasons == ["Profit up"]


# ---- the route -------------------------------------------------------------------------------------------------------------------------

@pytest.fixture
def env(monkeypatch):
    st = {"fund": (fundamentals(), False), "problem": None, "calls": []}
    monkeypatch.setattr(route, "caller_key", lambda caller: "key")

    def read(sym, key, refresh=False):
        st["calls"].append(("read", sym, key, refresh))
        if st["problem"] is not None:
            raise st["problem"]
        return st["fund"]

    def analyze(sym, fund, note, as_of=None, needs_key=False):
        st["calls"].append(("analyze", sym, fund is not None, note, needs_key))
        return sa.build_analysis(sym, snap(), snap("daily"), None, None, fund, note, TODAY, needs_key)

    monkeypatch.setattr(route, "read_fundamentals", read)
    monkeypatch.setattr(route, "analyze_stock", analyze)
    return st


def test_the_route_returns_the_combined_read(env):
    out = route.get_stock_analysis("reliance", refresh=False, caller=ME)
    assert out.symbol == "RELIANCE" and out.verdict.agreement == "aligned"
    assert env["calls"][0] == ("read", "RELIANCE", "key", False)


def test_with_no_key_the_chart_still_comes_back_and_points_to_settings(env):
    env["problem"] = route.FundamentalsProblem(409, "needs a key", "openrouter_key_required")
    out = route.get_stock_analysis("RELIANCE", refresh=False, caller=ME)
    assert out.fundamental.available is False and out.fundamental.needs_key is True and out.fundamental.note == "needs a key"


def test_a_page_that_could_not_be_read_is_a_note_not_an_error(env):
    env["problem"] = route.FundamentalsProblem(503, "could not read screener.in")
    out = route.get_stock_analysis("RELIANCE", refresh=False, caller=ME)
    assert out.fundamental.available is False and out.fundamental.needs_key is False and "screener.in" in out.fundamental.note


def test_too_little_history_is_a_clear_refusal(env, monkeypatch):
    def short(*a, **k):
        raise sa.NotEnoughHistory("X has too little price history")

    monkeypatch.setattr(route, "analyze_stock", short)
    with pytest.raises(HTTPException) as e:
        route.get_stock_analysis("NEWLISTING", refresh=False, caller=ME)
    assert e.value.status_code == 422 and "too little" in e.value.detail


def test_a_market_data_failure_is_a_bad_gateway(env, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("market-data down")

    monkeypatch.setattr(route, "analyze_stock", boom)
    with pytest.raises(HTTPException) as e:
        route.get_stock_analysis("RELIANCE", refresh=False, caller=ME)
    assert e.value.status_code == 502


def test_a_bad_symbol_is_refused_before_anything_is_fetched(env):
    with pytest.raises(HTTPException) as e:
        route.get_stock_analysis("../etc", refresh=False, caller=ME)
    assert e.value.status_code == 422 and env["calls"] == []
