import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.domain import segment_brief
from app.domain.segment_bias import FACTORS, score_inputs
from app.main import app
from app.providers import segment_brief as provider
from app.providers.premarket import RawInput


def _inp(key, change=0.0, ok=True, unit="pct"):
    return {"key": key, "label": key, "group": "g", "ok": ok, "value": 100.0, "change": change, "unit": unit, "source": "t", "error": None}


def _flat(segment, **over):
    keys = {k for f in FACTORS[segment].values() for k in f[4]}
    return [_inp(k, over.get(k, 0.0), unit="bp" if k == "us10y" else "pt" if k == "fear_greed" else "pct") for k in sorted(keys)]


def test_nse_pulse_scores_index_sector_and_vix_moves():
    rows = [_inp(k, 0.0) for k in ("nifty", "banknifty", "indiavix", "sec_it", "sec_fin", "sec_auto", "sec_fmcg", "sec_metal", "sec_pharma", "sec_energy")]
    assert score_inputs("NSE", rows)["bias"] == "neutral"
    up = [{**r, "change": 1.0 if r["key"] != "indiavix" else -8.0} for r in rows]
    assert score_inputs("NSE", up)["bias"] == "bullish"
    fear = [{**r, "change": -1.0 if r["key"] != "indiavix" else 8.0} for r in rows]
    r = score_inputs("NSE", fear)
    assert r["bias"] == "bearish" and {f["key"]: f for f in r["factors"]}["vix"]["score"] == -1.0


def test_flat_mcx_day_is_neutral_with_full_coverage():
    r = score_inputs("MCX", _flat("MCX"))
    assert (r["bias"], r["score"], r["coverage"], r["gift_gap_pct"]) == ("neutral", 0, 1.0, None)


def test_mcx_firmer_metals_and_crude_are_bullish_and_a_strong_dollar_weighs():
    up = score_inputs("MCX", _flat("MCX", gold=1.0, silver=1.5, brent=2.0, wti=2.0, copper=1.5))
    assert up["bias"] == "bullish"
    dollar = {f["key"]: f for f in score_inputs("MCX", _flat("MCX", dxy=0.5))["factors"]}
    assert dollar["dxy"]["score"] == -1.0


def test_mcx_weaker_rupee_lifts_the_rupee_price():
    f = {f["key"]: f for f in score_inputs("MCX", _flat("MCX", usdinr=0.4))["factors"]}
    assert f["usdinr"]["score"] == 1.0


def test_crypto_risk_off_is_bearish():
    r = score_inputs("CRYPTO", _flat("CRYPTO", btc=-2.0, eth=-2.5, sol=-3.0, nasdaq_fut=-1.0, sp500=-1.0, vix=8.0, fear_greed=-10.0))
    assert r["bias"] == "bearish"
    assert {f["key"]: f for f in r["factors"]}["vix"]["score"] == -1.0


def test_missing_input_lowers_coverage_and_is_left_out_not_read_as_flat():
    rows = [i for i in _flat("CRYPTO", btc=2.0) if i["key"] != "fear_greed"]
    r = score_inputs("CRYPTO", rows)
    assert r["coverage"] < 1.0
    assert r["score"] > 0.2


def test_fetch_inputs_covers_each_segment_and_a_failed_source_is_just_a_failed_input(monkeypatch):
    def fake(key, label, group, symbol):
        return RawInput(key=key, label=label, group=group, ok=key != "natgas", change=0.1, value=1.0, source="yahoo", error=None if key != "natgas" else "boom")

    monkeypatch.setattr(provider, "_fetch_yahoo", fake)
    monkeypatch.setattr(provider, "_fetch_fear_greed", lambda: RawInput(key="fear_greed", label="F&G", group="risk", ok=True, change=2.0, value=40.0, unit="pt"))
    mcx = {i.key: i for i in provider.fetch_inputs("MCX")}
    assert {"gold", "silver", "brent", "dxy", "usdinr"} <= set(mcx) and not mcx["natgas"].ok
    crypto = {i.key: i for i in provider.fetch_inputs("CRYPTO")}
    assert {"btc", "eth", "nasdaq_fut", "vix", "fear_greed"} <= set(crypto)


def test_brief_without_a_key_uses_the_rules_bias_and_says_why(monkeypatch):
    monkeypatch.setattr(provider, "fetch_inputs", lambda seg: [RawInput(key=k, label=k, group="g", ok=True, change=2.0, value=1.0) for k in ("btc", "eth", "sol")])
    b = segment_brief.build_brief("CRYPTO", None)
    assert b["ai"] is None and "No OpenRouter key" in b["ai_error"]
    assert b["bias"] == b["rules"]["bias"] == "bullish"


def test_brief_uses_the_ai_bias_and_flags_disagreement(monkeypatch):
    monkeypatch.setattr(provider, "fetch_inputs", lambda seg: [RawInput(key=k, label=k, group="g", ok=True, change=2.0, value=1.0) for k in ("gold", "silver")])
    monkeypatch.setattr(segment_brief, "run_ai", lambda seg, inputs, rules, key: {"bias": "bearish", "confidence": 55, "one_liner": "x", "reasons": [], "risks": [], "watch": "", "macro_context": "", "model": "m"})
    b = segment_brief.build_brief("MCX", "k")
    assert (b["bias"], b["agree"], b["model"]) == ("bearish", False, "m")


def test_ai_context_names_units_for_basis_points_and_index_points():
    ctx = segment_brief._context([_inp("us10y", 3.4, unit="bp"), _inp("fear_greed", 5.0, unit="pt"), _inp("btc", 1.2)], score_inputs("CRYPTO", _flat("CRYPTO")))
    keys = {i["label"]: [k for k in i if k.startswith("change")][0] for i in ctx["inputs"]}
    assert keys == {"us10y": "change_bp", "fear_greed": "change_pt", "btc": "change_pct"}


def _wait_for_upgrade(segment):
    for _ in range(200):
        if segment not in segment_brief._upgrading:
            return
        time.sleep(0.01)
    raise AssertionError("background build never finished")


def _reset():
    segment_brief._cache.clear()
    segment_brief._last_refresh.clear()
    segment_brief._upgrading.clear()


def test_a_cold_request_gets_the_rules_brief_at_once_and_the_ai_read_lands_in_the_cache_after(monkeypatch):
    _reset()
    release = threading.Event()
    monkeypatch.setattr(provider, "fetch_inputs", lambda seg: [RawInput(key="btc", label="btc", group="g", ok=True, change=2.0, value=1.0)])

    def slow_ai(seg, inputs, rules, key):
        release.wait(5)
        return {"bias": "bearish", "confidence": 50, "one_liner": "x", "reasons": [], "risks": [], "watch": "", "model": "m"}

    monkeypatch.setattr(segment_brief, "run_ai", slow_ai)
    first = segment_brief.get_brief("CRYPTO", "k")
    assert first["ai_pending"] is True and first["ai"] is None and first["bias"] == first["rules"]["bias"]
    assert segment_brief.get_brief("CRYPTO", "k")["ai_pending"] is True  # still waiting on the model, not rebuilt
    release.set()
    _wait_for_upgrade("CRYPTO")
    done = segment_brief.get_brief("CRYPTO", "k")
    assert done["ai_pending"] is False and done["bias"] == "bearish" and done["agree"] is False


def test_a_failed_background_build_stops_the_pending_flag(monkeypatch):
    _reset()
    monkeypatch.setattr(provider, "fetch_inputs", lambda seg: [RawInput(key="gold", label="g", group="g", ok=True, change=1.0, value=1.0)])
    monkeypatch.setattr(segment_brief, "add_ai", lambda *a, **k: (_ for _ in ()).throw(ValueError("boom")))
    segment_brief.get_brief("MCX", "k")
    _wait_for_upgrade("MCX")
    after = segment_brief.get_brief("MCX", "k")
    assert after["ai_pending"] is False and "unavailable" in after["ai_error"]


def test_a_stale_brief_is_served_at_once_while_it_rebuilds(monkeypatch):
    _reset()
    calls = []
    monkeypatch.setattr(segment_brief, "build_brief", lambda seg, key, prior=None: calls.append(seg) or {"n": len(calls), "ai_pending": False})
    segment_brief._cache["MCX"] = (time.monotonic() - segment_brief.CACHE_SECONDS - 1, {"n": 0, "ai_pending": False})
    assert segment_brief.get_brief("MCX", None)["n"] == 0
    _wait_for_upgrade("MCX")
    assert calls == ["MCX"] and segment_brief.get_brief("MCX", None)["n"] == 1


def test_a_forced_refresh_waits_for_the_whole_brief_and_is_rate_limited(monkeypatch):
    _reset()
    calls = []
    monkeypatch.setattr(segment_brief, "build_brief", lambda seg, key, prior=None: calls.append(seg) or {"n": len(calls), "ai_pending": False})
    assert segment_brief.get_brief("MCX", None, force=True)["n"] == 1
    with pytest.raises(PermissionError):
        segment_brief.get_brief("MCX", None, force=True)
    assert segment_brief.get_brief("MCX", None)["n"] == 1  # now cached


def test_segments_do_not_block_each_other():
    assert segment_brief._locks["MCX"] is not segment_brief._locks["CRYPTO"]


def test_route_serves_mcx_and_crypto_and_404s_nse_and_needs_a_sign_in_to_refresh(monkeypatch):
    monkeypatch.setattr(provider, "fetch_inputs", lambda seg: [RawInput(key="gold", label="Gold", group="metals", ok=True, change=0.5, value=2000.0)])
    segment_brief._cache.clear()
    client = TestClient(app)
    r = client.get("/market-brief/mcx")
    assert r.status_code == 200
    body = r.json()
    assert body["inputs"][0]["key"] == "gold" and body["rules"]["gift_gap_pct"] is None and body["macro"] is None
    assert client.get("/market-brief/FX").status_code == 404
    assert client.get("/market-brief/MCX?refresh=true").status_code == 401


def test_schema_has_no_macro_field_and_the_prompts_do_not_mention_one():
    assert "macro_context" not in segment_brief._SCHEMA["properties"]
    assert "macro_context" not in segment_brief._SCHEMA["required"]
    assert all("macro_context" not in p for p in segment_brief._PROMPTS.values())


def test_nse_pulse_reads_the_live_price_against_the_previous_close_from_quote_metadata(monkeypatch):
    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"chart": {"result": [{"meta": {"regularMarketPrice": 22000.0, "previousClose": 22200.0}}]}}

    monkeypatch.setattr(provider.requests, "get", lambda *a, **k: Resp())
    got = provider._fetch_yahoo_quote("nifty", "Nifty 50", "index", "^NSEI")
    assert got.ok and got.value == 22000.0 and got.change == pytest.approx(-0.901, abs=0.001)


def test_nse_pulse_input_without_a_live_price_is_a_failed_input_not_an_exception(monkeypatch):
    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"chart": {"result": [{"meta": {}}]}}

    monkeypatch.setattr(provider.requests, "get", lambda *a, **k: Resp())
    got = provider._fetch_yahoo_quote("sec_fin", "Nifty Financial Services", "sector", "^CNXFIN")
    assert not got.ok and "no live price" in got.error
