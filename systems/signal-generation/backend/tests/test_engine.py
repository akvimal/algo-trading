from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone
from uuid import uuid4

from app.adapters.db import models as db_models
from app.domain import engine as engine_module
from app.domain.engine import (
    _is_within_active_window,
    _matches_contract_day_filter,
    _regime_confirmed,
    _regime_warmup_bars,
    _target_symbols,
    history_window,
)


def test_history_window_ends_today_and_covers_at_least_min_days():
    from_date, to_date = history_window(bar_count=10, interval="5min")

    assert to_date == datetime.now(timezone.utc).date()
    assert (to_date - from_date).days >= 3


def test_history_window_caps_at_max_days_for_large_bar_counts():
    from_date, to_date = history_window(bar_count=100000, interval="1min")
    assert (to_date - from_date).days <= 30


# --- _target_symbols: expanding a Rule into what the engine actually checks -------------


@dataclass
class FakeRule:
    """Stands in for db_models.Rule - _target_symbols only reads
    .id/.underlying/.underlying_type."""

    underlying: str
    underlying_type: str = "symbol"
    id: str = ""

    def __post_init__(self):
        if not self.id:
            self.id = str(uuid4())


def test_target_symbols_symbol_scoped_returns_just_its_own_underlying():
    rule_row = FakeRule(underlying="RELIANCE", underlying_type="symbol")
    result = _target_symbols(rule_row, get_universe_constituents=lambda key: ["SHOULD", "NOT", "BE", "CALLED"])
    assert result == ["RELIANCE"]


def test_target_symbols_universe_scoped_returns_constituents():
    rule_row = FakeRule(underlying="NIFTYBANK", underlying_type="universe")
    result = _target_symbols(rule_row, get_universe_constituents=lambda key: ["HDFCBANK", "ICICIBANK"] if key == "NIFTYBANK" else None)
    assert result == ["HDFCBANK", "ICICIBANK"]


def test_target_symbols_unresolvable_universe_returns_empty_list():
    rule_row = FakeRule(underlying="NOT_A_REAL_INDEX", underlying_type="universe")
    result = _target_symbols(rule_row, get_universe_constituents=lambda key: None)
    assert result == []


def test_target_symbols_empty_universe_constituents_returns_empty_list():
    rule_row = FakeRule(underlying="NIFTYBANK", underlying_type="universe")
    result = _target_symbols(rule_row, get_universe_constituents=lambda key: [])
    assert result == []


def test_target_symbols_symbol_list_scoped_returns_parsed_list_without_calling_market_data():
    rule_row = FakeRule(underlying="GOLDM,SILVER,CRUDEOIL", underlying_type="symbol_list")
    result = _target_symbols(rule_row, get_universe_constituents=lambda key: (_ for _ in ()).throw(AssertionError("should not call market-data")))
    assert result == ["GOLDM", "SILVER", "CRUDEOIL"]


def test_target_symbols_symbol_list_strips_whitespace_and_drops_empty_entries():
    rule_row = FakeRule(underlying=" GOLDM , SILVER,,CRUDEOIL ", underlying_type="symbol_list")
    result = _target_symbols(rule_row, get_universe_constituents=lambda key: None)
    assert result == ["GOLDM", "SILVER", "CRUDEOIL"]


# --- _is_within_active_window: run_live_tick's skip-outside-window optimization --------------


def test_is_within_active_window_no_window_always_true():
    assert _is_within_active_window(time(3, 0), None, None) is True


def test_is_within_active_window_inside_window_true():
    assert _is_within_active_window(time(10, 0), time(9, 15), time(11, 0)) is True


def test_is_within_active_window_before_window_false():
    assert _is_within_active_window(time(9, 0), time(9, 15), time(11, 0)) is False


def test_is_within_active_window_after_window_false():
    assert _is_within_active_window(time(11, 30), time(9, 15), time(11, 0)) is False


def test_is_within_active_window_on_boundaries_true():
    assert _is_within_active_window(time(9, 15), time(9, 15), time(11, 0)) is True
    assert _is_within_active_window(time(11, 0), time(9, 15), time(11, 0)) is True


# --- _matches_contract_day_filter: futures-side enforcement of Strategy.contract_day_filter --


def test_matches_contract_day_filter_any_always_true_regardless_of_expiry():
    assert _matches_contract_day_filter("future", "MCX", "any", None, date(2026, 9, 4)) is True
    assert _matches_contract_day_filter("future", "MCX", "any", "2026-09-04", date(2026, 1, 1)) is True


def test_matches_contract_day_filter_expiry_true_when_today_is_expiry():
    assert _matches_contract_day_filter("future", "MCX", "expiry", "2026-09-04", date(2026, 9, 4)) is True


def test_matches_contract_day_filter_expiry_false_when_today_is_not_expiry():
    assert _matches_contract_day_filter("future", "MCX", "expiry", "2026-09-04", date(2026, 9, 3)) is False


def test_matches_contract_day_filter_expiry_false_when_expiry_unknown():
    assert _matches_contract_day_filter("future", "MCX", "expiry", None, date(2026, 9, 4)) is False


def test_matches_contract_day_filter_only_applies_to_futures():
    # instrument_type='spot' has no expiry concept - never restricted.
    assert _matches_contract_day_filter("spot", "NSE", "expiry", "2026-09-04", date(2026, 9, 3)) is True


def test_matches_contract_day_filter_crypto_always_true_regardless_of_expiry():
    assert _matches_contract_day_filter("future", "CRYPTO", "expiry", "2026-09-04", date(2026, 9, 3)) is True


# --- _regime_confirmed / _regime_warmup_bars: Rule.regime_indicator_ids gate, shared by all --
# 3 _run_one* live-tick paths (crossover, breakout, range_breakout) - breakout gains regime
# filtering for the first time via this same helper (it never had any before this refactor).


@dataclass
class FakeIndicator:
    id: str
    type: str
    params: dict = field(default_factory=dict)


@dataclass
class FakeRegimeRule:
    """Stands in for db_models.Rule - _regime_confirmed/_regime_warmup_bars
    only read .id/.regime_indicator_ids. Named distinctly from this file's
    other FakeRule (above) so the two fixtures don't collide."""

    regime_indicator_ids: list
    id: str = "rule-1"


class FakeDb:
    """`.get(db_models.Indicator, uuid.UUID(id))` keyed by string id -
    mirrors test_backtest_option_route.py's own FakeDb convention."""

    def __init__(self, indicators_by_id: dict):
        self._indicators_by_id = indicators_by_id

    def get(self, model, id_):
        assert model is db_models.Indicator
        return self._indicators_by_id.get(str(id_))


_ADX_ID = "11111111-1111-1111-1111-111111111111"
_EMA_SLOPE_ID = "22222222-2222-2222-2222-222222222222"
_MISSING_ID = "33333333-3333-3333-3333-333333333333"


def test_regime_confirmed_trivially_true_when_no_regime_indicators():
    rule_row = FakeRegimeRule(regime_indicator_ids=[])

    class _ExplodingDb:
        def get(self, model, id_):
            raise AssertionError("no indicator lookup should happen with an empty regime_indicator_ids")

    assert _regime_confirmed(_ExplodingDb(), rule_row, "bullish", []) is True


def test_regime_confirmed_true_when_every_listed_indicator_agrees(monkeypatch):
    monkeypatch.setattr(engine_module, "evaluate_regime_indicator", lambda t, p, c, b: True)
    db = FakeDb({_ADX_ID: FakeIndicator(id=_ADX_ID, type="adx", params={"period": 14, "trend_threshold": 20.0})})
    rule_row = FakeRegimeRule(regime_indicator_ids=[_ADX_ID])
    assert _regime_confirmed(db, rule_row, "bullish", []) is True


def test_regime_confirmed_false_when_any_listed_indicator_disagrees(monkeypatch):
    def _fake(indicator_type, params, candles, bias):
        return indicator_type != "ema_slope"  # adx agrees, ema_slope doesn't

    monkeypatch.setattr(engine_module, "evaluate_regime_indicator", _fake)
    db = FakeDb(
        {
            _ADX_ID: FakeIndicator(id=_ADX_ID, type="adx", params={"period": 14, "trend_threshold": 20.0}),
            _EMA_SLOPE_ID: FakeIndicator(
                id=_EMA_SLOPE_ID,
                type="ema_slope",
                params={"ema_period": 20, "slope_lookback": 5, "slope_threshold": 0.15, "atr_period": 14},
            ),
        }
    )
    rule_row = FakeRegimeRule(regime_indicator_ids=[_ADX_ID, _EMA_SLOPE_ID])
    assert _regime_confirmed(db, rule_row, "bullish", []) is False


def test_regime_confirmed_false_when_referenced_indicator_no_longer_exists():
    db = FakeDb({})  # _MISSING_ID resolves to None
    rule_row = FakeRegimeRule(regime_indicator_ids=[_MISSING_ID])
    assert _regime_confirmed(db, rule_row, "bullish", []) is False


def test_regime_warmup_bars_is_zero_for_no_regime_indicators():
    db = FakeDb({})
    rule_row = FakeRegimeRule(regime_indicator_ids=[])
    assert _regime_warmup_bars(db, rule_row) == 0


def test_regime_warmup_bars_is_the_widest_across_listed_indicators():
    # adx(period=14) -> 14*3=42, structure(swing_lookback=3) -> 3*8=24 -
    # the wider of the two wins, real regime_indicator_warmup math (not
    # mocked) - see test_indicators.py for that math's own coverage.
    db = FakeDb(
        {
            _ADX_ID: FakeIndicator(id=_ADX_ID, type="adx", params={"period": 14, "trend_threshold": 20.0}),
            _EMA_SLOPE_ID: FakeIndicator(id=_EMA_SLOPE_ID, type="structure", params={"swing_lookback": 3}),
        }
    )
    rule_row = FakeRegimeRule(regime_indicator_ids=[_ADX_ID, _EMA_SLOPE_ID])
    assert _regime_warmup_bars(db, rule_row) == 42


def test_regime_warmup_bars_skips_a_missing_indicator():
    db = FakeDb({_ADX_ID: FakeIndicator(id=_ADX_ID, type="adx", params={"period": 14, "trend_threshold": 20.0})})
    rule_row = FakeRegimeRule(regime_indicator_ids=[_ADX_ID, _MISSING_ID])
    assert _regime_warmup_bars(db, rule_row) == 42
