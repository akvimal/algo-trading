"""Live prices for the exit monitor: the feed's own ticks used in place of the rate-limited REST quote (app/domain/live_quotes.py,
the `live` flag of POST /quotes/ltp/batch, dhan_feed.fresh_price)."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.routes import quotes as quotes_route
from app.domain import live_quotes
from app.domain.models import BatchQuoteRequest
from app.providers import dhan_feed


@pytest.fixture(autouse=True)
def _feed_state(monkeypatch):
    """The feed's module-level state is shared across the session: every test starts from an empty one."""
    monkeypatch.setattr(dhan_feed, "_last_ticks", {})
    monkeypatch.setattr(dhan_feed, "_tick_monotonic", {})
    monkeypatch.setattr(dhan_feed, "_subscribed", set())


def _tick(exchange, symbol, price, age, now=1000.0, monkeypatch=None):
    dhan_feed._last_ticks[(exchange, symbol)] = {"price": price}
    dhan_feed._tick_monotonic[(exchange, symbol)] = now - age


def test_a_tick_is_fresh_for_a_few_seconds_and_then_not(monkeypatch):
    monkeypatch.setattr(dhan_feed.time, "monotonic", lambda: 1000.0)
    _tick("NSE", "NIFTY", 22300.5, age=1.0)
    _tick("NSE", "BANKNIFTY", 55000.0, age=9.0)
    assert dhan_feed.fresh_price("NSE", "NIFTY", 4.0) == 22300.5
    assert dhan_feed.fresh_price("NSE", "BANKNIFTY", 4.0) is None  # too old: the REST quote is asked instead
    assert dhan_feed.fresh_price("NSE", "TCS", 4.0) is None  # never ticked


def test_a_received_tick_records_when_it_arrived(monkeypatch):
    monkeypatch.setattr(dhan_feed, "_symbol_by_segment_security", {("NSE_FNO", "123"): ("NSE", "BANKNIFTY-27Oct2026-55100-CE")})
    monkeypatch.setattr(dhan_feed, "_publish_tick", lambda *a: None)
    monkeypatch.setattr(dhan_feed.time, "monotonic", lambda: 500.0)
    monkeypatch.setattr(dhan_feed, "NUMERIC_SEGMENT_TO_KEY", {2: "NSE_FNO"})
    dhan_feed._handle_ticker({"segment": 2, "security_id": 123, "ltp": 874.456, "ltt": 1_760_000_000})
    assert dhan_feed._tick_monotonic[("NSE", "BANKNIFTY-27Oct2026-55100-CE")] == 500.0
    assert dhan_feed.fresh_price("NSE", "BANKNIFTY-27Oct2026-55100-CE", 4.0) == 874.46


class FeedProvider:
    name = "dhan"

    def resolve_feed_target(self, symbol):
        return ("NSE_EQ", "1")


class RestProvider:
    """A provider with no live feed (crypto's Delta)."""

    name = "delta"


def _patch_feed(monkeypatch, subscribed_calls, fresh=None, subscribe_raises=False):
    started = []
    monkeypatch.setattr(dhan_feed, "start_feed", lambda: started.append(1))

    def subscribe(exchange, symbol):
        if subscribe_raises:
            raise RuntimeError("boom")
        subscribed_calls.append((exchange, symbol))
        dhan_feed._subscribed.add((exchange, symbol))
        return True

    monkeypatch.setattr(dhan_feed, "subscribe", subscribe)
    monkeypatch.setattr(dhan_feed, "fresh_price", lambda ex, sym, age: (fresh or {}).get(sym))
    return started


def test_fresh_ticks_are_used_and_the_rest_are_left_for_the_ordinary_quote(monkeypatch):
    subscribed = []
    started = _patch_feed(monkeypatch, subscribed, fresh={"NIFTY": 22300.5})
    monkeypatch.setattr(live_quotes, "get_provider", lambda ex: FeedProvider())
    fresh, missing = live_quotes.split_live("NSE", ["NIFTY", "BANKNIFTY"])
    assert fresh == {"NIFTY": 22300.5} and missing == ["BANKNIFTY"]
    assert started and sorted(subscribed) == [("NSE", "BANKNIFTY"), ("NSE", "NIFTY")]  # both are asked of the feed from now on


def test_a_symbol_already_on_the_feed_is_not_subscribed_again(monkeypatch):
    subscribed = []
    _patch_feed(monkeypatch, subscribed, fresh={"NIFTY": 1.0})
    monkeypatch.setattr(live_quotes, "get_provider", lambda ex: FeedProvider())
    live_quotes.split_live("NSE", ["NIFTY"])
    live_quotes.split_live("NSE", ["NIFTY"])  # the caller re-asserts on every poll
    assert subscribed == [("NSE", "NIFTY")]


def test_a_provider_with_no_live_feed_just_gets_the_ordinary_quote(monkeypatch):
    subscribed = []
    started = _patch_feed(monkeypatch, subscribed)
    monkeypatch.setattr(live_quotes, "get_provider", lambda ex: RestProvider())
    assert live_quotes.split_live("CRYPTO", ["BTCUSD"]) == ({}, ["BTCUSD"])
    assert not started and not subscribed


def test_a_feed_that_breaks_costs_nothing_but_the_fallback(monkeypatch):
    _patch_feed(monkeypatch, [], subscribe_raises=True)
    monkeypatch.setattr(live_quotes, "get_provider", lambda ex: FeedProvider())
    assert live_quotes.split_live("NSE", ["NIFTY"]) == ({}, ["NIFTY"])


class Rest:
    """Records what the ordinary REST quote was asked for."""

    name = "dhan"

    def __init__(self, prices=None, fails=False):
        self.calls, self.prices, self.fails = [], prices or {}, fails

    def get_ltp_batch(self, symbols, credentials=None):
        self.calls.append(list(symbols))
        if self.fails:
            raise RuntimeError("Dhan API rate limit hit (429)")
        return {s: self.prices[s] for s in symbols if s in self.prices}


@pytest.fixture
def route(monkeypatch):
    def setup(rest, fresh=None, credentials=None, missing=None):
        splits = []
        monkeypatch.setattr(quotes_route, "get_provider", lambda ex: rest)
        monkeypatch.setattr(quotes_route, "data_credentials", lambda caller, ex=None: credentials)
        monkeypatch.setattr(quotes_route, "interactive_retry", lambda fn, *a: fn(*a))

        def split(exchange, symbols):
            splits.append(list(symbols))
            f = {s: p for s, p in (fresh or {}).items() if s in symbols}
            return f, [s for s in symbols if s not in f]

        monkeypatch.setattr(quotes_route, "split_live", split)
        return splits

    return setup


def call(symbols, live=True):
    return quotes_route.get_ltp_batch(BatchQuoteRequest(exchange="NSE", symbols=symbols, live=live), caller=SimpleNamespace())


def test_when_the_feed_holds_every_price_nothing_is_fetched_over_rest(route):
    rest = Rest()
    route(rest, fresh={"NIFTY": 22300.5, "BANKNIFTY": 55000.0})
    out = call(["NIFTY", "BANKNIFTY"])
    assert out.prices == {"NIFTY": 22300.5, "BANKNIFTY": 55000.0} and rest.calls == []


def test_only_what_the_feed_lacks_is_fetched_and_the_two_are_merged(route):
    rest = Rest(prices={"BANKNIFTY": 55001.0})
    route(rest, fresh={"NIFTY": 22300.5})
    assert call(["NIFTY", "BANKNIFTY"]).prices == {"NIFTY": 22300.5, "BANKNIFTY": 55001.0}
    assert rest.calls == [["BANKNIFTY"]]


def test_a_failed_rest_fallback_still_answers_with_the_ticks_it_has(route):
    route(Rest(fails=True), fresh={"NIFTY": 22300.5})
    assert call(["NIFTY", "BANKNIFTY"]).prices == {"NIFTY": 22300.5}


def test_with_neither_ticks_nor_rest_it_is_the_same_502_as_before(route):
    route(Rest(fails=True))
    with pytest.raises(HTTPException) as e:
        call(["NIFTY"])
    assert e.value.status_code == 502


def test_without_the_flag_the_route_is_exactly_what_it_was(route):
    rest = Rest(prices={"NIFTY": 22299.0})
    splits = route(rest, fresh={"NIFTY": 1.0})
    assert call(["NIFTY"], live=False).prices == {"NIFTY": 22299.0}
    assert splits == [] and rest.calls == [["NIFTY"]]


def test_a_persons_own_keys_keep_their_own_rest_budget_and_never_use_the_platform_feed(route):
    rest = Rest(prices={"NIFTY": 22299.0})
    splits = route(rest, fresh={"NIFTY": 1.0}, credentials=SimpleNamespace(throttle_key="u1"))
    assert call(["NIFTY"]).prices == {"NIFTY": 22299.0}
    assert splits == []
