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
    def fake_run_symbol(symbol, as_of=None, openrouter_api_key=None):
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

    def fake_run_symbol(symbol, as_of=None, openrouter_api_key=None):
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

    def fake_run_symbol(symbol, as_of=None, openrouter_api_key=None):
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


# --- POST /weekly-advisor/margin: real Dhan combo margin, mocked at the market_data_client boundary ---


def test_check_margin_maps_legs_and_returns_the_raw_dhan_response(monkeypatch):
    captured = {}

    def fake_get_combo_margin(legs, exchange="NSE"):
        captured["legs"] = legs
        captured["exchange"] = exchange
        return {"totalMargin": 40759.5, "spanMargin": 14830.0}

    monkeypatch.setattr(route.market_data_client, "get_combo_margin", fake_get_combo_margin)

    resp = client.post(
        "/weekly-advisor/margin",
        json={
            "legs": [
                {"security_id": "106369", "side": "sell", "price": 25.7},
                {"security_id": "144391", "side": "buy", "price": 8.2},
            ],
            "quantity": 500,
        },
    )

    assert resp.status_code == 200
    assert resp.json() == {"raw": {"totalMargin": 40759.5, "spanMargin": 14830.0}}
    # productType="MARGIN" (not "INTRADAY") - a held-to-expiry position,
    # not a same-day square-off one - see the route's own docstring.
    assert captured["legs"] == [
        {"security_id": "106369", "exchange_segment": "NSE_FNO", "transaction_type": "SELL", "quantity": 500, "product_type": "MARGIN", "price": 25.7},
        {"security_id": "144391", "exchange_segment": "NSE_FNO", "transaction_type": "BUY", "quantity": 500, "product_type": "MARGIN", "price": 8.2},
    ]


def test_check_margin_returns_502_when_market_data_call_fails(monkeypatch):
    def fake_get_combo_margin(legs, exchange="NSE"):
        raise RuntimeError("Dhan API error (400): bad quantity")

    monkeypatch.setattr(route.market_data_client, "get_combo_margin", fake_get_combo_margin)

    resp = client.post(
        "/weekly-advisor/margin",
        json={"legs": [{"security_id": "1", "side": "sell", "price": 10.0}], "quantity": 500},
    )

    assert resp.status_code == 502
    assert "bad quantity" in resp.json()["detail"]


def test_check_margin_rejects_empty_legs():
    resp = client.post("/weekly-advisor/margin", json={"legs": [], "quantity": 500})

    assert resp.status_code == 422


# --- GET /weekly-advisor/lot-size ---


def test_get_lot_size_returns_the_resolved_value(monkeypatch):
    monkeypatch.setattr(route.market_data_client, "get_lot_size_for_security_id", lambda security_id, exchange="NSE": 500)

    resp = client.get("/weekly-advisor/lot-size", params={"security_id": "106369"})

    assert resp.status_code == 200
    assert resp.json() == {"lot_size": 500}


def test_get_lot_size_404s_when_unresolvable(monkeypatch):
    monkeypatch.setattr(route.market_data_client, "get_lot_size_for_security_id", lambda security_id, exchange="NSE": None)

    resp = client.get("/weekly-advisor/lot-size", params={"security_id": "999999"})

    assert resp.status_code == 404


# --- GET/PUT /weekly-advisor/settings: openrouter_vision_model + defined_risk ---


def test_get_settings_reflects_current_config(monkeypatch):
    monkeypatch.setattr(route.settings, "openrouter_vision_model", "google/gemini-2.5-flash-lite")
    monkeypatch.setattr(route.settings, "weekly_advisor_defined_risk", True)

    resp = client.get("/weekly-advisor/settings")

    assert resp.status_code == 200
    assert resp.json() == {"openrouter_vision_model": "google/gemini-2.5-flash-lite", "defined_risk": True}


def test_put_settings_updates_both_fields(monkeypatch):
    monkeypatch.setattr(route.settings, "openrouter_vision_model", "google/gemini-2.5-flash-lite")
    monkeypatch.setattr(route.settings, "weekly_advisor_defined_risk", True)

    resp = client.put("/weekly-advisor/settings", json={"openrouter_vision_model": "some/other-model", "defined_risk": False})

    assert resp.status_code == 200
    assert resp.json() == {"openrouter_vision_model": "some/other-model", "defined_risk": False}
    assert route.settings.weekly_advisor_defined_risk is False


def test_put_settings_rejects_blank_model():
    resp = client.put("/weekly-advisor/settings", json={"openrouter_vision_model": "  ", "defined_risk": True})

    assert resp.status_code == 422


# --- GET /weekly-advisor/option-chain-strikes: real, live strikes for a pick-a-strike dropdown ---


def test_get_option_chain_strikes_returns_every_leg_sorted(monkeypatch):
    monkeypatch.setattr(
        route.market_data_client,
        "get_option_chain",
        lambda exchange, symbol, expiry: {
            "strikes": [
                {"strike": 700.0, "ce": {"oi": 1, "previous_oi": 1, "last_price": 12.5, "security_id": "1"}, "pe": {"oi": 1, "previous_oi": 1, "last_price": 1.7, "security_id": "2"}},
                {"strike": 680.0, "ce": {"oi": 1, "previous_oi": 1, "last_price": 15.0, "security_id": "3"}, "pe": {"oi": 1, "previous_oi": 1, "last_price": 0.45, "security_id": "4"}},
            ]
        },
    )

    resp = client.get("/weekly-advisor/option-chain-strikes", params={"symbol": "HDFCBANK", "expiry": "2026-09-25"})

    assert resp.status_code == 200
    body = resp.json()
    assert body == [
        {"strike": 680.0, "option_type": "CE", "last_price": 15.0, "security_id": "3"},
        {"strike": 680.0, "option_type": "PE", "last_price": 0.45, "security_id": "4"},
        {"strike": 700.0, "option_type": "CE", "last_price": 12.5, "security_id": "1"},
        {"strike": 700.0, "option_type": "PE", "last_price": 1.7, "security_id": "2"},
    ]


def test_get_option_chain_strikes_404s_on_no_chain(monkeypatch):
    monkeypatch.setattr(route.market_data_client, "get_option_chain", lambda exchange, symbol, expiry: None)

    resp = client.get("/weekly-advisor/option-chain-strikes", params={"symbol": "HDFCBANK", "expiry": "2026-09-25"})

    assert resp.status_code == 404


def test_get_option_chain_strikes_502s_on_fetch_failure(monkeypatch):
    def _raise(exchange, symbol, expiry):
        raise RuntimeError("Dhan option-chain queue is backed up")

    monkeypatch.setattr(route.market_data_client, "get_option_chain", _raise)

    resp = client.get("/weekly-advisor/option-chain-strikes", params={"symbol": "HDFCBANK", "expiry": "2026-09-25"})

    assert resp.status_code == 502
