from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.domain import premarket_report, segment_brief
from app.domain.ai_fingerprint import basis, same_basis
from app.domain.segment_brief import _session_open
from app.providers import segment_brief as provider
from app.providers.premarket import RawInput

AI = {"bias": "bullish", "confidence": 60, "one_liner": "x", "reasons": [], "risks": [], "watch": "", "model": "m"}


def _inp(key, change, unit="pct", ok=True):
    return {"key": key, "label": key, "group": "g", "ok": ok, "value": 100.0, "change": change, "unit": unit, "source": "t", "error": None}


RULES = {"bias": "bullish", "score": 0.4, "coverage": 1.0, "factors": []}


def _b(inputs, rules=RULES, model="m", extra=""):
    return basis(inputs, rules, model, extra=extra)


def test_noise_within_tolerance_is_the_same_data_but_a_real_move_is_not():
    base = _b([_inp("btc", 1.0)])
    assert same_basis(base, _b([_inp("btc", 1.12)]))
    assert not same_basis(base, _b([_inp("btc", 1.4)]))
    assert same_basis(_b([_inp("us10y", 3.4, "bp")]), _b([_inp("us10y", 4.9, "bp")]))
    assert not same_basis(_b([_inp("us10y", 3.4, "bp")]), _b([_inp("us10y", 6.0, "bp")]))


def test_a_figure_on_a_rounding_edge_does_not_flip_the_answer():
    # With bucket hashing 0.049 and 0.051 could land on different sides of an edge; a tolerance has no edge.
    assert same_basis(_b([_inp("btc", 0.049)]), _b([_inp("btc", 0.051)]))
    assert same_basis(_b([_inp("btc", 1.049)]), _b([_inp("btc", 1.051)]))


def test_the_basis_is_the_read_not_the_latest_build_so_slow_drift_is_caught():
    read_on = _b([_inp("btc", 1.0)])
    step1, step2, step3 = _b([_inp("btc", 1.07)]), _b([_inp("btc", 1.14)]), _b([_inp("btc", 1.21)])
    assert same_basis(read_on, step1) and same_basis(read_on, step2)
    assert not same_basis(read_on, step3)  # each step is small, but the total is a full tolerance from what the model saw


def test_a_different_model_prompt_missing_input_bias_or_score_shift_is_new_data(monkeypatch):
    base = _b([_inp("btc", 1.0)])
    assert not same_basis(base, _b([_inp("btc", 1.0)], model="other"))
    assert not same_basis(base, _b([_inp("btc", 1.0)], extra="MCX"))
    assert not same_basis(base, _b([_inp("btc", 1.0, ok=False)]))
    assert not same_basis(base, _b([_inp("btc", 1.0)], rules={**RULES, "bias": "bearish"}))
    assert not same_basis(base, _b([_inp("btc", 1.0)], rules={**RULES, "score": 0.55}))
    assert not same_basis(base, _b([_inp("btc", 1.0), _inp("eth", 1.0)]))
    monkeypatch.setattr("app.domain.ai_fingerprint.PROMPT_VERSION", 2)
    assert not same_basis(base, _b([_inp("btc", 1.0)]))


def _brief(change):
    monkeypatch_inputs = [RawInput(key="btc", label="btc", group="g", ok=True, change=change, value=1.0)]
    return monkeypatch_inputs


def test_a_rebuild_on_unchanged_numbers_reuses_the_ai_read_without_a_model_call(monkeypatch):
    calls = []
    monkeypatch.setattr(segment_brief, "run_ai", lambda seg, i, r, k: calls.append(1) or dict(AI))
    monkeypatch.setattr(provider, "fetch_inputs", lambda seg: _brief(2.01))
    first = segment_brief.build_brief("CRYPTO", "k")
    assert calls == [1] and first["ai_reused"] is False and first["ai_read_at"] is not None
    monkeypatch.setattr(provider, "fetch_inputs", lambda seg: _brief(2.1))  # noise
    second = segment_brief.build_brief("CRYPTO", "k", prior=first)
    assert calls == [1] and second["ai_reused"] is True and second["ai"] == first["ai"] and second["ai_read_at"] == first["ai_read_at"]
    monkeypatch.setattr(provider, "fetch_inputs", lambda seg: _brief(2.4))  # a real move (0.39 from what the model read)
    third = segment_brief.build_brief("CRYPTO", "k", prior=second)
    assert calls == [1, 1] and third["ai_reused"] is False


def test_slow_drift_across_reused_builds_eventually_asks_the_model_again(monkeypatch):
    calls = []
    monkeypatch.setattr(segment_brief, "run_ai", lambda *a: calls.append(1) or dict(AI))
    monkeypatch.setattr(provider, "fetch_inputs", lambda seg: _brief(2.0))
    prior = segment_brief.build_brief("CRYPTO", "k")
    for change in (2.07, 2.14):
        monkeypatch.setattr(provider, "fetch_inputs", lambda seg, c=change: _brief(c))
        prior = segment_brief.build_brief("CRYPTO", "k", prior=prior)
        assert prior["ai_reused"] is True
    monkeypatch.setattr(provider, "fetch_inputs", lambda seg: _brief(2.21))
    assert segment_brief.build_brief("CRYPTO", "k", prior=prior)["ai_reused"] is False
    assert calls == [1, 1]


def test_a_failed_ai_call_is_not_remembered_so_the_next_build_retries(monkeypatch):
    monkeypatch.setattr(provider, "fetch_inputs", lambda seg: _brief(2.0))

    def boom(*a):
        raise RuntimeError("OpenRouter returned 402")

    monkeypatch.setattr(segment_brief, "run_ai", boom)
    failed = segment_brief.build_brief("CRYPTO", "k")
    assert failed["ai"] is None and failed["ai_basis"] is None
    calls = []
    monkeypatch.setattr(segment_brief, "run_ai", lambda *a: calls.append(1) or dict(AI))
    ok = segment_brief.build_brief("CRYPTO", "k", prior=failed)
    assert calls == [1] and ok["ai"] is not None


def test_a_different_segment_never_reuses_anothers_read(monkeypatch):
    both = [RawInput(key=k, label=k, group="g", ok=True, change=2.0, value=1.0) for k in ("btc", "gold")]
    monkeypatch.setattr(provider, "fetch_inputs", lambda seg: both)
    calls = []
    monkeypatch.setattr(segment_brief, "run_ai", lambda *a: calls.append(1) or dict(AI))
    crypto = segment_brief.build_brief("CRYPTO", "k")
    segment_brief.build_brief("MCX", "k", prior=crypto)
    assert calls == [1, 1]


@pytest.mark.parametrize(
    "when,expected",
    [
        ((2026, 10, 8, 9, 0), False),   # Thursday, before the open
        ((2026, 10, 8, 9, 15), True),
        ((2026, 10, 8, 15, 30), True),
        ((2026, 10, 8, 15, 46), False),  # after the close
        ((2026, 10, 10, 11, 0), False),  # Saturday
    ],
)
def test_the_nse_pulse_is_only_rebuilt_during_the_session(when, expected):
    assert _session_open("NSE", datetime(*when, tzinfo=ZoneInfo("Asia/Kolkata"))) is expected
    assert _session_open("MCX", datetime(2026, 10, 10, 3, 0, tzinfo=ZoneInfo("Asia/Kolkata"))) is True


def test_a_stale_nse_pulse_is_kept_outside_the_session(monkeypatch):
    import time

    segment_brief._cache.clear()
    segment_brief._upgrading.clear()
    segment_brief._cache["NSE"] = (time.monotonic() - segment_brief.CACHE_SECONDS - 5, {"n": 0, "ai_pending": False})
    monkeypatch.setattr(segment_brief, "_session_open", lambda seg, now=None: False)
    monkeypatch.setattr(segment_brief, "build_brief", lambda *a, **k: pytest.fail("must not rebuild a closed market"))
    assert segment_brief.get_brief("NSE", "k")["n"] == 0
    assert "NSE" not in segment_brief._upgrading


def _fake_inputs(monkeypatch, change):
    monkeypatch.setattr(premarket_report.ai_models, "model_for", lambda task: "m")
    rows = [RawInput(key=k, label=k, group="us", ok=True, value=100.0, change=change if k == "sp500" else 0.0) for k in ("sp500", "dow", "nasdaq", "brent", "wti", "usdinr")]
    monkeypatch.setattr(premarket_report.provider, "fetch_inputs", lambda: rows)
    monkeypatch.setattr(premarket_report, "fetch_macro", lambda india_10y=None: {"indicators": [], "derived": {"real_rate": None, "spread_10y_repo": None, "india_10y": None}, "rbi": []})


def test_the_morning_report_refresh_reuses_todays_ai_read_when_nothing_changed(monkeypatch):
    _fake_inputs(monkeypatch, 1.0)
    calls = []
    monkeypatch.setattr(premarket_report, "run_ai", lambda inputs, rules, key, macro=None: calls.append(1) or dict(AI))
    first = premarket_report.build_report("k")
    assert calls == [1] and first["ai_reused"] is False
    prior = {"inputs": first["inputs"], "rules": first["rules"], "macro": first["macro"], "ai": first["ai"], "model": first["model"]}
    again = premarket_report.build_report("k", prior=prior)
    assert calls == [1] and again["ai_reused"] is True and again["ai"] == first["ai"] and again["model"] == first["model"]
    _fake_inputs(monkeypatch, 2.5)  # the US really moved
    moved = premarket_report.build_report("k", prior=prior)
    assert calls == [1, 1] and moved["ai_reused"] is False
