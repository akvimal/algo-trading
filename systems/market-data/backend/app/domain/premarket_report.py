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
from app.domain import ai_models
from app.domain.ai_retry import post_json
from app.domain.premarket_bias import score_inputs
from app.providers import premarket as provider
from app.providers.macro import fetch_macro
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
        "macro_context": {
            "type": "string",
            "description": "1-2 sentences on how India's domestic macro backdrop (inflation, policy rate, real rate, the 10Y yield against the repo rate, recent RBI communication) frames bond yields and sentiment. Empty string if no macro data was given.",
        },
    },
    "required": ["bias", "confidence", "one_liner", "reasons", "risks", "watch", "macro_context"],
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
    "call them spikes or crashes. Quote figures exactly as given. "
    "The optional domestic_macro block is India's slow-moving backdrop (monthly prints with their previous values, the real "
    "policy rate = repo minus CPI, the 10Y yield's spread over the repo rate, and recent RBI releases). It is context for "
    "bond yields and sentiment, NOT a daily driver: do not let it override the overnight inputs or the GIFT Nifty gap, and "
    "put what it means in macro_context rather than in the reasons unless it is genuinely decisive today. Quote its figures "
    "exactly; never infer a forecast, a release date, or what the RBI will or will not do. RBI items are headlines only: say what they are about, not what they signal about policy."
)


def _macro_context_block(macro: Optional[dict]) -> Optional[dict]:
    """The macro backdrop trimmed to what the model needs: ok indicators with their previous prints, the derived figures and
    the RBI headlines (no urls)."""
    if not macro:
        return None
    ok = [i for i in macro["indicators"] if i["ok"]]
    if not ok and not macro["rbi"]:
        return None
    return {
        "indicators": [
            {"label": i["label"], "latest": i["value"], "previous": i["previous"], "period_end": i["period"], "unit": "US$ billion" if i["unit"] == "usd_bn" else "percent"}
            for i in ok
        ],
        "real_policy_rate_pp": macro["derived"]["real_rate"],
        "india_10y_minus_repo_pp": macro["derived"]["spread_10y_repo"],
        "recent_rbi": [{"kind": r["kind"], "published": (r["published"] or "")[:10], "title": r["title"]} for r in macro["rbi"]],
    }


def _context(inputs: list[dict], rules: dict, macro: Optional[dict] = None) -> dict:
    ctx = _context_overnight(inputs, rules)
    block = _macro_context_block(macro)
    if block:
        ctx["domestic_macro"] = block
    return ctx


def _context_overnight(inputs: list[dict], rules: dict) -> dict:
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


def run_ai(inputs: list[dict], rules: dict, api_key: str, macro: Optional[dict] = None) -> dict:
    """One OpenRouter call. Raises RuntimeError with a short, presentable message on any failure."""
    model = ai_models.model_for("premarket")
    try:
        parsed = post_json(
            requests.post,
            OPENROUTER_URL,
            {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": json.dumps(_context(inputs, rules, macro))},
                ],
                "response_format": {"type": "json_schema", "json_schema": {"name": "premarket_bias", "strict": True, "schema": _AI_SCHEMA}},
                # Without a cap OpenRouter reserves the model's full max output and 402s a small balance
                # (see news.py's identical note); ai_retry.post_json asks again with more room if a reasoning
                # model's thinking used the cap up.
                "max_tokens": 1200,
            },
            90,  # room for a reasoning model's second, larger attempt
            _parse_ai_json,
        )
        if parsed.get("bias") not in ("bullish", "bearish", "neutral"):
            raise ValueError("model reply had no valid bias")
        parsed["model"] = model  # which model produced THIS read, now that it can change between runs
        return parsed
    except requests.exceptions.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "?"
        hint = {401: "key rejected", 402: "insufficient OpenRouter credit", 404: "model not found - pick another under More -> AI models"}.get(status, "")
        raise RuntimeError(f"OpenRouter returned {status}" + (f" ({hint})" if hint else "")) from exc
    except Exception as exc:
        raise RuntimeError("AI read temporarily unavailable") from exc


def _india_10y(inputs: list[dict]) -> Optional[float]:
    """The India 10Y yield from the overnight inputs, for the spread over the repo rate."""
    i = next((x for x in inputs if x["key"] == "in10y" and x["ok"]), None)
    return i["value"] if i else None


def today_ist() -> date:
    return datetime.now(ZoneInfo(settings.timezone)).date()


def build_report(api_key: Optional[str]) -> dict:
    """Fetch + score + (optionally) ask the model. Pure of the database, so a manual run can be inspected before it is stored."""
    inputs = [i.to_dict() for i in provider.fetch_inputs()]
    rules = score_inputs(inputs)
    macro = fetch_macro(_india_10y(inputs))
    ai, ai_error = None, None
    if not api_key:
        ai_error = "No OpenRouter key - showing the rule-based bias only."
    elif rules["coverage"] == 0:
        ai_error = "No inputs could be fetched."
    else:
        try:
            ai = run_ai(inputs, rules, api_key, macro)
        except RuntimeError as exc:
            ai_error = str(exc)
            logger.warning("premarket: AI step failed: %s", exc)
    return {
        "inputs": inputs,
        "rules": rules,
        "ai": ai,
        "macro": macro,
        "ai_error": ai_error,
        "model": ai.get("model") if ai else None,
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
    row.macro = report.get("macro")
    db.commit()
    db.refresh(row)
    return row


def get_report(db: Session, day: Optional[date] = None) -> Optional[PremarketReport]:
    """That day's report, or the most recent one when no day is given and today has none yet."""
    q = db.query(PremarketReport)
    if day is not None:
        return q.filter(PremarketReport.day == day).one_or_none()
    return q.order_by(PremarketReport.day.desc()).first()
