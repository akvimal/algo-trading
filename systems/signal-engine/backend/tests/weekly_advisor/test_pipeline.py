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


@pytest.fixture(autouse=True)
def _no_real_fundamentals_fetch(monkeypatch):
    """screener_fetch.get_fundamentals opens its own DB session (see that
    module) - without this, every run_symbol() test below would silently
    hit whatever Postgres app.config.settings.database_url happens to
    point at (reachable or not) instead of staying a hermetic unit test.
    Individual tests override this via monkeypatch when they care about
    the fundamental vote specifically - see test_run_symbol_surfaces_the_
    fundamental_vote_in_regime_reasons below."""
    monkeypatch.setattr(pipeline.screener_fetch, "get_fundamentals", lambda symbol, openrouter_api_key=None: None)


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


# --- _fetch_expiry_and_chain_with_retry: survives market-data's option-chain throttle backing
# up (2026-09-16 - see this function's own module-level comment for the concurrency mechanics
# that make this necessary: weekly_advisor.py's 5-wide batch concurrency vs. Dhan's 3s-per-call
# expiry-list/option-chain throttle, whose own queue-depth guard raises rather than queuing a
# caller more than ~1 slot deep.)


@pytest.fixture(autouse=True)
def _no_real_sleep_in_retry_tests(monkeypatch):
    """Keeps these tests fast regardless of _OPTION_CHAIN_RETRY_SLEEP_SECONDS's
    real value - records each call instead of actually blocking."""
    monkeypatch.setattr(pipeline.time, "sleep", lambda seconds: sleep_calls.append(seconds))


sleep_calls: list[float] = []


@pytest.fixture(autouse=True)
def _reset_sleep_calls():
    sleep_calls.clear()
    yield
    sleep_calls.clear()


def test_fetch_expiry_and_chain_with_retry_succeeds_on_first_try(monkeypatch):
    monkeypatch.setattr(pipeline.market_data_client, "get_expiry_list", lambda exchange, symbol: ["2026-06-25"])
    monkeypatch.setattr(pipeline.market_data_client, "get_option_chain", lambda exchange, symbol, expiry: {"strikes": []})

    expiry, chain = pipeline._fetch_expiry_and_chain_with_retry("TESTSYM")

    assert expiry == "2026-06-25"
    assert chain == {"strikes": []}
    assert sleep_calls == []


def test_fetch_expiry_and_chain_with_retry_returns_none_when_no_expiries(monkeypatch):
    monkeypatch.setattr(pipeline.market_data_client, "get_expiry_list", lambda exchange, symbol: [])

    expiry, chain = pipeline._fetch_expiry_and_chain_with_retry("TESTSYM")

    assert (expiry, chain) == (None, None)
    assert sleep_calls == []


def test_fetch_expiry_and_chain_with_retry_retries_past_a_backed_up_chain_call(monkeypatch):
    monkeypatch.setattr(pipeline.market_data_client, "get_expiry_list", lambda exchange, symbol: ["2026-06-25"])
    calls = {"n": 0}

    def flaky(exchange, symbol, expiry):
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("Dhan option-chain queue is backed up (6.0s wait) - try again shortly")
        return {"strikes": [{"strike": 100.0}]}

    monkeypatch.setattr(pipeline.market_data_client, "get_option_chain", flaky)

    expiry, chain = pipeline._fetch_expiry_and_chain_with_retry("TESTSYM")

    assert expiry == "2026-06-25"
    assert chain == {"strikes": [{"strike": 100.0}]}
    assert calls["n"] == 3
    assert sleep_calls == [pipeline._OPTION_CHAIN_RETRY_SLEEP_SECONDS] * 2


def test_fetch_expiry_and_chain_with_retry_retries_past_a_backed_up_expiry_list_call(monkeypatch):
    """The expiry-list call shares the SAME throttle/queue as the chain
    call (see the module-level comment) - a batch with a cold expiry-list
    cache can back up on this step just as easily as the chain step."""
    calls = {"n": 0}

    def flaky(exchange, symbol):
        calls["n"] += 1
        if calls["n"] < 2:
            raise RuntimeError("Dhan option-chain queue is backed up (6.0s wait) - try again shortly")
        return ["2026-06-25"]

    monkeypatch.setattr(pipeline.market_data_client, "get_expiry_list", flaky)
    monkeypatch.setattr(pipeline.market_data_client, "get_option_chain", lambda exchange, symbol, expiry: {"strikes": [{"strike": 100.0}]})

    expiry, chain = pipeline._fetch_expiry_and_chain_with_retry("TESTSYM")

    assert expiry == "2026-06-25"
    assert chain == {"strikes": [{"strike": 100.0}]}
    assert calls["n"] == 2
    assert sleep_calls == [pipeline._OPTION_CHAIN_RETRY_SLEEP_SECONDS]


def test_fetch_expiry_and_chain_with_retry_raises_after_exhausting_every_attempt(monkeypatch):
    monkeypatch.setattr(pipeline.market_data_client, "get_expiry_list", lambda exchange, symbol: ["2026-06-25"])

    def always_backed_up(exchange, symbol, expiry):
        raise RuntimeError("Dhan option-chain queue is backed up (9.0s wait) - try again shortly")

    monkeypatch.setattr(pipeline.market_data_client, "get_option_chain", always_backed_up)

    with pytest.raises(RuntimeError, match="backed up"):
        pipeline._fetch_expiry_and_chain_with_retry("TESTSYM")

    assert len(sleep_calls) == pipeline._OPTION_CHAIN_RETRY_ATTEMPTS - 1


def test_run_symbol_recovers_real_oi_after_the_chain_fetch_initially_backs_up(monkeypatch):
    """The end-to-end version of the retry test above - run_symbol still
    gets a real OI vote (not a silent guess) when the first attempt at the
    option-chain fetch hits a backed-up throttle, as long as a later retry
    succeeds - this is the actual bug this whole retry exists to fix."""
    weekly_bars = _bars(60, 2000.0, 1.0)
    daily_bars = _bars(60, 2000.0, 1.0)
    monkeypatch.setattr(pipeline.market_data_client, "get_candle_history", _fake_history_factory(weekly_bars, daily_bars))
    monkeypatch.setattr(pipeline.market_data_client, "get_expiry_list", lambda exchange, symbol: ["2026-06-25"])
    monkeypatch.setattr(pipeline.market_data_client, "get_order_blocks", _no_order_blocks)
    calls = {"n": 0}

    def flaky(exchange, symbol, expiry):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("Dhan option-chain queue is backed up (6.0s wait) - try again shortly")
        return {
            "strikes": [
                _chain_strike(2000.0, ce_oi=1500, ce_prev_oi=1000, pe_oi=1500, pe_prev_oi=1000),
                _chain_strike(2050.0, ce_oi=1500, ce_prev_oi=1000, pe_oi=1500, pe_prev_oi=1000),
                _chain_strike(2100.0, ce_oi=1500, ce_prev_oi=1000, pe_oi=1500, pe_prev_oi=1000),
            ]
        }

    monkeypatch.setattr(pipeline.market_data_client, "get_option_chain", flaky)

    rec = pipeline.run_symbol("TESTSYM", as_of=date(2026, 6, 1))

    assert rec.oi.available is True
    assert rec.oi.aggregate_signal == "long_buildup"
    # real chain reached, not the naive fallback expiry
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


# --- _fetch_oi: a real buildup read from the SAME chain fetch used for strike interval -------


def _chain_strike(
    strike, ce_oi=None, ce_prev_oi=None, pe_oi=None, pe_prev_oi=None,
    ce_last_price=None, pe_last_price=None, ce_security_id=None, pe_security_id=None,
):
    row = {"strike": strike}
    if ce_oi is not None:
        row["ce"] = {"oi": ce_oi, "previous_oi": ce_prev_oi}
        if ce_last_price is not None:
            row["ce"]["last_price"] = ce_last_price
        if ce_security_id is not None:
            row["ce"]["security_id"] = ce_security_id
    if pe_oi is not None:
        row["pe"] = {"oi": pe_oi, "previous_oi": pe_prev_oi}
        if pe_last_price is not None:
            row["pe"]["last_price"] = pe_last_price
        if pe_security_id is not None:
            row["pe"]["security_id"] = pe_security_id
    return row


def test_fetch_oi_unavailable_when_no_chain():
    assert pipeline._fetch_oi(None, price_change=5.0, spot=2000.0).available is False


def test_fetch_oi_unavailable_when_chain_has_no_ce_pe_legs():
    # same shape test_run_symbol_uses_real_strike_interval_from_option_chain
    # feeds get_option_chain - a chain with strikes but no CE/PE legs at all.
    chain_strikes = [{"strike": 1750.0}, {"strike": 1800.0}, {"strike": 1850.0}]

    assert pipeline._fetch_oi(chain_strikes, price_change=5.0, spot=1800.0).available is False


def test_fetch_oi_skips_a_leg_missing_previous_oi_without_raising():
    chain_strikes = [_chain_strike(2000.0, ce_oi=1000, ce_prev_oi=None)]

    assert pipeline._fetch_oi(chain_strikes, price_change=5.0, spot=2000.0).available is False


def test_fetch_oi_classifies_long_buildup_from_price_up_oi_up():
    # Price up (price_change > 0) + OI up at every near-the-money strike ->
    # long_buildup, matching oi_classifier.classify_buildup's own truth table.
    chain_strikes = [
        _chain_strike(2000.0, ce_oi=1500, ce_prev_oi=1000, pe_oi=1500, pe_prev_oi=1000),
        _chain_strike(2050.0, ce_oi=1500, ce_prev_oi=1000, pe_oi=1500, pe_prev_oi=1000),
        _chain_strike(2100.0, ce_oi=1500, ce_prev_oi=1000, pe_oi=1500, pe_prev_oi=1000),
    ]

    oi = pipeline._fetch_oi(chain_strikes, price_change=10.0, spot=2059.0)

    assert oi.available is True
    assert oi.aggregate_signal == "long_buildup"
    assert oi.pcr == pytest.approx(1.0)  # equal put/call OI in this fixture
    assert len(oi.by_strike) == 6  # 3 strikes x CE+PE
    assert all(row.buildup == "long_buildup" for row in oi.by_strike)


def test_fetch_oi_computes_max_pain_at_the_least_loss_strike():
    # Only strike 2050 has any OI at all - it's trivially the max-pain strike
    # (every other candidate strike pays out more against it).
    chain_strikes = [_chain_strike(2050.0, ce_oi=5000, ce_prev_oi=4000, pe_oi=5000, pe_prev_oi=4000)]

    oi = pipeline._fetch_oi(chain_strikes, price_change=10.0, spot=2050.0)

    assert oi.max_pain == 2050.0


def test_run_symbol_surfaces_the_oi_vote_in_regime_reasons(monkeypatch):
    weekly_bars = _bars(60, 2000.0, 1.0)  # last weekly close = 2059.0
    daily_bars = _bars(60, 2000.0, 1.0)  # last two closes: 2058.0 -> 2059.0, a positive price_change
    monkeypatch.setattr(pipeline.market_data_client, "get_candle_history", _fake_history_factory(weekly_bars, daily_bars))
    monkeypatch.setattr(pipeline.market_data_client, "get_expiry_list", lambda exchange, symbol: ["2026-06-25"])
    monkeypatch.setattr(
        pipeline.market_data_client,
        "get_option_chain",
        lambda exchange, symbol, expiry: {
            "strikes": [
                _chain_strike(2000.0, ce_oi=1500, ce_prev_oi=1000, pe_oi=1500, pe_prev_oi=1000),
                _chain_strike(2050.0, ce_oi=1500, ce_prev_oi=1000, pe_oi=1500, pe_prev_oi=1000),
                _chain_strike(2100.0, ce_oi=1500, ce_prev_oi=1000, pe_oi=1500, pe_prev_oi=1000),
            ]
        },
    )
    monkeypatch.setattr(pipeline.market_data_client, "get_order_blocks", _no_order_blocks)

    rec = pipeline.run_symbol("TESTSYM", as_of=date(2026, 6, 1))

    assert rec.oi.available is True
    assert rec.oi.aggregate_signal == "long_buildup"
    assert any("OI aggregate signal: long_buildup" in r for r in rec.regime.reasons)


def test_run_symbol_surfaces_the_fundamental_vote_in_regime_reasons(monkeypatch):
    from app.domain.weekly_advisor.screener_fetch import FundamentalAnalysis

    weekly_bars = _bars(60, 400.0, 1.0)
    daily_bars = _bars(60, 400.0, 0.2)
    monkeypatch.setattr(pipeline.market_data_client, "get_candle_history", _fake_history_factory(weekly_bars, daily_bars))
    monkeypatch.setattr(pipeline.market_data_client, "get_expiry_list", lambda exchange, symbol: None)
    monkeypatch.setattr(pipeline.market_data_client, "get_order_blocks", _no_order_blocks)
    monkeypatch.setattr(
        pipeline.screener_fetch, "get_fundamentals",
        lambda symbol, openrouter_api_key=None: FundamentalAnalysis(
            symbol=symbol, bias="bullish", confidence=0.8, summary="Improving margins, deleveraging.",
            pros=["Consistent profit growth"], cons=[], reasons=["profit growth"],
        ),
    )

    rec = pipeline.run_symbol("TESTSYM", as_of=date(2026, 6, 1))

    assert rec.fundamentals.available is True
    assert rec.fundamentals.bias == "bullish"
    assert rec.fundamentals.summary == "Improving margins, deleveraging."
    assert any("screener.in fundamentals read bullish" in r for r in rec.regime.reasons)


# --- _leg_market_data / StrategyLeg.premium_estimate+security_id: same chain fetch, more fields ---


def test_leg_market_data_extracts_last_price_and_security_id_per_strike_and_option_type():
    chain_strikes = [
        _chain_strike(
            2000.0, ce_oi=100, ce_prev_oi=90, ce_last_price=12.5, ce_security_id="111",
            pe_oi=100, pe_prev_oi=90, pe_last_price=8.25, pe_security_id="112",
        ),
    ]

    data = pipeline._leg_market_data(chain_strikes)

    assert data == {
        (2000.0, "CE"): pipeline._LegMarketData(premium=12.5, security_id="111"),
        (2000.0, "PE"): pipeline._LegMarketData(premium=8.25, security_id="112"),
    }


def test_leg_market_data_security_id_is_none_when_the_chain_doesnt_carry_one():
    chain_strikes = [_chain_strike(2000.0, ce_oi=100, ce_prev_oi=90, ce_last_price=12.5)]  # no ce_security_id

    data = pipeline._leg_market_data(chain_strikes)

    assert data == {(2000.0, "CE"): pipeline._LegMarketData(premium=12.5, security_id=None)}


def test_leg_market_data_skips_a_leg_with_no_last_price():
    chain_strikes = [_chain_strike(2000.0, ce_oi=100, ce_prev_oi=90)]  # no ce_last_price

    assert pipeline._leg_market_data(chain_strikes) == {}


def test_leg_market_data_empty_for_no_chain():
    assert pipeline._leg_market_data(None) == {}


def test_run_symbol_attaches_premium_estimate_onto_recommendation_legs(monkeypatch):
    # A downtrend so the bullish-anchored put strike lands cleanly on a
    # strike this fixture's chain actually carries a last_price for.
    weekly_bars = _bars(60, 2000.0, 1.0)  # last weekly close = 2059.0
    daily_bars = _bars(60, 2000.0, 1.0)
    monkeypatch.setattr(pipeline.market_data_client, "get_candle_history", _fake_history_factory(weekly_bars, daily_bars))
    monkeypatch.setattr(pipeline.market_data_client, "get_expiry_list", lambda exchange, symbol: ["2026-06-25"])
    monkeypatch.setattr(
        pipeline.market_data_client,
        "get_option_chain",
        lambda exchange, symbol, expiry: {
            "strikes": [
                _chain_strike(2000.0, ce_oi=1500, ce_prev_oi=1000, ce_last_price=15.0, ce_security_id="201", pe_oi=1500, pe_prev_oi=1000, pe_last_price=45.0, pe_security_id="202"),
                _chain_strike(2050.0, ce_oi=1500, ce_prev_oi=1000, ce_last_price=10.0, ce_security_id="203", pe_oi=1500, pe_prev_oi=1000, pe_last_price=60.0, pe_security_id="204"),
            ]
        },
    )
    monkeypatch.setattr(pipeline.market_data_client, "get_order_blocks", _no_order_blocks)

    rec = pipeline.run_symbol("TESTSYM", as_of=date(2026, 6, 1))

    # Every leg either got a real premium/security_id from the chain, or
    # both None when its exact rounded strike wasn't one of the fixture's
    # two listed strikes - never a raise, never silently skipped from the
    # leg list itself, and never premium without security_id or vice versa
    # (both come from the same _leg_market_data lookup).
    assert len(rec.strategy.legs) > 0
    for leg in rec.strategy.legs:
        assert leg.premium_estimate is None or isinstance(leg.premium_estimate, float)
        assert leg.security_id is None or isinstance(leg.security_id, str)
        assert (leg.premium_estimate is None) == (leg.security_id is None)


def test_run_symbol_fundamentals_unavailable_when_screener_fetch_returns_none(monkeypatch):
    weekly_bars = _bars(60, 400.0, 1.0)
    daily_bars = _bars(60, 400.0, 0.2)
    monkeypatch.setattr(pipeline.market_data_client, "get_candle_history", _fake_history_factory(weekly_bars, daily_bars))
    monkeypatch.setattr(pipeline.market_data_client, "get_expiry_list", lambda exchange, symbol: None)
    monkeypatch.setattr(pipeline.market_data_client, "get_order_blocks", _no_order_blocks)
    # _no_real_fundamentals_fetch autouse fixture already stubs this to None

    rec = pipeline.run_symbol("TESTSYM", as_of=date(2026, 6, 1))

    # available=False -> pipeline.run_symbol passes fundamental=None to
    # assess_regime (same "None means couldn't fetch, omit the vote
    # entirely" convention order_blocks already uses), so no fundamentals
    # reason is added at all - distinct from the vote firing but reading
    # neutral/unavailable, see test_regime.py's own coverage of that.
    assert rec.fundamentals.available is False
    assert not any("fundamentals" in r for r in rec.regime.reasons)
