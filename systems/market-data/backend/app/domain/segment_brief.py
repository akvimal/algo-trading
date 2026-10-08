"""The NSE in-session pulse and the MCX and crypto briefs: the same shape as the NSE morning pre-market report
(app/domain/premarket_report.py) - fetched inputs, a rule-based score, and an OpenRouter model's own call on the same
numbers - so the web app renders all of them with one card. Unlike the morning report there is no daily job, no row in
the database and no Telegram message: a brief is built on demand and kept in memory for an hour (the NSE pulse is only
rebuilt while the session is open). Without an OpenRouter key, or when the call fails, the brief still ships with the
rules' bias and `ai_error` saying why.

The model is only asked again when the numbers it would read have moved meaningfully (app/domain/ai_fingerprint.py);
otherwise the previous read is reused, so the same data is never paid for twice.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, time as dtime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

import requests

from app.config import settings
from app.domain import ai_models
from app.domain.ai_fingerprint import basis, same_basis
from app.domain.ai_retry import post_json
from app.domain.premarket_report import _AI_SCHEMA, today_ist
from app.domain.segment_bias import score_inputs
from app.providers import segment_brief as provider
from app.providers.news import OPENROUTER_URL, _parse_ai_json

logger = logging.getLogger(__name__)

SEGMENTS = ("NSE", "MCX", "CRYPTO")
CACHE_SECONDS = 60 * 60
AI_TIMEOUT_SECONDS = 45
# A forced refresh hits several public data sources, so repeats are collapsed. When the numbers have not changed it
# costs no model call, but the floor stays: it is also what keeps those sources from being hammered.
REFRESH_MIN_GAP_SECONDS = 15 * 60

_COMMON = (
    "Use ONLY the figures given; never invent levels, news or events. An input with ok=false is missing - say so and "
    "lower your confidence, do not guess it. You may disagree with the rule-based score if the inputs justify it, but "
    "then say why in the reasons. Units: change_pct is a percent move; change_bp is a move in basis points (100bp = 1 "
    "percentage point); change_pt is a move in index points. Judge size sensibly and do not call small moves spikes or "
    "crashes. Quote figures exactly as given."
)
# The morning report's schema minus macro_context: there is no domestic-macro block for these briefs, and asking a small
# model to fill a field it has nothing for made it write placeholders into the others.
_SCHEMA = {
    **_AI_SCHEMA,
    "properties": {k: v for k, v in _AI_SCHEMA["properties"].items() if k != "macro_context"},
    "required": [k for k in _AI_SCHEMA["required"] if k != "macro_context"],
}
_PROMPTS = {
    "NSE": (
        "You are a market analyst for Indian equity traders (NSE, Nifty/Bank Nifty), writing an in-session read of how the "
        "market is trading right now. You are given the day's move so far against the previous close for Nifty 50, Bank "
        "Nifty, seven sector indices and India VIX, plus a fixed rule-based score. Say whether the session is trading "
        "bullish, bearish or neutral, how broad it is (many sectors or only a few) and whether fear is rising or easing. A "
        "rising India VIX is a headwind. Index moves under ~0.3%, sector moves under ~0.5% and VIX moves under ~3% are "
        "noise, not a trend. This is NOT the pre-market gap report: do not talk about the overnight gap, GIFT Nifty or the "
        "US close. " + _COMMON
    ),
    "MCX": (
        "You are a market analyst for Indian commodity traders on MCX (gold, silver, crude oil, natural gas, copper). You "
        "are given the global drivers' latest moves - COMEX gold, silver and copper, Brent and WTI crude, Henry Hub gas, "
        "the US dollar index, USD/INR and the US 10Y yield - plus a fixed rule-based score. Give the likely direction for "
        "MCX prices at the open. A firmer dollar and rising US yields weigh on commodities; a weaker rupee lifts the "
        "rupee price of the same dollar move. Metals under ~0.6%, crude under ~1.5%, gas under ~3%, the dollar index "
        "under ~0.3%, USD/INR under ~0.15% and yields under ~5bp are noise, not a trend. " + _COMMON
    ),
    "CRYPTO": (
        "You are a market analyst for crypto traders (BTC, ETH, SOL perpetuals and options). You are given the coins' own "
        "moves since the previous daily close (crypto trades 24/7, so the latest bar is today's move so far), US equity "
        "futures and index, the VIX, the US dollar index, the US 10Y yield and the Fear & Greed index (0 = extreme fear, "
        "100 = extreme greed), plus a fixed rule-based score. Give the likely tone for the next session. A firmer dollar, "
        "rising yields and a rising VIX are headwinds for crypto. Coin moves under ~1.5%, equity futures under ~0.5%, "
        "the VIX under ~5%, the dollar index under ~0.3% and Fear & Greed under ~5 points are noise, not a trend. " + _COMMON
    ),
}


def _context(inputs: list[dict], rules: dict) -> dict:
    unit_key = {"bp": "change_bp", "pt": "change_pt"}
    return {
        "inputs": [{"label": i["label"], "value": i["value"], unit_key.get(i["unit"], "change_pct"): i["change"]} for i in inputs if i["ok"]],
        "missing": [i["label"] for i in inputs if not i["ok"]],
        "rule_based": {
            "bias": rules["bias"], "score": rules["score"], "coverage": rules["coverage"],
            "factors": [{"factor": f["label"], "move": f["move"], "score": f["score"], "weight": f["weight"]} for f in rules["factors"]],
        },
    }


def run_ai(segment: str, inputs: list[dict], rules: dict, api_key: str) -> dict:
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
                    {"role": "system", "content": _PROMPTS[segment]},
                    {"role": "user", "content": json.dumps(_context(inputs, rules))},
                ],
                "response_format": {"type": "json_schema", "json_schema": {"name": "segment_brief", "strict": True, "schema": _SCHEMA}},
                "max_tokens": 1200,  # see premarket_report.run_ai: without a cap a small balance 402s
            },
            AI_TIMEOUT_SECONDS,
            _parse_ai_json,
        )
        if parsed.get("bias") not in ("bullish", "bearish", "neutral"):
            raise ValueError("model reply had no valid bias")
        parsed["model"] = model
        return parsed
    except requests.exceptions.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "?"
        hint = {401: "key rejected", 402: "insufficient OpenRouter credit", 404: "model not found - pick another under More -> AI models"}.get(status, "")
        raise RuntimeError(f"OpenRouter returned {status}" + (f" ({hint})" if hint else "")) from exc
    except Exception as exc:
        raise RuntimeError("AI read temporarily unavailable") from exc


def _session_open(segment: str, now: Optional[datetime] = None) -> bool:
    """Whether a brief for this segment is still moving. NSE only trades 09:15-15:30 on weekdays (15:45 here, so the
    close is captured); MCX and crypto are treated as always live. Outside it the last brief is kept, not rebuilt."""
    if segment != "NSE":
        return True
    now = now or datetime.now(ZoneInfo(settings.timezone))
    return now.weekday() < 5 and dtime(9, 15) <= now.time() <= dtime(15, 45)


def build_rules_brief(segment: str) -> dict:
    """The fast half: fetch the inputs (about a second) and score them. No model call, so it can be shown at once."""
    inputs = [i.to_dict() for i in provider.fetch_inputs(segment)]
    rules = score_inputs(segment, inputs)
    return {
        "day": today_ist(),
        "generated_at": datetime.now(timezone.utc),
        "inputs": inputs,
        "rules": rules,
        "ai": None,
        "macro": None,
        "ai_error": None,
        "ai_pending": False,
        "ai_reused": False,
        "ai_read_at": None,
        "ai_basis": None,
        "model": None,
        "bias": rules["bias"],
        "agree": None,
    }


def add_ai(segment: str, brief: dict, api_key: Optional[str], prior: Optional[dict] = None) -> dict:
    """The slow half: ask the model about the same numbers - unless `prior` (the previous brief for this segment) was read
    on the same data (see ai_fingerprint.py), in which case its AI read is reused and no call is made. A missing key or a failed call
    leaves the rules' bias in place with `ai_error` saying why (and no basis, so the next build retries)."""
    out = {**brief, "ai_pending": False}
    rules = brief["rules"]
    if not api_key:
        out["ai_error"] = "No OpenRouter key - showing the rule-based bias only."
        return out
    if rules["coverage"] == 0:
        out["ai_error"] = "No inputs could be fetched."
        return out
    now_basis = basis(brief["inputs"], rules, ai_models.model_for("premarket"), extra=segment)
    if prior and prior.get("ai") and same_basis(prior.get("ai_basis"), now_basis):
        ai = prior["ai"]
        out.update(
            ai=ai, ai_error=None, model=prior.get("model"), bias=ai["bias"], agree=ai["bias"] == rules["bias"],
            ai_basis=prior["ai_basis"], ai_reused=True, ai_read_at=prior.get("ai_read_at"),
        )
        return out
    try:
        ai = run_ai(segment, brief["inputs"], rules, api_key)
        out.update(
            ai=ai, ai_error=None, model=ai.get("model"), bias=ai["bias"], agree=ai["bias"] == rules["bias"],
            ai_basis=now_basis, ai_read_at=datetime.now(timezone.utc),
        )
    except RuntimeError as exc:
        out["ai_error"] = str(exc)
        logger.warning("segment brief %s: AI step failed: %s", segment, exc)
    return out


def build_brief(segment: str, api_key: Optional[str], prior: Optional[dict] = None) -> dict:
    """Both halves, one after the other (a forced refresh waits for the whole thing)."""
    return add_ai(segment, build_rules_brief(segment), api_key, prior)


# Per segment, so a slow crypto build never holds up an MCX one.
_locks = {s: threading.Lock() for s in SEGMENTS}
_cache: dict[str, tuple[float, dict]] = {}
_last_refresh: dict[str, float] = {}
_upgrading: set[str] = set()


def _store(segment: str, brief: dict) -> None:
    _cache[segment] = (time.monotonic(), brief)


def _upgrade_in_background(segment: str, base: Optional[dict], api_key: Optional[str], prior: Optional[dict] = None) -> None:
    """Fill in the AI read (`base` given) or rebuild a stale brief (`base` None) off the request thread, then swap it in."""

    def work() -> None:
        try:
            _store(segment, add_ai(segment, base, api_key, prior) if base is not None else build_brief(segment, api_key, prior))
        except Exception:
            logger.exception("segment brief %s: background build failed", segment)
            if base is not None:  # never leave the viewer polling for an AI read that is not coming
                _store(segment, {**base, "ai_pending": False, "ai_error": "AI read temporarily unavailable"})
        finally:
            with _locks[segment]:
                _upgrading.discard(segment)

    _upgrading.add(segment)
    threading.Thread(target=work, name=f"segment-brief-{segment}", daemon=True).start()


def get_brief(segment: str, api_key: Optional[str], force: bool = False) -> dict:
    """The brief for a segment, never making a viewer wait on the model:
    - fresh (under CACHE_SECONDS), or the NSE pulse outside its session: served as is;
    - stale: served at once while a rebuild runs in the background;
    - none yet: the rules-based brief (about a second) is served with `ai_pending` set, and the AI read lands in the
      cache a few seconds later - the web app polls until it does;
    - `force`: rebuilds everything synchronously (raises PermissionError with the wait if repeated inside
      REFRESH_MIN_GAP_SECONDS).
    A rebuild whose numbers are within tolerance of the previous read's reuses that read instead of calling the model."""
    with _locks[segment]:
        now = time.monotonic()
        hit = _cache.get(segment)
        prior = hit[1] if hit else None
        if force:
            wait = REFRESH_MIN_GAP_SECONDS - (now - _last_refresh.get(segment, -1e9))
            if wait > 0:
                raise PermissionError(f"Just refreshed - try again in {int(wait // 60) + 1} min.")
            _last_refresh[segment] = now
        elif hit:
            if now - hit[0] >= CACHE_SECONDS and segment not in _upgrading and _session_open(segment):
                _upgrade_in_background(segment, None, api_key, prior)
            return hit[1]
        else:
            base = build_rules_brief(segment)
            base["ai_pending"] = True
            _store(segment, base)
            _upgrade_in_background(segment, base, api_key)
            return base
    brief = build_brief(segment, api_key, prior)
    with _locks[segment]:
        _store(segment, brief)
    return brief
