"""GET/PUT /ai-models - which OpenRouter model each AI task uses (see app/domain/ai_models.py), and GET /ai-models/catalog,
the models OpenRouter currently offers (with prices) for the picker.

Admin only: these are platform-wide settings, and the platform pays for the scheduled and shared calls. A PUT checks the
model against the catalog so a typo cannot silently turn a task into a daily failure, and refuses a model that cannot
return structured JSON, which every task here relies on."""

import logging
import threading
import time
from typing import Optional
from uuid import UUID

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.adapters.db.models import AiModelSetting
from app.adapters.db.session import get_db
from app.auth import require_admin
from app.domain import ai_models

logger = logging.getLogger(__name__)
router = APIRouter()

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
_CATALOG_TTL_SECONDS = 3600.0
_catalog_lock = threading.Lock()
_catalog: Optional[tuple[float, list[dict]]] = None


class CatalogModel(BaseModel):
    id: str
    name: str
    context_length: Optional[int] = None
    prompt_per_m: Optional[float] = None  # USD per million input tokens
    completion_per_m: Optional[float] = None  # USD per million output tokens


class AiModelTask(BaseModel):
    task: str
    label: str
    description: str
    override: Optional[str] = None
    model: str  # what the task actually uses right now
    source: str  # "task" | "default" | "env"


class AiModelsOut(BaseModel):
    default: Optional[str] = None
    tasks: list[AiModelTask]


class AiModelIn(BaseModel):
    model: Optional[str] = None  # None / blank clears the setting


def _per_million(price) -> Optional[float]:
    try:
        return round(float(price) * 1_000_000, 4)
    except (TypeError, ValueError):
        return None


def fetch_catalog() -> list[dict]:
    """Text models that can return structured JSON, cheapest input first. One public call, cached for an hour; on a
    failed refresh the last good copy is served."""
    global _catalog
    with _catalog_lock:
        if _catalog is not None and time.monotonic() - _catalog[0] < _CATALOG_TTL_SECONDS:
            return _catalog[1]
        stale = _catalog[1] if _catalog is not None else None
    try:
        resp = requests.get(OPENROUTER_MODELS_URL, timeout=20)
        resp.raise_for_status()
        rows = []
        for m in resp.json().get("data", []):
            if "structured_outputs" not in (m.get("supported_parameters") or []):
                continue
            if "text" not in ((m.get("architecture") or {}).get("output_modalities") or ["text"]):
                continue
            pricing = m.get("pricing") or {}
            rows.append({
                "id": m["id"], "name": m.get("name") or m["id"], "context_length": m.get("context_length"),
                "prompt_per_m": _per_million(pricing.get("prompt")), "completion_per_m": _per_million(pricing.get("completion")),
            })
        rows.sort(key=lambda r: (r["prompt_per_m"] is None, r["prompt_per_m"] or 0, r["id"]))
    except Exception as exc:
        logger.warning("ai-models: could not fetch OpenRouter's model list: %s", exc)
        if stale is not None:
            return stale
        raise HTTPException(status_code=502, detail="Could not load OpenRouter's model list. Try again shortly.") from exc
    with _catalog_lock:
        _catalog = (time.monotonic(), rows)
    return rows


@router.get("/ai-models", response_model=AiModelsOut)
def get_ai_models(_admin: UUID = Depends(require_admin)):
    return ai_models.snapshot()


@router.get("/ai-models/catalog", response_model=list[CatalogModel])
def get_catalog(_admin: UUID = Depends(require_admin)):
    return fetch_catalog()


@router.put("/ai-models/{task}", response_model=AiModelsOut)
def put_ai_model(task: str, payload: AiModelIn, db: Session = Depends(get_db), admin: UUID = Depends(require_admin)):
    """Set (or, with a blank model, clear) one task's override, or the shared default under the task name 'default'."""
    if task != ai_models.DEFAULT_KEY and task not in ai_models.TASKS:
        raise HTTPException(status_code=404, detail=f"unknown AI task '{task}'")
    model = (payload.model or "").strip()
    row = db.get(AiModelSetting, task)
    if not model:
        if row is not None:
            db.delete(row)
            db.commit()
    else:
        known = {m["id"]: m for m in fetch_catalog()}
        if model not in known:
            raise HTTPException(status_code=422, detail=f"'{model}' is not a model OpenRouter offers with structured JSON output.")
        if row is None:
            db.add(AiModelSetting(task=task, model=model, updated_by=admin))
        else:
            row.model, row.updated_by = model, admin
            row.updated_at = func.now()
        db.commit()
    ai_models.invalidate()
    return ai_models.snapshot()
