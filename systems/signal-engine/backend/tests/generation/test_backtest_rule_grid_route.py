"""Route-level tests for backtest_rule_grid (app/api/routes/rules.py) -
specifically the stop_loss_indicator_param_grid second sweep dimension
added alongside the fix for grid search 422ing on stop_loss_method=
'indicator' at all. Same "plain fakes over a real Session" convention as
test_backtest_option_route.py."""

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

import pytest
from fastapi import HTTPException

import app.api.routes.rules as rules_route
from app.adapters.db import models as db_models
from app.adapters.market_data.client import ResolvedUnderlying
from app.domain.generation.rule import CrossoverRuleConfig, RuleBacktestGridRequest
from app.domain.generation.rules import CandleClose

INDICATOR_ID = "11111111-1111-1111-1111-111111111111"
RULE_ID = "22222222-2222-2222-2222-222222222222"
BASE = datetime(2026, 8, 12, 9, 15)

# Same hand-traced fixture as test_backtest.py's own grid_search sweep
# test: sl closes strictly before entry give period=2 EMA=17.7778,
# period=4 EMA=17.5 - distinct from each other but both genuinely above
# the bearish entry (15), a valid protective stop for either (see
# _indicator_stop_price's wrong-side-of-entry guard).
_ENTRY_CLOSES = [10, 11, 10, 13, 20, 15]


@dataclass
class FakeRule:
    id: str = RULE_ID
    segment: str = "NSE"
    underlying: str = "NIFTY"
    underlying_type: str = "symbol"
    interval: str = "5min"
    rule_config: dict = field(default_factory=lambda: {"type": "crossover", "indicator_id": INDICATOR_ID})
    regime_indicator_ids: list = field(default_factory=list)


@dataclass
class FakeIndicator:
    type: str = "rsi"
    params: dict = field(default_factory=lambda: {"period": 2, "sma_period": 2})


class FakeDb:
    def get(self, model, id_):
        if model is db_models.Rule:
            return FakeRule()
        assert model is db_models.Indicator
        return FakeIndicator()


def _ts(minute_offset: int) -> str:
    return (BASE + timedelta(minutes=minute_offset)).isoformat()


def _bar(minute_offset: int, close: float, high: float | None = None, low: float | None = None) -> CandleClose:
    return CandleClose(timestamp=_ts(minute_offset), close=close, high=high if high is not None else close, low=low if low is not None else close)


_UNDERLYING_CANDLES = [_bar(i, c) for i, c in enumerate(_ENTRY_CLOSES)] + [_bar(6, 17.9, high=18.0, low=17.0)]
_SL_CANDLES = [_bar(1, 20.0), _bar(2, 20.0), _bar(3, 10.0), _bar(4, 20.0)]


def _patch_common(monkeypatch):
    monkeypatch.setattr(
        rules_route, "resolve_underlying", lambda segment, symbol: ResolvedUnderlying(symbol, "NSE", symbol, "NSE", 1)
    )

    def fake_get_candle_history(exchange, symbol, interval, from_date, to_date):
        # Same fetch fn backs both the main underlying series and the
        # widened stop-loss series - real market-data would too (both go
        # through GET /candles/history), differentiated only by the
        # interval/date-range args, which this fake ignores.
        return list(_UNDERLYING_CANDLES) if interval == "5min" and (to_date - from_date).days < 30 else list(_SL_CANDLES)

    monkeypatch.setattr(rules_route, "get_candle_history", fake_get_candle_history)


def test_grid_route_sweeps_stop_loss_indicator_params(monkeypatch):
    _patch_common(monkeypatch)
    payload = RuleBacktestGridRequest(
        param_grid={"period": [2]},
        stop_loss_method="indicator",
        stop_loss_interval="5min",
        stop_loss_indicator_type="ema",
        stop_loss_indicator_param_grid={"period": [2, 4]},
    )

    result = rules_route.backtest_rule_grid(rule_id=RULE_ID, payload=payload, from_=date(2026, 8, 12), to=date(2026, 8, 12), db=FakeDb())

    assert result["combinations_tested"] == 2
    by_period = {row["stop_loss_indicator_params"]["period"]: row for row in result["results"]}
    assert set(by_period) == {2, 4}
    assert by_period[2]["hypothetical_pnl"] != by_period[4]["hypothetical_pnl"]


def test_grid_route_rejects_combined_total_over_max(monkeypatch):
    _patch_common(monkeypatch)
    payload = RuleBacktestGridRequest(
        param_grid={"period": list(range(2, 22))},  # 20 indicator combos
        stop_loss_method="indicator",
        stop_loss_interval="5min",
        stop_loss_indicator_type="ema",
        stop_loss_indicator_param_grid={"period": list(range(1, 8))},  # 7 SL combos -> 140 total
    )

    with pytest.raises(HTTPException) as exc_info:
        rules_route.backtest_rule_grid(rule_id=RULE_ID, payload=payload, from_=date(2026, 8, 12), to=date(2026, 8, 12), db=FakeDb())
    assert exc_info.value.status_code == 422
    assert "indicator x stop-loss" in exc_info.value.detail


def test_grid_route_without_sl_param_grid_keeps_old_shape(monkeypatch):
    _patch_common(monkeypatch)
    payload = RuleBacktestGridRequest(param_grid={"period": [2, 3]})

    result = rules_route.backtest_rule_grid(rule_id=RULE_ID, payload=payload, from_=date(2026, 8, 12), to=date(2026, 8, 12), db=FakeDb())

    assert result["combinations_tested"] == 2
    assert all("stop_loss_indicator_params" not in row for row in result["results"])
