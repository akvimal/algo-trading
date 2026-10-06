import pytest
from fastapi import HTTPException

from app.api.routes import ai_models as route
from app.config import settings
from app.domain import ai_models


def _set(monkeypatch, rows):
    monkeypatch.setattr(ai_models, "_load_overrides", lambda: dict(rows))
    ai_models.invalidate()


def test_with_nothing_set_each_task_uses_its_env_model():
    assert ai_models.resolve("news") == (settings.openrouter_model, "env")
    assert ai_models.resolve("premarket") == (settings.openrouter_model, "env")
    assert ai_models.resolve("ai_read") == (settings.openrouter_read_model, "env")


def test_default_applies_to_every_task_without_its_own(monkeypatch):
    _set(monkeypatch, {"default": "vendor/shared"})
    assert {t: ai_models.resolve(t) for t in ai_models.TASKS} == {t: ("vendor/shared", "default") for t in ai_models.TASKS}


def test_a_task_override_beats_the_default_and_leaves_the_others(monkeypatch):
    _set(monkeypatch, {"default": "vendor/shared", "premarket": "vendor/special"})
    assert ai_models.resolve("premarket") == ("vendor/special", "task")
    assert ai_models.resolve("news") == ("vendor/shared", "default")


def test_an_override_without_a_default_leaves_other_tasks_on_env(monkeypatch):
    _set(monkeypatch, {"news": "vendor/news-only"})
    assert ai_models.resolve("news") == ("vendor/news-only", "task")
    assert ai_models.resolve("ai_read") == (settings.openrouter_read_model, "env")


def test_unknown_task_raises():
    with pytest.raises(KeyError):
        ai_models.resolve("nope")


def test_a_database_failure_serves_the_last_good_settings_then_env(monkeypatch):
    _set(monkeypatch, {"news": "vendor/a"})
    assert ai_models.model_for("news") == "vendor/a"

    def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(ai_models, "_load_overrides", boom)
    ai_models._cache = (0.0, ai_models._cache[1])  # expire it
    assert ai_models.model_for("news") == "vendor/a"
    ai_models.invalidate()
    assert ai_models.model_for("news") == settings.openrouter_model  # never raises, falls back to .env


def test_snapshot_reports_override_model_and_source(monkeypatch):
    _set(monkeypatch, {"default": "vendor/shared", "news": "vendor/n"})
    snap = ai_models.snapshot()
    assert snap["default"] == "vendor/shared"
    by = {t["task"]: t for t in snap["tasks"]}
    assert (by["news"]["override"], by["news"]["model"], by["news"]["source"]) == ("vendor/n", "vendor/n", "task")
    assert (by["premarket"]["override"], by["premarket"]["model"], by["premarket"]["source"]) == (None, "vendor/shared", "default")


# --- routes ---------------------------------------------------------------


class _Db:
    def __init__(self, rows=None):
        self.rows, self.added, self.deleted, self.commits = rows or {}, [], [], 0

    def get(self, _model, key):
        return self.rows.get(key)

    def add(self, row):
        self.added.append(row)

    def delete(self, row):
        self.deleted.append(row)

    def commit(self):
        self.commits += 1


CATALOG = [{"id": "vendor/ok", "name": "Ok", "context_length": 1000, "prompt_per_m": 0.1, "completion_per_m": 0.4}]


def test_put_saves_a_known_model(monkeypatch):
    monkeypatch.setattr(route, "fetch_catalog", lambda: CATALOG)
    db = _Db()
    route.put_ai_model("premarket", route.AiModelIn(model=" vendor/ok "), db, admin=None)
    assert db.added[0].task == "premarket" and db.added[0].model == "vendor/ok" and db.commits == 1


def test_put_rejects_a_model_not_in_the_structured_output_catalog(monkeypatch):
    monkeypatch.setattr(route, "fetch_catalog", lambda: CATALOG)
    with pytest.raises(HTTPException) as e:
        route.put_ai_model("news", route.AiModelIn(model="vendor/typo"), _Db(), admin=None)
    assert e.value.status_code == 422


def test_put_rejects_an_unknown_task():
    with pytest.raises(HTTPException) as e:
        route.put_ai_model("weather", route.AiModelIn(model="x"), _Db(), admin=None)
    assert e.value.status_code == 404


def test_put_blank_clears_the_override():
    existing = type("Row", (), {"task": "news", "model": "vendor/ok"})()
    db = _Db({"news": existing})
    route.put_ai_model("news", route.AiModelIn(model=""), db, admin=None)
    assert db.deleted == [existing] and db.commits == 1


def test_put_accepts_the_shared_default(monkeypatch):
    monkeypatch.setattr(route, "fetch_catalog", lambda: CATALOG)
    db = _Db()
    route.put_ai_model("default", route.AiModelIn(model="vendor/ok"), db, admin=None)
    assert db.added[0].task == "default"


def test_catalog_keeps_only_structured_output_text_models_cheapest_first(monkeypatch):
    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"data": [
                {"id": "a/pricey", "name": "Pricey", "context_length": 1, "pricing": {"prompt": "0.000003", "completion": "0.000015"}, "supported_parameters": ["structured_outputs"], "architecture": {"output_modalities": ["text"]}},
                {"id": "b/cheap", "name": "Cheap", "context_length": 1, "pricing": {"prompt": "0.0000001", "completion": "0.0000004"}, "supported_parameters": ["structured_outputs"], "architecture": {"output_modalities": ["text"]}},
                {"id": "c/no-json", "name": "NoJson", "pricing": {"prompt": "0"}, "supported_parameters": ["tools"], "architecture": {"output_modalities": ["text"]}},
                {"id": "d/image", "name": "Image", "pricing": {"prompt": "0"}, "supported_parameters": ["structured_outputs"], "architecture": {"output_modalities": ["image"]}},
            ]}

    monkeypatch.setattr(route.requests, "get", lambda *a, **k: Resp())
    route._catalog = None
    rows = route.fetch_catalog()
    assert [r["id"] for r in rows] == ["b/cheap", "a/pricey"]
    assert rows[0]["prompt_per_m"] == 0.1 and rows[0]["completion_per_m"] == 0.4
    route._catalog = None


def test_catalog_outage_serves_the_last_copy_or_a_502(monkeypatch):
    def boom(*a, **k):
        raise route.requests.ConnectionError("down")

    monkeypatch.setattr(route.requests, "get", boom)
    route._catalog = None
    with pytest.raises(HTTPException) as e:
        route.fetch_catalog()
    assert e.value.status_code == 502
    route._catalog = (0.0, CATALOG)  # expired but present
    assert route.fetch_catalog() == CATALOG
    route._catalog = None


# --- the call sites really use the chosen model ---------------------------


class _OkResp:
    def __init__(self, content):
        self._c = content

    def raise_for_status(self):
        pass

    def json(self):
        return {"choices": [{"message": {"content": self._c}}]}


def test_premarket_call_sends_and_reports_its_own_model(monkeypatch):
    from app.domain import premarket_report

    _set(monkeypatch, {"default": "vendor/shared", "premarket": "vendor/pm"})
    sent = {}
    reply = '{"bias": "neutral", "confidence": 50, "one_liner": "x", "reasons": [], "risks": [], "watch": "w"}'
    monkeypatch.setattr(premarket_report.requests, "post", lambda url, **k: (sent.update(k["json"]), _OkResp(reply))[1])
    rules = {"gift_gap_pct": 0.1, "bias": "neutral", "score": 0.0, "coverage": 1.0, "factors": []}
    out = premarket_report.run_ai([], rules, "key")
    assert sent["model"] == "vendor/pm" and out["model"] == "vendor/pm"


def test_news_and_ai_read_calls_follow_the_shared_default(monkeypatch):
    from app.domain import ai_read
    from app.providers import news

    _set(monkeypatch, {"default": "vendor/shared"})
    sent = []
    reply = '{"bias": "neutral", "confidence": 50, "one_liner": "x", "reasoning": [], "support": [], "resistance": [], "risks": [], "wait_for": "", "data_gaps": []}'
    monkeypatch.setattr(ai_read.requests, "post", lambda url, **k: (sent.append(k["json"]["model"]), _OkResp(reply))[1])
    ai_read.run_ai_read({"segment": "NSE"}, "key")
    assert sent == ["vendor/shared"]
    assert ai_models.model_for("news") == "vendor/shared"
    assert "ai_models.model_for(\"news\")" in open(news.__file__, encoding="utf-8").read()
