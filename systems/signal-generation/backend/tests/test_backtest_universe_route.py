"""Route-level tests for _backtest_universe/_backtest_one_symbol
(app/api/routes/strategies.py) - the pooled backtest for a
universe-scoped strategy. Uses RangeBreakoutRuleConfig (no Indicator
lookup, so db is never touched) so these can run without a real DB
session, same "plain fakes over a real Session" preference the rest of
this test suite already uses (see tests/test_engine.py's FakeStrategy)."""

from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from typing import Optional

import pytest
from fastapi import HTTPException

import app.api.routes.strategies as strategies_route
from app.adapters.market_data.client import ResolvedUnderlying
from app.domain.models import RangeBreakoutRuleConfig
from app.domain.rules import CandleClose

BASE = datetime(2026, 8, 12, 9, 15)
RULE = RangeBreakoutRuleConfig(breakout_period=4)


@dataclass
class FakeStrategy:
    id: str = "strategy-1"
    segment: str = "NSE"
    underlying: str = "NIFTYBANK"
    interval: str = "5min"
    regime_filter_enabled: bool = False
    regime_filter_checks: list = field(default_factory=lambda: ["structure", "efficiency_ratio", "adx", "dmi_direction", "ema_slope"])
    stop_loss_method: Optional[str] = None
    stop_loss_interval: Optional[str] = None
    stop_loss_percent: Optional[float] = None
    target_percent: Optional[float] = None
    trailing_stop_enabled: bool = False
    square_off_time: Optional[time] = None


def _bar(minute_offset: int, close: float) -> CandleClose:
    ts = (BASE + timedelta(minutes=minute_offset)).isoformat()
    return CandleClose(timestamp=ts, close=close, high=close, low=close)


_BREAKOUT_CANDLES = [_bar(i, c) for i, c in enumerate([10, 10, 10, 10, 15])]  # one clean bullish entry


def test_backtest_universe_pools_trade_count_and_pnl_across_constituents(monkeypatch):
    monkeypatch.setattr(
        strategies_route, "get_universe_constituents", lambda key: ["HDFCBANK", "ICICIBANK"]
    )
    monkeypatch.setattr(
        strategies_route,
        "resolve_underlying",
        lambda segment, symbol: ResolvedUnderlying(symbol, "NSE", symbol, "NSE", 1),
    )
    monkeypatch.setattr(
        strategies_route, "get_candle_history", lambda exchange, symbol, interval, from_date, to_date: list(_BREAKOUT_CANDLES)
    )

    result = strategies_route._backtest_universe(None, FakeStrategy(), RULE, BASE.date(), BASE.date())

    assert result["pooled"] is True
    assert result["constituents_tested"] == 2
    assert result["constituents_skipped"] == 0
    assert result["trade_count"] == 2  # one entry per constituent
    assert set(result["by_symbol"]) == {"HDFCBANK", "ICICIBANK"}
    assert result["hypothetical_pnl"] == sum(r["hypothetical_pnl"] for r in result["by_symbol"].values())


def test_backtest_universe_skips_unresolvable_constituent_without_failing(monkeypatch):
    monkeypatch.setattr(strategies_route, "get_universe_constituents", lambda key: ["HDFCBANK", "DELISTED"])
    monkeypatch.setattr(
        strategies_route,
        "resolve_underlying",
        lambda segment, symbol: None if symbol == "DELISTED" else ResolvedUnderlying(symbol, "NSE", symbol, "NSE", 1),
    )
    monkeypatch.setattr(
        strategies_route, "get_candle_history", lambda exchange, symbol, interval, from_date, to_date: list(_BREAKOUT_CANDLES)
    )

    result = strategies_route._backtest_universe(None, FakeStrategy(), RULE, BASE.date(), BASE.date())

    assert result["constituents_tested"] == 1
    assert result["constituents_skipped"] == 1
    assert set(result["by_symbol"]) == {"HDFCBANK"}


def test_backtest_universe_raises_502_when_universe_itself_unresolvable(monkeypatch):
    monkeypatch.setattr(strategies_route, "get_universe_constituents", lambda key: None)

    with pytest.raises(HTTPException) as exc_info:
        strategies_route._backtest_universe(None, FakeStrategy(), RULE, BASE.date(), BASE.date())
    assert exc_info.value.status_code == 502
