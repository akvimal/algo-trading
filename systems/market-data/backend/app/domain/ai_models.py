"""Which OpenRouter model each AI task uses, chosen at runtime (More -> AI models) and kept in the database.

Resolution for a task, first match wins:
    1. the task's own override            (source "task")
    2. the shared default model           (source "default")
    3. the task's .env setting            (source "env", app/config.py)

So "same model everywhere" is one default and no overrides, "a different one per task" is an override on each, and any
mix works. Clearing an override puts the task back on the default. The settings are platform-wide (the platform pays
for the scheduled and shared calls), so only an admin can change them.

Resolution never raises and never blocks a call on a database problem: a failed read serves the last good copy (or,
failing that, the .env values). Reads are cached for a short while so a hot call site does not query per request.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

from app.config import settings

logger = logging.getLogger(__name__)

DEFAULT_KEY = "default"
_CACHE_TTL_SECONDS = 30.0


@dataclass(frozen=True)
class Task:
    key: str
    label: str
    description: str
    env_model: Callable[[], str]


TASKS: dict[str, Task] = {
    t.key: t
    for t in (
        Task("news", "News digest", "Scores and summarises headlines for a chart's News tab. Runs on a cache refresh, shared by everyone.", lambda: settings.openrouter_model),
        Task("premarket", "Pre-market bias", "The morning read on the overnight US close, crude, USD/INR, yields, ADRs and GIFT Nifty.", lambda: settings.openrouter_model),
        Task("rbi_summary", "RBI speech summaries", "Reads the full text of the newest RBI speeches and policy releases once and summarises them for the pre-market report.", lambda: settings.openrouter_model),
        Task("ai_read", "OI AI read", "The on-demand read of a chart's open-interest strip, run when someone presses the button.", lambda: settings.openrouter_read_model),
    )
}

_lock = threading.Lock()
_cache: Optional[tuple[float, dict[str, str]]] = None


def _load_overrides() -> dict[str, str]:
    """task key (or "default") -> model, from market_data.ai_model_settings."""
    from app.adapters.db.models import AiModelSetting
    from app.adapters.db.session import SessionLocal

    db = SessionLocal()
    try:
        return {r.task: r.model for r in db.query(AiModelSetting).all()}
    finally:
        db.close()


def overrides() -> dict[str, str]:
    global _cache
    with _lock:
        if _cache is not None and time.monotonic() - _cache[0] < _CACHE_TTL_SECONDS:
            return _cache[1]
        stale = _cache[1] if _cache is not None else {}
    try:
        fresh = _load_overrides()
    except Exception:
        logger.warning("ai_models: could not read the model settings, using the last known ones", exc_info=True)
        fresh = stale
    with _lock:
        _cache = (time.monotonic(), fresh)
    return fresh


def invalidate() -> None:
    global _cache
    with _lock:
        _cache = None


def resolve(task: str) -> tuple[str, str]:
    """(model, source) for a task. Raises KeyError for an unknown task."""
    t = TASKS[task]
    o = overrides()
    if o.get(task):
        return o[task], "task"
    if o.get(DEFAULT_KEY):
        return o[DEFAULT_KEY], "default"
    return t.env_model(), "env"


def model_for(task: str) -> str:
    return resolve(task)[0]


def snapshot() -> dict:
    """What the settings page shows: the shared default, and each task's own override plus the model it actually uses."""
    o = overrides()
    tasks = []
    for t in TASKS.values():
        model, source = resolve(t.key)
        tasks.append({"task": t.key, "label": t.label, "description": t.description, "override": o.get(t.key), "model": model, "source": source})
    return {"default": o.get(DEFAULT_KEY), "tasks": tasks}
