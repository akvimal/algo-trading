import pytest

from app.domain import premarket_report
from app.providers import macro


class _Resp:
    def __init__(self, payload=None, content=b""):
        self._p, self.content = payload, content

    def raise_for_status(self):
        pass

    def json(self):
        return self._p


def _tv(rows):
    return _Resp({"data": [{"s": s, "d": d} for s, d in rows]})


# 2026-08-31 and 2026-09-30 as unix seconds
AUG31, SEP30 = 1788134400, 1790726400

FEED = [
    ("ECONOMICS:INIRYY", [4.82, 0.38, AUG31]),
    ("ECONOMICS:INIPYY", [8.0, 0.6, AUG31]),
    ("ECONOMICS:INGDPYY", [7.8, 0.0, AUG31]),
    ("ECONOMICS:ININTR", [5.25, 0.0, SEP30]),
    ("ECONOMICS:INCRR", [3.0, 0.0, SEP30]),
    ("ECONOMICS:INFER", [747560000000, -18340000000, SEP30]),
]


def test_indicators_carry_value_previous_change_and_period(monkeypatch):
    monkeypatch.setattr(macro.requests, "post", lambda *a, **k: _tv(FEED))
    rows = {r["key"]: r for r in macro.fetch_indicators()}
    cpi = rows["cpi"]
    assert (cpi["ok"], cpi["value"], cpi["change"], cpi["previous"], cpi["period"]) == (True, 4.82, 0.38, 4.44, "2026-08-31")
    assert rows["repo"]["change"] == 0 and rows["repo"]["previous"] == 5.25
    assert list(rows) == ["cpi", "iip", "gdp", "repo", "crr", "fx_reserves"]


def test_fx_reserves_are_scaled_to_billions(monkeypatch):
    monkeypatch.setattr(macro.requests, "post", lambda *a, **k: _tv(FEED))
    fx = {r["key"]: r for r in macro.fetch_indicators()}["fx_reserves"]
    assert fx["unit"] == "usd_bn" and fx["value"] == 747.56 and fx["change"] == -18.34 and fx["previous"] == 765.9


def test_a_symbol_the_feed_omits_is_a_failed_row_not_an_error(monkeypatch):
    monkeypatch.setattr(macro.requests, "post", lambda *a, **k: _tv(FEED[:3]))
    rows = {r["key"]: r for r in macro.fetch_indicators()}
    assert rows["cpi"]["ok"] and not rows["repo"]["ok"] and "not returned" in rows["repo"]["error"]


def test_feed_outage_fails_every_row_without_raising(monkeypatch):
    def boom(*a, **k):
        raise macro.requests.ConnectionError("down")

    monkeypatch.setattr(macro.requests, "post", boom)
    rows = macro.fetch_indicators()
    assert len(rows) == 6 and not any(r["ok"] for r in rows) and all(r["error"] for r in rows)


def test_a_print_with_no_change_figure_still_shows_its_value(monkeypatch):
    monkeypatch.setattr(macro.requests, "post", lambda *a, **k: _tv([("ECONOMICS:INIRYY", [4.82, None, AUG31])]))
    cpi = {r["key"]: r for r in macro.fetch_indicators()}["cpi"]
    assert cpi["ok"] and cpi["value"] == 4.82 and cpi["change"] is None and cpi["previous"] is None


# --- derived -------------------------------------------------------------------------------------------------------


def _ind(key, value, ok=True):
    return {"key": key, "ok": ok, "value": value}


def test_real_rate_is_repo_minus_cpi_and_spread_is_10y_over_repo():
    d = macro.derived([_ind("repo", 5.25), _ind("cpi", 4.82)], 7.231)
    assert d == {"real_rate": 0.43, "spread_10y_repo": 1.98, "india_10y": 7.231}


def test_derived_figures_are_none_when_an_input_is_missing():
    assert macro.derived([_ind("repo", 5.25), _ind("cpi", None, ok=False)], None) == {"real_rate": None, "spread_10y_repo": None, "india_10y": None}
    assert macro.derived([_ind("repo", 5.25), _ind("cpi", 4.82)], None)["real_rate"] == 0.43


# --- RBI feeds ------------------------------------------------------------------------------------------------------

PRESS = b"""<?xml version="1.0"?><rss><channel><title>PRESS RELEASES FROM RBI</title>
<item><title><![CDATA[Money Market Operations as on October 05, 2026]]></title><link>http://x/1</link><pubDate>Mon, 05 Oct 2026 17:00:00 +0530</pubDate></item>
<item><title><![CDATA[Monetary Policy Statement, 2026-27 Resolution of the Monetary Policy Committee (MPC)]]></title><link>http://x/2</link><pubDate>Fri, 02 Oct 2026 10:00:00 +0530</pubDate></item>
<item><title><![CDATA[Directions under Section 35A of the Banking Regulation Act - Some Co-operative Bank]]></title><link>http://x/3</link><pubDate>Mon, 05 Oct 2026 12:00:00 +0530</pubDate></item>
<item><title><![CDATA[Liquidity   management:  VRRR auction]]></title><link>http://x/4</link><pubDate>Tue, 06 Oct 2026 09:00:00 +0530</pubDate></item>
</channel></rss>"""
SPEECHES = b"""<?xml version="1.0"?><rss><channel><title>SPEECHES FROM RBI</title>
<item><title><![CDATA[Preserving Financial Stability - Address by the Governor]]></title><link>http://x/5</link><pubDate>Sat, 03 Oct 2026 11:00:00 +0530</pubDate></item>
<item><title><![CDATA[An unrelated-sounding but still a speech]]></title><link>http://x/6</link><pubDate>Thu, 01 Oct 2026 11:00:00 +0530</pubDate></item>
</channel></rss>"""


def test_press_releases_are_filtered_to_policy_and_speeches_are_all_kept():
    press = macro.parse_rbi_feed(PRESS, "press release", policy_only=True)
    assert [p["title"] for p in press] == ["Monetary Policy Statement, 2026-27 Resolution of the Monetary Policy Committee (MPC)", "Liquidity management: VRRR auction"]
    assert len(macro.parse_rbi_feed(SPEECHES, "speech", policy_only=False)) == 2


def test_rbi_items_are_newest_first_capped_and_carry_kind_and_date(monkeypatch):
    monkeypatch.setattr(macro.requests, "get", lambda url, **k: _Resp(content=PRESS if "press" in url else SPEECHES))
    items = macro.fetch_rbi()
    assert [i["url"] for i in items] == ["http://x/4", "http://x/5", "http://x/2", "http://x/6"]
    assert items[0]["kind"] == "press release" and items[1]["kind"] == "speech"
    assert items[0]["published"].startswith("2026-10-06")


def test_one_rbi_feed_failing_leaves_the_other(monkeypatch):
    def get(url, **k):
        if "press" in url:
            raise macro.requests.ConnectionError("down")
        return _Resp(content=SPEECHES)

    monkeypatch.setattr(macro.requests, "get", get)
    assert [i["kind"] for i in macro.fetch_rbi()] == ["speech", "speech"]


def test_fetch_macro_never_raises_when_everything_is_down(monkeypatch):
    def boom(*a, **k):
        raise macro.requests.ConnectionError("down")

    monkeypatch.setattr(macro.requests, "post", boom)
    monkeypatch.setattr(macro.requests, "get", boom)
    out = macro.fetch_macro(7.2)
    assert out["rbi"] == [] and not any(i["ok"] for i in out["indicators"]) and out["derived"]["real_rate"] is None


# --- how the report uses it -------------------------------------------------------------------------------------------


MACRO = {
    "indicators": [
        {"key": "cpi", "label": "Inflation (CPI, YoY)", "unit": "pct", "ok": True, "value": 4.82, "previous": 4.44, "change": 0.38, "period": "2026-08-31", "error": None},
        {"key": "repo", "label": "RBI repo rate", "unit": "pct", "ok": False, "value": None, "previous": None, "change": None, "period": None, "error": "x"},
    ],
    "derived": {"real_rate": None, "spread_10y_repo": None, "india_10y": 7.2},
    "rbi": [{"title": "Governor speech", "url": "http://x", "published": "2026-10-03T11:00:00+05:30", "kind": "speech"}],
}


def test_the_model_is_shown_only_the_readable_macro_prints_and_rbi_headlines():
    block = premarket_report._macro_context_block(MACRO)
    assert [i["label"] for i in block["indicators"]] == ["Inflation (CPI, YoY)"]
    assert block["indicators"][0]["previous"] == 4.44 and block["recent_rbi"] == [{"kind": "speech", "published": "2026-10-03", "title": "Governor speech"}]
    assert "url" not in str(block)


def test_no_macro_at_all_means_no_block_in_the_prompt():
    assert premarket_report._macro_context_block(None) is None
    assert premarket_report._macro_context_block({"indicators": [{"ok": False}], "derived": {}, "rbi": []}) is None
    rules = {"gift_gap_pct": 0.1, "bias": "neutral", "score": 0.0, "coverage": 1.0, "factors": []}
    assert "domestic_macro" not in premarket_report._context([], rules, None)
    assert "domestic_macro" in premarket_report._context([], rules, MACRO)


def test_the_report_carries_macro_and_uses_the_india_10y_for_the_spread(monkeypatch):
    seen = {}
    monkeypatch.setattr(premarket_report.provider, "fetch_inputs", lambda: [premarket_report.provider.RawInput(key="in10y", label="India 10Y yield", group="yield", ok=True, value=7.231, change=1.8, unit="bp")])
    monkeypatch.setattr(premarket_report, "fetch_macro", lambda india_10y=None: (seen.update(y=india_10y), MACRO)[1])
    rep = premarket_report.build_report(None)
    assert seen["y"] == 7.231 and rep["macro"] is MACRO


def test_the_model_gets_the_macro_and_its_macro_context_comes_back(monkeypatch):
    sent = {}

    class Ok:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": '{"bias": "neutral", "confidence": 50, "one_liner": "x", "reasons": [], "risks": [], "watch": "w", "macro_context": "Real rate is positive."}'}, "finish_reason": "stop"}]}

    monkeypatch.setattr(premarket_report.requests, "post", lambda url, **k: (sent.update(k["json"]), Ok())[1])
    rules = {"gift_gap_pct": 0.1, "bias": "neutral", "score": 0.0, "coverage": 1.0, "factors": []}
    out = premarket_report.run_ai([], rules, "key", MACRO)
    assert "domestic_macro" in sent["messages"][1]["content"] and "macro_context" in sent["response_format"]["json_schema"]["schema"]["required"]
    assert out["macro_context"] == "Real rate is positive."
