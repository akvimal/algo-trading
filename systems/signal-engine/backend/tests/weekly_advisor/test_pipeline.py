"""Pipeline-level tests: run_symbol() wired against a fake
app.adapters.market_data.client (no real network/DB), same "plain fakes"
convention the rest of this suite uses. Covers the two behaviors this
pass explicitly promised: real strike-interval-from-chain when reachable,
graceful fallback to a price-scaled guess when it isn't."""
from datetime import date, timedelta

import pytest

from app.domain.generation.rules import CandleClose
from app.domain.weekly_advisor import pipeline


def _bars(n: int, start_close: float, step: float) -> list[CandleClose]:
    base = date(2025, 1, 6)  # a Monday
    out = []
    for i in range(n):
        close = start_close + i * step
        ts = (base + timedelta(weeks=i)).isoformat()
        out.append(CandleClose(timestamp=ts, close=close, high=close * 1.01, low=close * 0.99, open=close, volume=1_000_000.0))
    return out


def _fake_history_factory(weekly_bars, daily_bars):
    def _fake(exchange, symbol, interval, from_date, to_date, source=None):
        assert source == "yahoo"
        return weekly_bars if interval == "weekly" else daily_bars
    return _fake


def _no_order_blocks(exchange, symbol, interval, from_date, to_date, source=None):
    """Explicit None (not an unmocked real HTTP call) for tests that don't
    care about the order-block vote - see test_fetch_order_blocks.py-style
    cases below for that behavior specifically."""
    return None


def test_run_symbol_falls_back_to_guessed_strike_interval_when_chain_unavailable(monkeypatch):
    # close stays under 500 -> guess_strike_interval() gives 5.0
    weekly_bars = _bars(60, 400.0, 1.0)
    daily_bars = _bars(60, 400.0, 0.2)
    monkeypatch.setattr(pipeline.market_data_client, "get_candle_history", _fake_history_factory(weekly_bars, daily_bars))
    monkeypatch.setattr(pipeline.market_data_client, "get_expiry_list", lambda exchange, symbol: None)
    monkeypatch.setattr(pipeline.market_data_client, "get_order_blocks", _no_order_blocks)

    rec = pipeline.run_symbol("TESTSYM", as_of=date(2026, 6, 1))

    assert rec.symbol == "TESTSYM"
    assert rec.oi.available is False
    assert rec.strategy.entry_window.latest == pipeline._naive_monthly_expiry(date(2026, 6, 1))
    for leg in rec.strategy.legs:
        assert leg.strike % 5.0 == 0


def test_run_symbol_uses_real_strike_interval_from_option_chain(monkeypatch):
    # close lands well under 2000 -> guess_strike_interval() would give 20,
    # but a real chain reporting a 50-wide ladder must win instead.
    weekly_bars = _bars(60, 1800.0, 1.0)
    daily_bars = _bars(60, 1800.0, 0.2)
    monkeypatch.setattr(pipeline.market_data_client, "get_candle_history", _fake_history_factory(weekly_bars, daily_bars))
    monkeypatch.setattr(pipeline.market_data_client, "get_expiry_list", lambda exchange, symbol: ["2026-06-25"])
    monkeypatch.setattr(
        pipeline.market_data_client,
        "get_option_chain",
        lambda exchange, symbol, expiry: {"strikes": [{"strike": 1750.0}, {"strike": 1800.0}, {"strike": 1850.0}]},
    )
    monkeypatch.setattr(pipeline.market_data_client, "get_order_blocks", _no_order_blocks)

    rec = pipeline.run_symbol("TESTSYM", as_of=date(2026, 6, 1))

    for leg in rec.strategy.legs:
        assert leg.strike % 50.0 == 0
    assert rec.strategy.entry_window.latest == date(2026, 6, 25)


def test_run_symbol_raises_on_insufficient_history(monkeypatch):
    short_bars = _bars(10, 2000.0, 5.0)
    monkeypatch.setattr(
        pipeline.market_data_client, "get_candle_history",
        lambda exchange, symbol, interval, from_date, to_date, source=None: short_bars,
    )

    with pytest.raises(ValueError, match="insufficient history"):
        pipeline.run_symbol("TESTSYM", as_of=date(2026, 6, 1))


def test_fetch_order_blocks_converts_raw_dicts_to_zones(monkeypatch):
    monkeypatch.setattr(
        pipeline.market_data_client,
        "get_order_blocks",
        lambda exchange, symbol, interval, from_date, to_date, source=None: [
            {"kind": "demand", "proximal": 475.0, "distal": 460.0, "mitigated": False, "role": "orderblock", "origin_timestamp": "2026-01-01T00:00:00", "counter_trend": False},
        ],
    )

    zones = pipeline._fetch_order_blocks("TESTSYM", date(2026, 6, 1), "weekly", 3 * 365)

    assert zones == [pipeline.OrderBlockZone(kind="demand", proximal=475.0, distal=460.0, mitigated=False)]


def test_fetch_order_blocks_returns_none_on_client_exception(monkeypatch):
    def _raise(*a, **kw):
        raise RuntimeError("market-data unreachable")

    monkeypatch.setattr(pipeline.market_data_client, "get_order_blocks", _raise)

    assert pipeline._fetch_order_blocks("TESTSYM", date(2026, 6, 1), "weekly", 3 * 365) is None


def test_fetch_order_blocks_passes_through_none_from_client(monkeypatch):
    monkeypatch.setattr(pipeline.market_data_client, "get_order_blocks", _no_order_blocks)

    assert pipeline._fetch_order_blocks("TESTSYM", date(2026, 6, 1), "daily", 365) is None


def test_run_symbol_surfaces_the_order_block_vote_in_regime_reasons(monkeypatch):
    weekly_bars = _bars(60, 2000.0, -5.0)  # a downtrend, so weekly close < EMA50 (bearish EMA read)
    daily_bars = _bars(60, 2000.0, -1.0)
    monkeypatch.setattr(pipeline.market_data_client, "get_candle_history", _fake_history_factory(weekly_bars, daily_bars))
    monkeypatch.setattr(pipeline.market_data_client, "get_expiry_list", lambda exchange, symbol: None)
    close = weekly_bars[-1].close
    monkeypatch.setattr(
        pipeline.market_data_client,
        "get_order_blocks",
        lambda exchange, symbol, interval, from_date, to_date, source=None: [
            {"kind": "demand", "proximal": close * 1.02, "distal": close * 0.98, "mitigated": False},
        ],
    )

    rec = pipeline.run_symbol("TESTSYM", as_of=date(2026, 6, 1))

    assert any("demand order block" in r for r in rec.regime.reasons)
