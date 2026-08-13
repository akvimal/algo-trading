from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from uuid import uuid4

from app.domain.engine import (
    _is_within_active_window,
    _matches_contract_day_filter,
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
