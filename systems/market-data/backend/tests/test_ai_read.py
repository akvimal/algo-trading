"""Tests for app/domain/ai_read.py - context building and the OpenRouter call
(stubbed, no network)."""

import pytest
import requests

from app.config import settings
from app.domain import ai_read
from app.domain.models import (
    Candle,
    ChartStructure,
    MarketRegime,
    OptionChain,
    OptionChainStrike,
    OptionGreeks,
    OptionLegQuote,
)
from app.domain.oi_summary import build_oi_summary


def _leg(oi: int, iv: float, moneyness: str, volume: float = 1000) -> OptionLegQuote:
    return OptionLegQuote(
        security_id="1", last_price=100.0, oi=oi, previous_oi=oi - 100, volume=volume, implied_volatility=iv,
        top_bid_price=99.5, top_ask_price=100.5, greeks=OptionGreeks(delta=0.5, theta=-2.0, gamma=0.001, vega=3.0),
        moneyness=moneyness,
    )


CHAIN = OptionChain(
    underlying_symbol="NIFTY", underlying_exchange="NSE", expiry="2026-10-06", underlying_last_price=24000.0,
    strikes=[
        OptionChainStrike(strike=23950.0, ce=_leg(500000, 13.0, "ITM", 500), pe=_leg(300000, 15.0, "OTM", 1500)),
        OptionChainStrike(strike=24000.0, ce=_leg(800000, 13.2, "ATM", 500), pe=_leg(750000, 13.6, "ATM", 1500)),
    ],
)


def _candle(ts: str, o: float, h: float, low: float, c: float, v: float) -> Candle:
    return Candle(exchange="NSE", symbol="NIFTY", interval="5", open=o, high=h, low=low, close=c, volume=v, timestamp=ts, provider="dhan")


CANDLES = [
    _candle("2026-09-30T09:15:00+05:30", 100, 110, 95, 105, 10),
    _candle("2026-09-30T09:20:00+05:30", 105, 120, 100, 115, 10),
    _candle("2026-10-01T09:15:00+05:30", 116, 118, 114, 117, 10),
    _candle("2026-10-01T09:20:00+05:30", 117, 125, 116, 124, 30),
]
REGIME = MarketRegime(regime="ranging", adx=14.0, atr_percentile=40, trend="range", advice="chop")
STRUCTURE = ChartStructure(order_blocks=[], fvgs=[], trend="range")


def _context() -> dict:
    summary = build_oi_summary(CHAIN, lambda *_: (None, None))
    return ai_read.build_context("NIFTY", summary, CANDLES, REGIME, STRUCTURE)


def test_context_computes_volume_pcr_and_iv_skew():
    oi = _context()["oi"]

    assert oi["volume_pcr"] == 3.0  # (1500+1500) / (500+500)
    assert oi["atm_put_minus_call_iv"] == pytest.approx(0.4)
    assert oi["top_call_oi_strikes"][0]["strike"] == 24000.0  # largest call OI first


def test_context_splits_session_from_prior_day():
    price = _context()["price"]

    assert price["session_open"] == 116
    assert price["session_high"] == 125
    assert price["prior_day_high"] == 120
    assert price["prior_day_low"] == 95
    assert price["last_candle_volume_vs_avg"] == pytest.approx(30 / 15)


def test_context_names_what_was_not_provided():
    assert "India VIX" in _context()["not_provided"]


class _Resp:
    def __init__(self, status: int = 200, content: str = ""):
        self.status_code = status
        self._content = content

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(response=self)

    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}


def test_run_ai_read_uses_configured_model_and_parses_reply(monkeypatch):
    sent = {}

    def fake_post(url, headers, json, timeout):
        sent.update(json=json, headers=headers)
        return _Resp(content='{"bias": "neutral", "confidence": 40, "one_liner": "x", "reasoning": [], "support": [], "resistance": [], "risks": [], "wait_for": "y"}')

    monkeypatch.setattr(ai_read.requests, "post", fake_post)

    out = ai_read.run_ai_read({"a": 1}, "sk-test")

    assert out["bias"] == "neutral"
    assert sent["json"]["model"] == settings.openrouter_read_model == "openai/gpt-6-luna-pro"
    assert sent["json"]["max_tokens"] == 1500
    assert sent["headers"]["Authorization"] == "Bearer sk-test"


@pytest.mark.parametrize("status,fragment", [(402, "insufficient"), (404, "model not found"), (401, "key rejected")])
def test_run_ai_read_maps_http_errors(monkeypatch, status, fragment):
    monkeypatch.setattr(ai_read.requests, "post", lambda *a, **k: _Resp(status))

    with pytest.raises(RuntimeError, match=fragment):
        ai_read.run_ai_read({}, "k")


def test_run_ai_read_rejects_reply_without_valid_bias(monkeypatch):
    monkeypatch.setattr(ai_read.requests, "post", lambda *a, **k: _Resp(content='{"bias": "moon"}'))

    with pytest.raises(RuntimeError):
        ai_read.run_ai_read({}, "k")


# --- writing-vs-buying, VIX, news, events -----------------------------------

from datetime import datetime, timedelta, timezone  # noqa: E402

from app.domain.models import EconomicEvent, NewsArticle, NewsDigest, OptionOiLeg, OptionOiSummary, OptionOiSummaryStrike  # noqa: E402


def _oi_leg(oi_change_15m, buildup, moneyness="ATM") -> OptionOiLeg:
    return OptionOiLeg(
        oi=100000, oi_change_15m=oi_change_15m, implied_volatility=13.0, last_price=100.0, volume=10,
        top_bid_price=99.0, top_ask_price=101.0, moneyness=moneyness, buildup=buildup,
    )


def _summary(strikes) -> OptionOiSummary:
    return OptionOiSummary(
        underlying_symbol="NIFTY", underlying_exchange="NSE", expiry="2026-10-06", underlying_last_price=24000.0,
        total_call_oi=1, total_put_oi=1, strikes=strikes,
    )


def test_flow_buckets_oi_change_by_what_the_buildup_implies():
    summary = _summary([
        OptionOiSummaryStrike(strike=24000.0, call=_oi_leg(-500, "short_buildup"), put=_oi_leg(900, "short_buildup")),
        OptionOiSummaryStrike(strike=24050.0, call=_oi_leg(300, "long_buildup"), put=_oi_leg(None, None)),
    ])

    flow = ai_read._writing_flow(summary)

    assert flow["put writing (support building)"] == 900
    assert flow["call writing (resistance building)"] == 500  # magnitude: the bucket name carries the direction
    assert flow["call buying (bullish bet or hedge)"] == 300
    assert flow["legs_without_reading"] == 1  # the put with no buildup/change yet


def test_flow_ignores_strikes_far_from_spot():
    far = [OptionOiSummaryStrike(strike=24000.0 + 50 * i, call=_oi_leg(1, "long_buildup")) for i in range(1, 30)]
    near = OptionOiSummaryStrike(strike=24000.0, put=_oi_leg(7, "short_buildup"))

    flow = ai_read._writing_flow(_summary([near] + far))

    assert flow["call buying (bullish bet or hedge)"] == 12  # only the 12 nearest of the far strikes (plus near)
    assert flow["put writing (support building)"] == 7


def test_top_strike_view_carries_the_meaning():
    summary = _summary([OptionOiSummaryStrike(strike=24000.0, put=_oi_leg(5, "long_buildup"))])

    assert ai_read._oi_context(summary)["top_put_oi_strikes"][0]["meaning"] == "put buying (bearish bet or hedge)"


def _vix_candle(ts: str, close: float) -> Candle:
    return Candle(exchange="NSE", symbol="INDIA VIX", interval="5min", open=close, high=close, low=close, close=close, volume=0, timestamp=ts, provider="dhan")


def test_vix_context_reports_move_vs_prior_close_and_last_30m():
    candles = [_vix_candle("2026-09-30T15:25:00+05:30", 12.0)] + [
        _vix_candle(f"2026-10-01T09:{15 + 5 * i:02d}:00+05:30", 12.5 + 0.1 * i) for i in range(8)
    ]

    vix = ai_read.vix_context(candles)

    assert vix["value"] == pytest.approx(13.2)
    assert vix["prior_close"] == 12.0
    assert vix["change_vs_prior_close"] == pytest.approx(1.2)
    assert vix["change_last_30m"] == pytest.approx(0.6)  # 6 bars back


def test_vix_context_none_without_candles():
    assert ai_read.vix_context([]) is None


def test_events_window_keeps_only_nearby_events():
    now = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)

    def ev(title, delta):
        return EconomicEvent(title=title, currency="USD", timestamp=(now + delta).isoformat(), impact="high")

    out = ai_read.events_context([ev("old", timedelta(hours=-20)), ev("soon", timedelta(hours=3)), ev("far", timedelta(days=5))], now=now)

    assert [e["title"] for e in out] == ["soon"]


def test_news_context_orders_articles_by_relevance_and_caps_them():
    digest = NewsDigest(
        bias="bearish", bias_reason="r", digest="d",
        articles=[
            NewsArticle(title=f"a{i}", url=f"u{i}", source="s", published_at="2026-10-01T00:00:00+00:00", relevance_score=i * 10, why="w")
            for i in range(6)
        ],
    )

    news = ai_read.news_context(digest)

    assert [a["title"] for a in news["top_articles"]] == ["a5", "a4", "a3"]
    assert ai_read.news_context(None) is None


def test_context_lists_missing_extras_as_not_provided_and_includes_present_ones():
    summary = build_oi_summary(CHAIN, lambda *_: (None, None))

    bare = ai_read.build_context("NIFTY", summary, CANDLES, REGIME, STRUCTURE)
    full = ai_read.build_context("NIFTY", summary, CANDLES, REGIME, STRUCTURE, vix={"value": 13.0}, news={"ai_bias": "neutral"}, events=[])

    assert {"India VIX", "news", "economic calendar"} <= set(bare["not_provided"])
    assert full["vix"] == {"value": 13.0} and full["news"] == {"ai_bias": "neutral"} and full["events"] == []
    assert full["not_provided"] == ai_read.DATA_GAPS["NSE"]


# --- per-market relevance: NSE, MCX, crypto ------------------------------------------------------------------------------------------


def _ctx(segment, **kw):
    summary = build_oi_summary(CHAIN, lambda *_: (None, None))
    return ai_read.build_context("X", summary, CANDLES, REGIME, STRUCTURE, segment=segment, **kw)


def test_india_vix_is_an_nse_gauge_only_and_is_never_reported_missing_for_mcx_or_crypto():
    assert "India VIX" in _ctx("NSE")["not_provided"]
    for segment in ("MCX", "CRYPTO"):
        c = _ctx(segment)
        assert "India VIX" not in c["not_provided"] and "vix" not in c


def test_each_market_lists_the_drivers_it_really_lacks():
    assert "market breadth" in _ctx("NSE")["not_provided"]
    mcx = " ".join(_ctx("MCX")["not_provided"])
    assert "USD/INR" in mcx and "COMEX" in mcx
    crypto = " ".join(_ctx("CRYPTO")["not_provided"])
    assert "funding rate" in crypto and "market breadth" not in crypto


def test_the_system_prompt_carries_the_markets_own_guidance():
    assert "India VIX is the volatility gauge" in ai_read.system_prompt("NSE")
    mcx = ai_read.system_prompt("MCX")
    assert "FUTURES contract" in mcx and "no India VIX" in mcx
    crypto = ai_read.system_prompt("CRYPTO")
    assert "24/7" in crypto and "since 00:00 IST" in crypto
    assert ai_read.system_prompt("???").startswith("You are an options-market analyst")  # an unknown market still gets the base prompt


def test_crypto_iv_is_scaled_from_a_fraction_to_percent_and_nse_is_left_alone():
    frac = OptionChain(
        underlying_symbol="BTCUSD", underlying_exchange="CRYPTO", expiry="2026-10-02", underlying_last_price=84000.0,
        strikes=[OptionChainStrike(strike=84000.0, ce=_leg(10, 0.2763, "ATM"), pe=_leg(10, 0.2725, "ATM"))],
    )
    summary = build_oi_summary(frac, lambda *_: (None, None))

    crypto = ai_read._oi_context(summary, 100.0)
    assert crypto["atm_call_iv"] == 27.63 and crypto["atm_put_iv"] == 27.25 and crypto["atm_put_minus_call_iv"] == -0.38
    assert crypto["iv_unit"] == "percent" and crypto["top_call_oi_strikes"][0]["iv"] == 27.63
    assert ai_read._oi_context(build_oi_summary(CHAIN, lambda *_: (None, None)))["atm_call_iv"] == 13.2  # NSE: already percent


def test_the_contract_is_shown_only_when_it_differs_from_the_underlying():
    assert _ctx("MCX", contract="GOLDM-05Oct2026-FUT")["contract"] == "GOLDM-05Oct2026-FUT"
    assert "contract" not in _ctx("CRYPTO", contract="X")


def test_a_missing_calendar_is_not_a_gap_for_an_instrument_with_no_calendar_mapping():
    assert "economic calendar" in _ctx("NSE")["not_provided"]
    assert "economic calendar" not in _ctx("NSE", events_apply=False)["not_provided"]  # an NSE stock: not applicable


def test_news_with_no_relevant_headlines_is_reported_as_none_not_as_a_neutral_paragraph():
    quiet = NewsDigest(bias="neutral", bias_reason="This article is about equity IPO returns", digest="irrelevant filler", articles=[])
    assert ai_read.news_context(quiet) == {"relevant_headlines": 0}
