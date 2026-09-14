"""Route-level tests for GET /weekly-advisor/recommendations - a partial
failure (one symbol's pipeline raising) must be skipped, not fatal to the
rest of the batch."""
import time
from datetime import date, timedelta

from fastapi.testclient import TestClient

import app.api.routes.weekly_advisor as route
from app.domain.weekly_advisor.contracts import (
    ExitRule,
    GeneratedBy,
    OISnapshot,
    RegimeAssessment,
    StrategyRecommendation,
    EntryWindow,
    TechnicalSnapshot,
    WeeklyRecommendation,
)
from app.main import app

client = TestClient(app)


def _fake_recommendation(symbol: str) -> WeeklyRecommendation:
    technical = TechnicalSnapshot(
        timeframe="weekly", close=100.0, ema20=100.0, ema50=100.0,
        adx14=15.0, adx14_slope="flat", atr14=3.0,
        volume=1.0, volume_sma20=1.0, volume_confirmed=True,
    )
    return WeeklyRecommendation(
        symbol=symbol, as_of="2026-06-01T00:00:00", technical=technical, oi=OISnapshot(available=False),
        regime=RegimeAssessment(bias="neutral", trend_strength="ranging", confidence=0.0, reasons=[]),
        strategy=StrategyRecommendation(
            action="avoid_new_entry", legs=[],
            entry_window=EntryWindow(earliest=date(2026, 6, 1), latest=date(2026, 6, 25), days_to_expiry_at_entry=24),
            exit_rule=ExitRule(),
        ),
        generated_by=GeneratedBy(engine_version="test"),
    )


def test_recommendations_route_skips_failing_symbol_without_failing_the_batch(monkeypatch):
    def fake_run_symbol(symbol, as_of=None):
        if symbol == "BADSYM":
            raise ValueError("insufficient history for a stable weekly read")
        return _fake_recommendation(symbol)

    monkeypatch.setattr(route, "run_symbol", fake_run_symbol)

    resp = client.get("/weekly-advisor/recommendations", params={"symbols": "GOODSYM,BADSYM"})

    assert resp.status_code == 200
    body = resp.json()
    assert [r["symbol"] for r in body["recommendations"]] == ["GOODSYM"]
    assert body["skipped"] == [{"symbol": "BADSYM", "reason": "insufficient history for a stable weekly read"}]


def test_recommendations_route_defaults_to_starter_symbol_list(monkeypatch):
    seen = []

    def fake_run_symbol(symbol, as_of=None):
        seen.append(symbol)
        return _fake_recommendation(symbol)

    monkeypatch.setattr(route, "run_symbol", fake_run_symbol)

    resp = client.get("/weekly-advisor/recommendations")

    assert resp.status_code == 200
    assert seen == route.DEFAULT_SYMBOLS


def test_recommendations_route_preserves_requested_order_despite_concurrency(monkeypatch):
    """The route runs symbols through a thread pool for speed (see
    _BATCH_CONCURRENCY) - a slower-finishing symbol earlier in the request
    must not end up later in the response."""
    delays = {"SLOW": 0.05, "FAST1": 0.0, "FAST2": 0.0}

    def fake_run_symbol(symbol, as_of=None):
        time.sleep(delays[symbol])
        return _fake_recommendation(symbol)

    monkeypatch.setattr(route, "run_symbol", fake_run_symbol)

    resp = client.get("/weekly-advisor/recommendations", params={"symbols": "SLOW,FAST1,FAST2"})

    assert resp.status_code == 200
    assert [r["symbol"] for r in resp.json()["recommendations"]] == ["SLOW", "FAST1", "FAST2"]


def test_days_to_expiry_at_entry_derives_from_recommendation_payload():
    class _FakeRow:
        payload = {"strategy": {"entry_window": {"latest": (date.today() + timedelta(days=10)).isoformat()}}}

    assert route._days_to_expiry_at_entry(_FakeRow()) == 10


def test_days_to_expiry_at_entry_returns_none_on_malformed_payload():
    class _FakeRow:
        payload = {"strategy": {}}

    assert route._days_to_expiry_at_entry(_FakeRow()) is None


def test_default_legs_prefills_from_recommendation_strategy_legs():
    class _FakeRow:
        payload = {"strategy": {"legs": [
            {"option_type": "PE", "strike": 6800.0, "side": "sell", "basis": "support"},
            {"option_type": "PE", "strike": 6500.0, "side": "buy", "basis": "protective wing"},
        ]}}

    legs = route._default_legs(_FakeRow(), quantity=125)

    assert legs == [
        route.TradeLeg(option_type="PE", strike=6800.0, side="sell", quantity=125),
        route.TradeLeg(option_type="PE", strike=6500.0, side="buy", quantity=125),
    ]
    # entry_price is deliberately left unset - not known until the leg
    # actually fills, whether that's the same session or days later.
    assert all(leg.entry_price is None for leg in legs)


def test_default_legs_returns_none_when_recommendation_has_no_legs():
    class _FakeRow:
        payload = {"strategy": {"legs": []}}

    assert route._default_legs(_FakeRow(), quantity=1) is None


def test_default_target_pct_converts_engine_fraction_to_a_percentage():
    class _FakeRow:
        payload = {"strategy": {"exit_rule": {"target_pct_of_max_profit": 0.65}}}

    assert route._default_target_pct(_FakeRow()) == 65.0


def test_default_target_pct_returns_none_on_malformed_payload():
    class _FakeRow:
        payload = {"strategy": {}}

    assert route._default_target_pct(_FakeRow()) is None
