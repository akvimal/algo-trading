"""Route-level tests for _backtest_one_symbol/_backtest_one_symbol_option
(app/api/routes/strategies.py) - Phase 4c's instrument_type='option'
branch. Same "plain fakes over a real Session" convention as
test_backtest_universe_route.py; unlike that file, a real (fake) db.get
IS exercised here since crossover-rule option strategies still need their
referenced Indicator resolved."""

from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from typing import Optional

import pytest
from fastapi import HTTPException

import app.api.routes.strategies as strategies_route
from app.adapters.db import models as db_models
from app.adapters.market_data.client import ResolvedUnderlying
from app.domain.models import CrossoverRuleConfig, RangeBreakoutRuleConfig
from app.domain.option_backtest import MAX_OPTION_BACKTEST_DAYS
from app.domain.rules import CandleClose

INDICATOR_ID = "11111111-1111-1111-1111-111111111111"
RULE = CrossoverRuleConfig(indicator_id=INDICATOR_ID)
RSI_PARAMS = {"period": 2, "sma_period": 2}
BASE = datetime(2026, 8, 12, 9, 15)

# Same fixture as test_backtest.py's hand-traced bearish-crossover case:
# 5 quiet bars, then a fresh bearish crossover on the 6th (entry price 15).
_ENTRY_CLOSES = [10, 11, 10, 13, 20, 15]


@dataclass
class FakeStrategy:
    id: str = "strategy-1"
    instrument_type: str = "option"
    horizon: str = "intraday"
    segment: str = "NSE"
    underlying: str = "NIFTY"
    interval: str = "5min"
    regime_filter_enabled: bool = False
    regime_filter_checks: list = field(default_factory=list)
    stop_loss_method: Optional[str] = None
    stop_loss_interval: Optional[str] = None
    stop_loss_percent: Optional[float] = None
    target_percent: Optional[float] = None
    trailing_stop_enabled: bool = False
    option_position_style: str = "spread"
    option_strike_moneyness: str = "ATM"
    square_off_time: Optional[time] = None


@dataclass
class FakeIndicator:
    type: str = "rsi"
    params: dict = field(default_factory=lambda: dict(RSI_PARAMS))


class FakeDb:
    def get(self, model, id_):
        assert model is db_models.Indicator
        return FakeIndicator()


def _ts(minute_offset: int) -> str:
    return (BASE + timedelta(minutes=minute_offset)).isoformat()


def _bar(minute_offset: int, close: float) -> CandleClose:
    return CandleClose(timestamp=_ts(minute_offset), close=close, high=close, low=close)


_UNDERLYING_CANDLES = [_bar(i, c) for i, c in enumerate(_ENTRY_CLOSES)]


def _flat_leg(closes: list[float]) -> list[CandleClose]:
    return [_bar(i, c) for i, c in enumerate(closes)]


def _patch_common(monkeypatch, leg_series: dict[tuple[str, str], list[CandleClose]]):
    monkeypatch.setattr(
        strategies_route, "resolve_underlying", lambda segment, symbol: ResolvedUnderlying(symbol, "NSE", symbol, "NSE", 1)
    )
    monkeypatch.setattr(
        strategies_route, "get_candle_history", lambda exchange, symbol, interval, from_date, to_date: list(_UNDERLYING_CANDLES)
    )
    monkeypatch.setattr(
        strategies_route,
        "get_option_leg_history",
        lambda exchange, symbol, option_type, strike, expiry_flag, expiry_code, interval, from_date, to_date: leg_series.get(
            (option_type, strike)
        ),
    )


def test_backtest_one_symbol_option_produces_combined_premium_trades(monkeypatch):
    # bearish crossover -> bear put spread (PE legs), see legs_for_direction.
    leg_series = {
        ("PE", "ATM"): _flat_leg([30, 30, 30, 30, 30, 30]),
        ("PE", "ATM-2"): _flat_leg([10, 10, 10, 10, 10, 10]),
    }
    _patch_common(monkeypatch, leg_series)

    result = strategies_route._backtest_one_symbol(FakeDb(), FakeStrategy(), RULE, "NIFTY", BASE.date(), BASE.date())

    assert result["trade_count"] == 1
    trade = result["trades"][0]
    assert trade["direction"] == "bearish"
    assert trade["entry_price"] == 20  # 30 - 10
    assert trade["legs"]["option_type"] == "PE"
    assert trade["legs"]["long_strike"] == "ATM"
    assert trade["legs"]["short_strike"] == "ATM-2"
    assert trade["legs"]["expiry_flag"] == "WEEK"  # horizon='intraday' -> nearest expiry


def test_backtest_one_symbol_option_positional_horizon_uses_month_expiry(monkeypatch):
    leg_series = {
        ("PE", "ATM"): _flat_leg([30, 30, 30, 30, 30, 30]),
        ("PE", "ATM-2"): _flat_leg([10, 10, 10, 10, 10, 10]),
    }
    _patch_common(monkeypatch, leg_series)

    result = strategies_route._backtest_one_symbol(
        FakeDb(), FakeStrategy(horizon="positional"), RULE, "NIFTY", BASE.date(), BASE.date()
    )

    assert result["trades"][0]["legs"]["expiry_flag"] == "MONTH"


def test_backtest_one_symbol_option_rejects_non_crossover_rule(monkeypatch):
    _patch_common(monkeypatch, {})

    with pytest.raises(HTTPException) as exc_info:
        strategies_route._backtest_one_symbol(
            FakeDb(), FakeStrategy(), RangeBreakoutRuleConfig(breakout_period=4), "NIFTY", BASE.date(), BASE.date()
        )
    assert exc_info.value.status_code == 422
    assert "crossover" in exc_info.value.detail


def test_backtest_one_symbol_option_rejects_range_over_max_days(monkeypatch):
    _patch_common(monkeypatch, {})

    too_wide_to = BASE.date() + timedelta(days=MAX_OPTION_BACKTEST_DAYS + 1)
    with pytest.raises(HTTPException) as exc_info:
        strategies_route._backtest_one_symbol(FakeDb(), FakeStrategy(), RULE, "NIFTY", BASE.date(), too_wide_to)
    assert exc_info.value.status_code == 422
    assert "too wide" in exc_info.value.detail


def test_backtest_one_symbol_option_rejects_naked_style(monkeypatch):
    # option_backtest.py's legs_for_direction is hardcoded to a long+short
    # pair - backtesting a naked strategy would silently report wrong
    # numbers, so this is an explicit 422, not a fallthrough to the spread
    # simulation.
    _patch_common(monkeypatch, {})

    with pytest.raises(HTTPException) as exc_info:
        strategies_route._backtest_one_symbol(
            FakeDb(), FakeStrategy(option_position_style="naked"), RULE, "NIFTY", BASE.date(), BASE.date()
        )
    assert exc_info.value.status_code == 422
    assert "naked" in exc_info.value.detail


def test_backtest_one_symbol_option_rejects_non_atm_moneyness(monkeypatch):
    # Same reasoning as the naked guard - legs_for_direction is also
    # hardcoded to ATM, so a non-ATM primary-leg strategy would silently
    # backtest against the wrong strike, not just the wrong leg count.
    _patch_common(monkeypatch, {})

    with pytest.raises(HTTPException) as exc_info:
        strategies_route._backtest_one_symbol(
            FakeDb(), FakeStrategy(option_strike_moneyness="OTM1"), RULE, "NIFTY", BASE.date(), BASE.date()
        )
    assert exc_info.value.status_code == 422
    assert "option_strike_moneyness" in exc_info.value.detail


def test_backtest_one_symbol_option_skips_trade_when_legs_unresolvable(monkeypatch):
    _patch_common(monkeypatch, {})  # leg_series empty -> get_option_leg_history always returns None

    result = strategies_route._backtest_one_symbol(FakeDb(), FakeStrategy(), RULE, "NIFTY", BASE.date(), BASE.date())

    assert result["trade_count"] == 0
    assert result["trades"] == []
