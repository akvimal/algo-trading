"""Route-level tests for _backtest_universe/_backtest_symbol_list/
_backtest_one_symbol (app/api/routes/rules.py) - the pooled backtest for
a universe-scoped or symbol_list-scoped rule (both share
_backtest_pooled_symbols' pooling logic - see that function's own
docstring). Uses RangeBreakoutRuleConfig (no Indicator lookup, so db is
never touched) so these can run without a real DB session, same "plain
fakes over a real Session" preference the rest of this test suite already
uses (see tests/test_engine.py's FakeStrategy/FakeRule)."""

from dataclasses import dataclass
from datetime import datetime, timedelta

import pytest
import requests
from fastapi import HTTPException

import app.api.routes.rules as rules_route
from app.adapters.market_data.client import ResolvedUnderlying
from app.domain.generation.rule import RangeBreakoutRuleConfig, RuleBacktestRequest
from app.domain.generation.rules import CandleClose

BASE = datetime(2026, 8, 12, 9, 15)
RULE = RangeBreakoutRuleConfig(breakout_period=4)
PAYLOAD = RuleBacktestRequest()


@dataclass
class FakeRule:
    id: str = "rule-1"
    segment: str = "NSE"
    underlying: str = "NIFTYBANK"
    underlying_type: str = "universe"
    interval: str = "5min"


def _bar(minute_offset: int, close: float) -> CandleClose:
    ts = (BASE + timedelta(minutes=minute_offset)).isoformat()
    return CandleClose(timestamp=ts, close=close, high=close, low=close)


_BREAKOUT_CANDLES = [_bar(i, c) for i, c in enumerate([10, 10, 10, 10, 15])]  # one clean bullish entry


def test_backtest_universe_pools_trade_count_and_pnl_across_constituents(monkeypatch):
    monkeypatch.setattr(
        rules_route, "get_universe_constituents", lambda key: ["HDFCBANK", "ICICIBANK"]
    )
    monkeypatch.setattr(
        rules_route,
        "resolve_underlying",
        lambda segment, symbol: ResolvedUnderlying(symbol, "NSE", symbol, "NSE", 1),
    )
    monkeypatch.setattr(
        rules_route, "get_candle_history", lambda exchange, symbol, interval, from_date, to_date: list(_BREAKOUT_CANDLES)
    )

    result = rules_route._backtest_universe(None, FakeRule(), RULE, PAYLOAD, BASE.date(), BASE.date(), [])

    assert result["pooled"] is True
    assert result["constituents_tested"] == 2
    assert result["constituents_skipped"] == 0
    assert result["trade_count"] == 2  # one entry per constituent
    assert set(result["by_symbol"]) == {"HDFCBANK", "ICICIBANK"}
    assert result["hypothetical_pnl"] == sum(r["hypothetical_pnl"] for r in result["by_symbol"].values())


def test_backtest_universe_skips_unresolvable_constituent_without_failing(monkeypatch):
    monkeypatch.setattr(rules_route, "get_universe_constituents", lambda key: ["HDFCBANK", "DELISTED"])
    monkeypatch.setattr(
        rules_route,
        "resolve_underlying",
        lambda segment, symbol: None if symbol == "DELISTED" else ResolvedUnderlying(symbol, "NSE", symbol, "NSE", 1),
    )
    monkeypatch.setattr(
        rules_route, "get_candle_history", lambda exchange, symbol, interval, from_date, to_date: list(_BREAKOUT_CANDLES)
    )

    result = rules_route._backtest_universe(None, FakeRule(), RULE, PAYLOAD, BASE.date(), BASE.date(), [])

    assert result["constituents_tested"] == 1
    assert result["constituents_skipped"] == 1
    assert set(result["by_symbol"]) == {"HDFCBANK"}


def test_backtest_universe_skips_symbol_whose_candle_history_call_fails(monkeypatch):
    """Reproduces a real failure: market-data returns a 502 for one
    constituent (e.g. a date range Dhan rejects) - get_candle_history
    raises requests.HTTPError uncaught (unlike resolve_underlying/
    get_universe_constituents, which already return None on failure), so
    the pooled backtest must catch it itself rather than let one bad
    symbol 500 the whole request."""
    monkeypatch.setattr(rules_route, "get_universe_constituents", lambda key: ["HDFCBANK", "AUBANK"])
    monkeypatch.setattr(
        rules_route,
        "resolve_underlying",
        lambda segment, symbol: ResolvedUnderlying(symbol, "NSE", symbol, "NSE", 1),
    )

    def _fake_candle_history(exchange, symbol, interval, from_date, to_date):
        if symbol == "AUBANK":
            raise requests.HTTPError("502 Server Error: Bad Gateway")
        return list(_BREAKOUT_CANDLES)

    monkeypatch.setattr(rules_route, "get_candle_history", _fake_candle_history)

    result = rules_route._backtest_universe(None, FakeRule(), RULE, PAYLOAD, BASE.date(), BASE.date(), [])

    assert result["constituents_tested"] == 1
    assert result["constituents_skipped"] == 1
    assert set(result["by_symbol"]) == {"HDFCBANK"}


def test_backtest_universe_raises_502_when_universe_itself_unresolvable(monkeypatch):
    monkeypatch.setattr(rules_route, "get_universe_constituents", lambda key: None)

    with pytest.raises(HTTPException) as exc_info:
        rules_route._backtest_universe(None, FakeRule(), RULE, PAYLOAD, BASE.date(), BASE.date(), [])
    assert exc_info.value.status_code == 502


# --- _backtest_symbol_list: same pooling, sourced from parsing underlying, not market-data ----


@dataclass
class FakeSymbolListRule:
    id: str = "rule-2"
    segment: str = "MCX"
    underlying: str = "GOLDM,CRUDEOIL"
    underlying_type: str = "symbol_list"
    interval: str = "5min"
    rule_config: dict = None

    def __post_init__(self):
        if self.rule_config is None:
            self.rule_config = {"type": "range_breakout", "breakout_period": 4}


def test_backtest_symbol_list_pools_trade_count_and_pnl_without_calling_market_data(monkeypatch):
    monkeypatch.setattr(
        rules_route, "get_universe_constituents", lambda key: (_ for _ in ()).throw(AssertionError("should not call market-data"))
    )
    monkeypatch.setattr(
        rules_route,
        "resolve_underlying",
        lambda segment, symbol: ResolvedUnderlying(symbol, "MCX", symbol, "MCX", 1),
    )
    monkeypatch.setattr(
        rules_route, "get_candle_history", lambda exchange, symbol, interval, from_date, to_date: list(_BREAKOUT_CANDLES)
    )

    result = rules_route._backtest_symbol_list(None, FakeSymbolListRule(), RULE, PAYLOAD, BASE.date(), BASE.date(), [])

    assert result["pooled"] is True
    assert result["constituents_tested"] == 2
    assert result["constituents_skipped"] == 0
    assert result["trade_count"] == 2  # one entry per symbol
    assert set(result["by_symbol"]) == {"GOLDM", "CRUDEOIL"}


def test_backtest_symbol_list_skips_unresolvable_symbol_without_failing(monkeypatch):
    monkeypatch.setattr(
        rules_route,
        "resolve_underlying",
        lambda segment, symbol: None if symbol == "CRUDEOIL" else ResolvedUnderlying(symbol, "MCX", symbol, "MCX", 1),
    )
    monkeypatch.setattr(
        rules_route, "get_candle_history", lambda exchange, symbol, interval, from_date, to_date: list(_BREAKOUT_CANDLES)
    )

    result = rules_route._backtest_symbol_list(None, FakeSymbolListRule(), RULE, PAYLOAD, BASE.date(), BASE.date(), [])

    assert result["constituents_tested"] == 1
    assert result["constituents_skipped"] == 1
    assert set(result["by_symbol"]) == {"GOLDM"}


def test_backtest_symbol_list_raises_422_when_underlying_unparseable():
    rule_row = FakeSymbolListRule(underlying=" , ")

    with pytest.raises(HTTPException) as exc_info:
        rules_route._backtest_symbol_list(None, rule_row, RULE, PAYLOAD, BASE.date(), BASE.date(), [])
    assert exc_info.value.status_code == 422


def test_backtest_rule_dispatches_symbol_list_to_backtest_symbol_list(monkeypatch):
    """The route-level dispatch (backtest_rule) picks _backtest_symbol_list
    for underlying_type='symbol_list', not _backtest_one_symbol (which
    would otherwise treat the raw comma-separated string as a single,
    unresolvable "symbol")."""
    monkeypatch.setattr(rules_route, "_load_rule_for_backtest", lambda db, rule_id: FakeSymbolListRule())
    monkeypatch.setattr(rules_route, "_resolve_regime_indicators", lambda db, rule_row: [])
    sentinel = {"pooled": True, "called_with": None}

    def fake_backtest_symbol_list(db, rule_row, rule, payload, from_, to, regime_indicators):
        sentinel["called_with"] = rule_row.underlying
        return sentinel

    monkeypatch.setattr(rules_route, "_backtest_symbol_list", fake_backtest_symbol_list)
    monkeypatch.setattr(
        rules_route,
        "_backtest_universe",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("should not dispatch to _backtest_universe")),
    )
    monkeypatch.setattr(
        rules_route,
        "_backtest_one_symbol",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("should not dispatch to _backtest_one_symbol")),
    )

    result = rules_route.backtest_rule("rule-2", PAYLOAD, BASE.date(), BASE.date(), db=None)

    assert result is sentinel
    assert sentinel["called_with"] == "GOLDM,CRUDEOIL"


# --- exit_condition per-run override (app/api/routes/rules.py's _exit_condition_hit_for) --------

def test_backtest_one_symbol_applies_exit_condition_override(monkeypatch):
    monkeypatch.setattr(
        rules_route, "resolve_underlying", lambda segment, symbol: ResolvedUnderlying(symbol, "NSE", symbol, "NSE", 1)
    )
    candles = [_bar(i, c) for i, c in enumerate([10, 10, 10, 10, 15, 14, 12])]  # bullish entry@15, then drifts down
    monkeypatch.setattr(
        rules_route, "get_candle_history", lambda exchange, symbol, interval, from_date, to_date: list(candles)
    )
    payload = RuleBacktestRequest(
        exit_condition={
            "interval": "5min",
            "left": {"kind": "price", "field": "close"},
            "operator": "<",
            "right": {"kind": "constant", "value": 13},
        }
    )
    result = rules_route._backtest_one_symbol(
        None, FakeRule(underlying="RELIANCE", underlying_type="symbol"), RULE, payload, "RELIANCE", BASE.date(), BASE.date(), []
    )
    assert result["trade_count"] == 1
    assert result["trades"][0]["exit_reason"] == "exit_condition"
    assert result["trades"][0]["exit_price"] == 12.0  # the bar close where close < 13 first held


def test_rule_backtest_request_rejects_daily_exit_condition():
    with pytest.raises(Exception):
        RuleBacktestRequest(
            exit_condition={
                "interval": "daily",
                "left": {"kind": "rsi", "period": 14},
                "operator": ">",
                "right": {"kind": "constant", "value": 40},
            }
        )
