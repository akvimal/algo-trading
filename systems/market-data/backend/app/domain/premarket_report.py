"""Builds, stores and reads the daily pre-market bias report: fetch the overnight inputs (app/providers/premarket.py),
score them with fixed rules (app/domain/premarket_bias.py), ask an OpenRouter model for its own call on the same
numbers, and keep one row per IST day in market_data.premarket_reports.

The model is shown the rule-based score and told to weigh it, but its answer is stored separately and the report says
when the two disagree - the rules are the deterministic floor, the model adds judgement (e.g. a big GIFT gap on a day
the US was flat). Without an OpenRouter key, or when the call fails, the report still ships with the rules' bias and
`ai_error` saying why.
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

import requests
from sqlalchemy.orm import Session

from app.adapters.db.models import PremarketReport
from app.config import settings
from app.domain.premarket_bias import score_inputs
from app.providers import premarket as provider
from app.providers.news import OPENROUTER_URL, _parse_ai_json

logger = logging.getLogger(__name__)

_AI_SCHEMA = {
    "type": "object",
    "properties": {
        "bias": {"type": "string", "enum": ["bullish", "bearish", "neutral"]},
        "confidence": {"type": "integer", "description": "0-100. Low when the inputs conflict or key ones are missing."},
        "one_liner": {"type": "string", "description": "One plain sentence: the day's likely tone and the main reason."},
        "reasons": {"type": "array", "items": {"type": "string"}, "description": "2-5 short reasons, strongest first, each citing a figure from the input."},
        "risks": {"type": "array", "items": {"type": "string"}, "description": "0-3 things that could make the call wrong."},
        "watch": {"type": "string", "description": "One thing to watch at the open to confirm or reject the call."},
    },
    "required": ["bias", "confidence", "one_liner", "reasons", "risks", "watch"],
    "additionalProperties": False,
}

_SYSTEM_PROMPT = (
    "You are a pre-market analyst for Indian equity traders (NSE, Nifty/Bank Nifty). You are given the overnight "
    "inputs - US index closes, crude, USD/INR, US and India 10Y yields, Indian ADR moves, and GIFT Nifty with its gap "
    "versus Nifty's last close - plus a fixed rule-based score. Give the likely bias for the Indian session today. "
    "Rising crude, a weaker rupee and rising yields are headwinds for India. Use ONLY the figures given; never invent "
    "levels, news or events. An input with ok=false is missing - say so and lower your confidence, do not guess it. "
    "You may disagree with the rule-based score if the inputs justify it, but then say why in the reasons. "
    "Units: a field named change_pct is a percent move; change_bp is a move in basis points (100bp = 1 percentage "
    "point), so a US 10Y change_bp of 3.4 is a small 3.4bp move. Judge size sensibly: index moves under ~0.3%, crude "
    "under ~1%, USD/INR under ~0.15%, yields under ~5bp and single ADRs under ~1% are noise, not a trend - do not "
    "call them spikes or crashes. Quote figures exactly as given."
)


def _context(inputs: list[dict], rules: dict) -> dict:
    return {
        "inputs": [
            {"label": i["label"], "value": i["value"], "change_bp" if i["unit"] == "bp" else "change_pct": i["change"]}
            for i in inputs if i["ok"]
        ],
        "missing": [i["label"] for i in inputs if not i["ok"]],
        "gift_nifty_gap_pct": rules["gift_gap_pct"],
        "rule_based": {
            "bias": rules["bias"], "score": rules["score"], "coverage": rules["coverage"],
            "factors": [{"factor": f["label"], "move": f["move"], "score": f["score"], "weight": f["weight"]} for f in rules["factors"]],
        },
    }


def run_ai(inputs: list[dict], rules: dict, api_key: str) -> dict:
    """One OpenRouter call. Raises RuntimeError with a short, presentable message on any failure."""
    try:
        resp = requests.post(
            OPENROUTER_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": settings.openrouter_model,
                "messages": [
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": json.dumps(_context(inputs, rules))},
                ],
                "response_format": {"type": "json_schema", "json_schema": {"name": "premarket_bias", "strict": True, "schema": _AI_SCHEMA}},
                # Without a cap OpenRouter reserves the model's full max output and 402s a small balance
                # (see news.py's identical note).
                "max_tokens": 1200,
            },
            timeout=45,
        )
        resp.raise_for_status()
        parsed = _parse_ai_json(resp.json()["choices"][0]["message"]["content"])
        if parsed.get("bias") not in ("bullish", "bearish", "neutral"):
            raise ValueError("model reply had no valid bias")
        return parsed
    except requests.exceptions.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "?"
        hint = {401: "key rejected", 402: "insufficient OpenRouter credit", 404: "model not found - check OPENROUTER_MODEL"}.get(status, "")
        raise RuntimeError(f"OpenRouter returned {status}" + (f" ({hint})" if hint else "")) from exc
    except Exception as exc:
        raise RuntimeError("AI read temporarily unavailable") from exc


def today_ist() -> date:
    return datetime.now(ZoneInfo(settings.timezone)).date()


def build_report(api_key: Optional[str]) -> dict:
    """Fetch + score + (optionally) ask the model. Pure of the database, so a manual run can be inspected before it is stored."""
    inputs = [i.to_dict() for i in provider.fetch_inputs()]
    rules = score_inputs(inputs)
    ai, ai_error = None, None
    if not api_key:
        ai_error = "No OpenRouter key - showing the rule-based bias only."
    elif rules["coverage"] == 0:
        ai_error = "No inputs could be fetched."
    else:
        try:
            ai = run_ai(inputs, rules, api_key)
        except RuntimeError as exc:
            ai_error = str(exc)
            logger.warning("premarket: AI step failed: %s", exc)
    return {
        "inputs": inputs,
        "rules": rules,
        "ai": ai,
        "ai_error": ai_error,
        "model": settings.openrouter_model if ai else None,
        "bias": ai["bias"] if ai else rules["bias"],
        "agree": (ai["bias"] == rules["bias"]) if ai else None,
    }


def save_report(db: Session, day: date, report: dict) -> PremarketReport:
    """One row per day: a refresh replaces that day's report rather than stacking a second."""
    row = db.query(PremarketReport).filter(PremarketReport.day == day).one_or_none()
    if row is None:
        row = PremarketReport(day=day)
        db.add(row)
    row.generated_at = datetime.now(timezone.utc)
    row.bias = report["bias"]
    row.agree = report["agree"]
    row.model = report["model"]
    row.ai_error = report["ai_error"]
    row.inputs = report["inputs"]
    row.rules = report["rules"]
    row.ai = report["ai"]
    db.commit()
    db.refresh(row)
    return row


def get_report(db: Session, day: Optional[date] = None) -> Optional[PremarketReport]:
    """That day's report, or the most recent one when no day is given and today has none yet."""
    q = db.query(PremarketReport)
    if day is not None:
        return q.filter(PremarketReport.day == day).one_or_none()
    return q.order_by(PremarketReport.day.desc()).first()
