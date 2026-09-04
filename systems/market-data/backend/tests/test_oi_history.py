"""Tests for the shared OiHistoryTracker (app/domain/oi_history.py) - the
rolling OI / premium / spot series backing GET /options/oi-summary's
5m/15m change figures. DhanProvider grew this logic inline first and keeps
its own copy (with its own tests in test_dhan_option_history.py);
DeltaProvider delegates to this one - see test_delta_provider.py for the
CRYPTO wiring tests."""

import time

from app.domain.models import OptionChain, OptionChainStrike, OptionGreeks, OptionLegQuote
from app.domain.oi_history import OiHistoryTracker


def _leg(oi: int, last_price: float) -> OptionLegQuote:
    return OptionLegQuote(
        security_id="1",
        last_price=last_price,
        oi=oi,
        previous_oi=None,
        volume=0.0,
        implied_volatility=0.2,
        top_bid_price=0.0,
        top_ask_price=0.0,
        greeks=OptionGreeks(delta=0.0, theta=0.0, gamma=0.0, vega=0.0, rho=None),
        moneyness="ATM",
    )


def _chain(ce_oi: int, ce_price: float, pe_oi: int, pe_price: float) -> OptionChain:
    return OptionChain(
        underlying_symbol="BTCUSD",
        underlying_exchange="CRYPTO",
        expiry="2026-09-15",
        underlying_last_price=60000.0,
        strikes=[OptionChainStrike(strike=60000.0, ce=_leg(ce_oi, ce_price), pe=_leg(pe_oi, pe_price))],
    )


def test_changes_none_until_a_sample_is_old_enough():
    t = OiHistoryTracker()
    t.record_chain("BTCUSD", "2026-09-15", _chain(1000, 50.0, 900, 40.0))
    assert t.oi_changes("BTCUSD", "2026-09-15", 60000.0, "CE", 1200) == (None, None)
    assert t.price_changes("BTCUSD", "2026-09-15", 60000.0, "CE", 55.0) == (None, None)
    assert t.spot_price_changes("BTCUSD", 60500.0) == (None, None)


def test_oi_and_price_changes_diff_against_closest_sample_at_or_before_target(monkeypatch):
    t = OiHistoryTracker()
    now = time.time()
    key = ("BTCUSD", "2026-09-15", 60000.0, "CE")
    t._oi[key] = [(now - 20 * 60, 700), (now - 14 * 60, 750), (now - 6 * 60, 770), (now - 4 * 60, 780)]
    t._price[key] = [(now - 20 * 60, 30.0), (now - 6 * 60, 42.0)]
    monkeypatch.setattr(time, "time", lambda: now)

    assert t.oi_changes("BTCUSD", "2026-09-15", 60000.0, "CE", 800) == (800 - 770, 800 - 700)
    price_5m, price_15m = t.price_changes("BTCUSD", "2026-09-15", 60000.0, "CE", 50.0)
    assert price_5m == 50.0 - 42.0
    assert price_15m == 50.0 - 30.0


def test_spot_history_keyed_by_symbol_alone(monkeypatch):
    t = OiHistoryTracker()
    now = time.time()
    t._spot["BTCUSD"] = [(now - 20 * 60, 59000.0), (now - 6 * 60, 59500.0)]
    monkeypatch.setattr(time, "time", lambda: now)

    change_5m, change_15m = t.spot_price_changes("BTCUSD", 60000.0)
    assert change_5m == 60000.0 - 59500.0
    assert change_15m == 60000.0 - 59000.0


def test_changes_scoped_to_symbol_expiry_strike_and_option_type(monkeypatch):
    t = OiHistoryTracker()
    now = time.time()
    t._oi[("BTCUSD", "2026-09-15", 60000.0, "CE")] = [(now - 20 * 60, 700)]
    t._oi[("BTCUSD", "2026-09-15", 60000.0, "PE")] = [(now - 20 * 60, 111)]
    t._oi[("BTCUSD", "2026-09-15", 60500.0, "CE")] = [(now - 20 * 60, 222)]
    t._oi[("ETHUSD", "2026-09-15", 60000.0, "CE")] = [(now - 20 * 60, 333)]
    monkeypatch.setattr(time, "time", lambda: now)

    assert t.oi_changes("BTCUSD", "2026-09-15", 60000.0, "CE", 900) == (200, 200)


def test_samples_pruned_to_retention_window(monkeypatch):
    t = OiHistoryTracker()
    base = time.time()
    monkeypatch.setattr(time, "time", lambda: base)
    t.record_chain("BTCUSD", "2026-09-15", _chain(1000, 50.0, 900, 40.0))
    # Jump forward past RETENTION_SECONDS and record again - the first
    # sample must be pruned on the second append, not linger forever.
    monkeypatch.setattr(time, "time", lambda: base + 25 * 60)
    t.record_chain("BTCUSD", "2026-09-15", _chain(1100, 55.0, 950, 45.0))
    assert len(t._oi[("BTCUSD", "2026-09-15", 60000.0, "CE")]) == 1
