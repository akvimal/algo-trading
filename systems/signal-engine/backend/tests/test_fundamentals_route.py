"""GET /fundamentals/{symbol}: one stock's AI fundamentals read, on demand. Plain fakes and direct calls."""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.api.routes import fundamentals as route
from app.auth import Caller
from app.domain.weekly_advisor.screener_fetch import FundamentalAnalysis

ME = Caller(user_id=uuid.UUID("11111111-1111-1111-1111-111111111111"), is_admin=False, enforced=True)
NOW = datetime.now(timezone.utc)


def analysis(bias="bullish", age=timedelta(days=3), symbol="RELIANCE"):
    return FundamentalAnalysis(
        symbol=symbol, bias=bias, confidence=0.7 if bias else None, summary="Steady growth, low debt." if bias else None,
        pros=["Debt free"] if bias else [], cons=["High valuation"] if bias else [], reasons=["Profit up 3 years"] if bias else [], fetched_at=NOW - age,
    )


@pytest.fixture
def env(monkeypatch):
    st = {"key": "user-key", "cached": True, "get": analysis(), "forced": None, "reanalyzed": None, "calls": []}
    monkeypatch.setattr(route.accounts_client, "get_user_openrouter_key", lambda uid: st["key"])
    monkeypatch.setattr(route.settings, "openrouter_api_key", "")
    monkeypatch.setattr(route.screener_fetch, "has_cached", lambda sym: st["cached"])

    def get(sym, key=None, force=False):
        st["calls"].append(("force" if force else "get", sym, key))
        return st["forced"] if force else st["get"]

    monkeypatch.setattr(route.screener_fetch, "get_fundamentals", get)
    monkeypatch.setattr(route.screener_fetch, "reanalyze_cached", lambda sym, key=None: st["reanalyzed"])
    return st


def test_a_cached_read_comes_back_with_its_parts(env):
    out = route.get_stock_fundamentals("reliance", refresh=False, caller=ME)
    assert (out.symbol, out.bias, out.confidence, out.pros, out.cons, out.refreshed) == ("RELIANCE", "bullish", 0.7, ["Debt free"], ["High valuation"], False)
    assert env["calls"] == [("get", "RELIANCE", "user-key")]  # the caller's own key reads it; the symbol is normalised


def test_a_symbol_that_is_not_an_nse_symbol_is_refused_before_anything_is_fetched(env):
    for bad in ("../etc", "A B", "x" * 40, ""):
        with pytest.raises(HTTPException) as e:
            route.get_stock_fundamentals(bad, refresh=False, caller=ME)
        assert e.value.status_code == 422
    assert env["calls"] == []
    assert route.get_stock_fundamentals("M&M", refresh=False, caller=ME).symbol == "RELIANCE"  # the fake answers; the symbol itself is allowed


def test_with_no_key_and_nothing_cached_it_asks_for_a_key_instead_of_opening_a_browser(env):
    env.update(key=None, cached=False)
    with pytest.raises(HTTPException) as e:
        route.get_stock_fundamentals("TCS", refresh=False, caller=ME)
    assert e.value.status_code == 409 and e.value.headers["X-Error-Code"] == "openrouter_key_required"
    assert env["calls"] == []


def test_with_no_key_a_cached_read_is_still_served(env):
    env.update(key=None, cached=True)
    assert route.get_stock_fundamentals("TCS", refresh=False, caller=ME).bias == "bullish"


def test_a_stored_page_whose_first_read_failed_is_read_again_from_the_same_page(env):
    env.update(get=analysis(bias=None), reanalyzed=analysis(bias="neutral"))
    assert route.get_stock_fundamentals("TCS", refresh=False, caller=ME).bias == "neutral"


def test_an_unread_page_and_still_no_key_asks_for_one(env):
    env.update(key=None, cached=True, get=analysis(bias=None))
    with pytest.raises(HTTPException) as e:
        route.get_stock_fundamentals("TCS", refresh=False, caller=ME)
    assert e.value.status_code == 409


def test_an_ai_that_fails_twice_is_a_bad_gateway_not_an_empty_card(env):
    env.update(get=analysis(bias=None), reanalyzed=analysis(bias=None))
    with pytest.raises(HTTPException) as e:
        route.get_stock_fundamentals("TCS", refresh=False, caller=ME)
    assert e.value.status_code == 502


def test_a_page_screener_cannot_give_is_unavailable(env):
    env.update(get=None)
    with pytest.raises(HTTPException) as e:
        route.get_stock_fundamentals("NOTREAL", refresh=False, caller=ME)
    assert e.value.status_code == 503 and "NOTREAL" in e.value.detail


def test_a_refresh_captures_again_only_when_the_read_is_a_day_old(env):
    env.update(get=analysis(age=timedelta(days=3)), forced=analysis(age=timedelta(seconds=5)))
    out = route.get_stock_fundamentals("RELIANCE", refresh=True, caller=ME)
    assert out.refreshed is True and ("force", "RELIANCE", "user-key") in env["calls"]
    env["calls"].clear()
    env.update(get=analysis(age=timedelta(hours=2)))
    out = route.get_stock_fundamentals("RELIANCE", refresh=True, caller=ME)
    assert out.refreshed is False and all(c[0] != "force" for c in env["calls"])  # too recent: returned as it is, no browser


def test_a_refresh_that_fails_keeps_the_read_we_had(env):
    env.update(get=analysis(age=timedelta(days=3)), forced=None)
    out = route.get_stock_fundamentals("RELIANCE", refresh=True, caller=ME)
    assert out.refreshed is False and out.bias == "bullish"
