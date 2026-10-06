import pytest

from app.domain import premarket_report
from app.domain.premarket_bias import score_inputs
from app.providers import premarket


@pytest.fixture(autouse=True)
def _no_macro_network(monkeypatch):
    """build_report also fetches the macro backdrop; these tests are about the overnight inputs."""
    monkeypatch.setattr(premarket_report, "fetch_macro", lambda india_10y=None: {"indicators": [], "derived": {"real_rate": None, "spread_10y_repo": None, "india_10y": india_10y}, "rbi": []})


def _inp(key, change=None, value=None, ok=True, unit="pct", group="us"):
    return {"key": key, "label": key, "group": group, "ok": ok, "value": value, "change": change, "unit": unit, "source": "t", "error": None}


def _all(**over):
    """A flat, fully-covered day; `over` replaces individual inputs' change."""
    base = {
        "sp500": 0.0, "dow": 0.0, "nasdaq": 0.0, "brent": 0.0, "wti": 0.0, "usdinr": 0.0, "us10y": 0.0, "in10y": 0.0,
        "adr_infy": 0.0, "adr_hdb": 0.0, "adr_wit": 0.0, "adr_ibn": 0.0, "adr_rdy": 0.0,
    }
    base.update(over)
    rows = [_inp(k, v, unit="bp" if k in ("us10y", "in10y") else "pct") for k, v in base.items()]
    rows.append(_inp("nifty_close", value=22500.0, group="india"))
    rows.append(_inp("gift_nifty", change=0.0, value=over.get("gift", 22500.0), group="india"))
    return rows


def test_flat_day_is_neutral_with_full_coverage():
    r = score_inputs(_all())
    assert r["bias"] == "neutral"
    assert r["score"] == 0
    assert r["coverage"] == 1.0
    assert r["gift_gap_pct"] == 0


def test_gift_gap_up_and_strong_us_is_bullish():
    r = score_inputs(_all(gift=22650.0, sp500=1.0, dow=1.0, nasdaq=1.0))
    assert r["gift_gap_pct"] == pytest.approx(0.667, abs=0.001)
    assert r["bias"] == "bullish"


def test_rising_crude_weaker_rupee_and_yields_are_bearish():
    r = score_inputs(_all(brent=3.0, wti=3.0, usdinr=0.5, us10y=10, in10y=8))
    assert r["bias"] == "bearish"
    by_key = {f["key"]: f for f in r["factors"]}
    assert by_key["crude"]["score"] == -1.0
    assert by_key["usdinr"]["score"] == -1.0


def test_missing_input_lowers_coverage_and_is_left_out_not_read_as_flat():
    rows = [i for i in _all(gift=22650.0) if i["key"] not in ("us10y", "in10y")]
    r = score_inputs(rows)
    assert r["coverage"] == pytest.approx(0.89, abs=0.01)
    # Only the gift gap is non-zero; it must dominate the renormalised score rather than being diluted by the gaps.
    assert r["score"] > 0.2


def test_failed_input_counts_as_missing():
    rows = _all()
    for i in rows:
        if i["key"] == "gift_nifty":
            i["ok"] = False
    r = score_inputs(rows)
    assert r["gift_gap_pct"] is None
    assert r["coverage"] == pytest.approx(0.68, abs=0.01)


def test_no_data_at_all_is_neutral_zero_coverage():
    r = score_inputs([])
    assert (r["bias"], r["score"], r["coverage"]) == ("neutral", 0.0, 0.0)


def test_score_is_clamped_per_factor():
    r = score_inputs(_all(sp500=9.0, dow=9.0, nasdaq=9.0))
    assert {f["key"]: f for f in r["factors"]}["us_close"]["score"] == 1.0


# --- report building ---------------------------------------------------------


def _fake_inputs(monkeypatch, rows):
    monkeypatch.setattr(premarket_report.provider, "fetch_inputs", lambda: [premarket.RawInput(**{k: r[k] for k in ("key", "label", "group", "ok", "value", "change", "unit", "source", "error")}) for r in rows])


def test_report_without_key_uses_rules_bias_and_says_why(monkeypatch):
    _fake_inputs(monkeypatch, _all(gift=22650.0, sp500=1.0, dow=1.0, nasdaq=1.0))
    rep = premarket_report.build_report(None)
    assert rep["ai"] is None
    assert rep["bias"] == "bullish" == rep["rules"]["bias"]
    assert rep["agree"] is None
    assert "OpenRouter key" in rep["ai_error"]


def test_report_uses_ai_bias_and_flags_disagreement(monkeypatch):
    _fake_inputs(monkeypatch, _all(gift=22650.0, sp500=1.0, dow=1.0, nasdaq=1.0))
    ai = {"bias": "neutral", "confidence": 55, "one_liner": "x", "reasons": ["r"], "risks": [], "watch": "w"}
    monkeypatch.setattr(premarket_report, "run_ai", lambda inputs, rules, key, macro=None: ai)
    rep = premarket_report.build_report("k")
    assert rep["bias"] == "neutral"
    assert rep["agree"] is False
    assert rep["ai_error"] is None


def test_report_survives_ai_failure(monkeypatch):
    _fake_inputs(monkeypatch, _all(gift=22650.0))

    def boom(*a):
        raise RuntimeError("OpenRouter returned 402 (insufficient OpenRouter credit)")

    monkeypatch.setattr(premarket_report, "run_ai", boom)
    rep = premarket_report.build_report("k")
    assert rep["ai"] is None and rep["bias"] == rep["rules"]["bias"]
    assert "402" in rep["ai_error"]


def test_report_with_nothing_fetched_never_calls_the_model(monkeypatch):
    rows = _all()
    for r in rows:
        r["ok"] = False
    _fake_inputs(monkeypatch, rows)
    monkeypatch.setattr(premarket_report, "run_ai", lambda *a: pytest.fail("model must not be called with no data"))
    rep = premarket_report.build_report("k")
    assert rep["rules"]["coverage"] == 0
    assert rep["ai"] is None


# --- provider ---------------------------------------------------------------


def test_yahoo_change_is_percent_for_prices_and_bp_for_the_yield(monkeypatch):
    from datetime import date

    monkeypatch.setattr(premarket, "_yahoo_series", lambda s: [(date(2026, 10, 2), 100.0), (date(2026, 10, 5), 101.0)])
    px = premarket._fetch_yahoo("sp500", "S&P", "us", "^GSPC")
    assert px.ok and px.change == pytest.approx(1.0)
    monkeypatch.setattr(premarket, "_yahoo_series", lambda s: [(date(2026, 10, 2), 5.277), (date(2026, 10, 5), 5.311)])
    y = premarket._fetch_yahoo("us10y", "US 10Y", "yield", "^TNX")
    assert y.unit == "bp" and y.change == pytest.approx(3.4)


def test_yahoo_failure_is_a_failed_input_not_an_exception(monkeypatch):
    def boom(s):
        raise ValueError("no data")

    monkeypatch.setattr(premarket, "_yahoo_series", boom)
    out = premarket._fetch_yahoo("brent", "Brent", "commodity", "BZ=F")
    assert not out.ok and "no data" in out.error


def test_nifty_reference_skips_todays_partial_bar(monkeypatch):
    from datetime import datetime
    from zoneinfo import ZoneInfo

    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    from datetime import timedelta

    monkeypatch.setattr(premarket, "_yahoo_series", lambda s: [(today - timedelta(days=1), 22500.0), (today, 22610.0)])
    ref = premarket._fetch_nifty_reference()
    assert ref.ok and ref.value == 22500.0


def test_tradingview_maps_gift_percent_and_india_yield_in_bp(monkeypatch):
    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"data": [
                {"s": "NSEIX:NIFTY1!", "d": [22650.5, 0.33, 74.5]},
                {"s": "TVC:IN10Y", "d": [7.231, 0.25, 0.018]},
            ]}

    monkeypatch.setattr(premarket.requests, "post", lambda *a, **k: Resp())
    gift, in10y = premarket._fetch_tradingview()
    assert gift.ok and gift.value == 22650.5 and gift.change == 0.33
    assert in10y.ok and in10y.unit == "bp" and in10y.change == pytest.approx(1.8)


def test_tradingview_outage_fails_both_inputs_cleanly(monkeypatch):
    def boom(*a, **k):
        raise premarket.requests.ConnectionError("down")

    monkeypatch.setattr(premarket.requests, "post", boom)
    outs = premarket._fetch_tradingview()
    assert [o.ok for o in outs] == [False, False]


def test_ai_context_names_units_explicitly():
    inputs = [_inp("sp500", 0.66, 7773.9), _inp("us10y", 3.4, 5.311, unit="bp", group="yield"), _inp("brent", ok=False)]
    ctx = premarket_report._context(inputs, score_inputs(inputs))
    by_label = {i["label"]: i for i in ctx["inputs"]}
    assert by_label["sp500"]["change_pct"] == 0.66
    assert by_label["us10y"]["change_bp"] == 3.4 and "change_pct" not in by_label["us10y"]
    assert ctx["missing"] == ["brent"]


def test_gift_row_shows_the_gap_against_niftys_last_close():
    gift = premarket.RawInput(key="gift_nifty", label="GIFT Nifty", group="india", ok=True, value=22650.0, change=0.30, source="tradingview")
    ref = premarket.RawInput(key="nifty_close", label="Nifty last close", group="india", ok=True, value=22500.0, source="yahoo")
    premarket._gift_as_gap([gift, ref])
    assert gift.change == pytest.approx(0.667, abs=0.001)
    assert gift.label == "GIFT Nifty vs last close"


def test_gift_row_keeps_the_feeds_change_when_niftys_close_is_missing():
    gift = premarket.RawInput(key="gift_nifty", label="GIFT Nifty", group="india", ok=True, value=22650.0, change=0.30, source="tradingview")
    ref = premarket.RawInput(key="nifty_close", label="Nifty last close", group="india", ok=False)
    premarket._gift_as_gap([gift, ref])
    assert gift.change == 0.30 and gift.label == "GIFT Nifty"


def test_bias_agrees_with_the_rounded_score_that_is_shown():
    # Only the GIFT gap moves; 0.1198% / 0.6% = 0.1997, which displays as 0.20 and so must read bullish, not neutral.
    r = score_inputs(_all(gift=22500.0 * (1 + 0.1198 / 100 * 1.0)))
    assert r["score"] == round(r["score"], 2)
    assert (r["bias"] == "bullish") == (r["score"] >= 0.2)
