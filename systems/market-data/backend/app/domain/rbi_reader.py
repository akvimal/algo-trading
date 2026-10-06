"""Reads the RBI speeches and policy releases behind the pre-market report's "Recent from the RBI" links.

Until now the model saw only each item's title. This fetches the full text of the newest few (RBI's speech and press-release
pages carry the whole text inline, ~15-17k characters for a Governor's address; confirmed live 2026-10-06), has a model
summarise each ONCE, and stores the summary keyed by the item's url so a later report reuses it instead of paying again.

The summary is an AI reading of the text, shown to the user as such, next to the link. The prompt only allows a stance when the
text itself signals one, and forbids forecasting what the RBI will do. Everything here is best effort: a page that cannot be
read, a model that fails or no key all just leave an item without a summary - the report never fails because of this.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Optional

import requests

from app.adapters.db.models import RbiSummary
from app.adapters.db.session import SessionLocal
from app.domain import ai_models
from app.domain.ai_retry import post_json
from app.providers.news import OPENROUTER_URL, _parse_ai_json

logger = logging.getLogger(__name__)

# How many of the newest items are read. A speech is ~4-5k tokens, so this bounds the worst-case cost of a first run.
READ_NEWEST = 3
# Longest text sent to the model. The longest speech seen was ~17k characters; this is a guard against a runaway page.
MAX_TEXT_CHARS = 30_000
_MIN_TEXT_CHARS = 400  # shorter than this is not a speech or a statement, but an operations notice or an error page
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

STANCES = ["hawkish", "dovish", "neutral", "not about policy"]

_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "2-3 plain sentences, at most 70 words, on what the text says in its own terms. Plain text only: no markdown, no bullet points, no headings."},
        "stance": {
            "type": "string",
            "enum": STANCES,
            "description": "hawkish / dovish / neutral ONLY if the text itself signals a direction for interest rates, inflation or liquidity policy; otherwise 'not about policy'.",
        },
        "rates": {"type": "string", "description": "What the text explicitly says about interest rates, inflation or liquidity, in one sentence of at most 35 words. Empty string if it says nothing."},
    },
    "required": ["summary", "stance", "rates"],
    "additionalProperties": False,
}

_SYSTEM_PROMPT = (
    "You summarise one Reserve Bank of India speech or release for an Indian bond and equity trader. Use ONLY the text given; "
    "never add facts, numbers or intentions that are not in it. Do not forecast what the RBI will do next. Set stance to "
    "hawkish, dovish or neutral only when the text itself signals a direction for interest-rate, inflation or liquidity "
    "policy; a speech about technology, supervision, payments or financial stability with no such signal is 'not about policy'. "
    "In 'rates', report only what the text explicitly says about rates, inflation or liquidity, or leave it empty. Be brief: "
    "the summary is at most 70 words of plain prose (no markdown, no bullets, no lists, no bold), and 'rates' is one short sentence."
)

SUMMARY_MAX_CHARS = 600
RATES_MAX_CHARS = 300


def extract_text(html: str) -> str:
    """The body of an RBI speech / press-release page: the `doublescroll` block, tags and the page chrome stripped."""
    start = html.find('<div id="doublescroll">')
    if start < 0:
        return ""
    end = html.find("</div>", start)
    block = html[start:end] if end > start else html[start:]
    block = re.sub(r"(?is)<(script|style|noscript).*?</\1>", " ", block)
    text = re.sub(r"(?s)<[^>]+>", " ", block).replace("&nbsp;", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"^\(\s*[\d.,]+\s*[kKmM][bB]\s*\)\s*", "", text)  # the "( 140 kb )" PDF size that heads the block


def fetch_text(url: str) -> Optional[str]:
    """The item's text, or None when the page cannot be read or is too short to be an address."""
    try:
        resp = requests.get(url, headers={"User-Agent": _UA}, timeout=25)
        resp.raise_for_status()
        text = extract_text(resp.text)
    except Exception as exc:
        logger.warning("rbi_reader: could not fetch %s: %s", url, exc)
        return None
    return text[:MAX_TEXT_CHARS] if len(text) >= _MIN_TEXT_CHARS else None


def summarise(title: str, text: str, api_key: str, model: str) -> dict:
    """One model call. Raises on failure (the caller turns that into 'no summary')."""
    parsed = post_json(
        requests.post,
        OPENROUTER_URL,
        {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        {
            "model": model,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps({"title": title, "text": text})},
            ],
            "response_format": {"type": "json_schema", "json_schema": {"name": "rbi_summary", "strict": True, "schema": _SCHEMA}},
            "max_tokens": 900,
        },
        90,
        _parse_ai_json,
    )
    if parsed.get("stance") not in STANCES or not str(parsed.get("summary") or "").strip():
        raise ValueError("model reply had no usable summary")
    return parsed


def _tidy(s: str, limit: int) -> str:
    """Plain, short text. Models sometimes ignore "no markdown, 70 words" (gpt-oss wrote ~2,000 characters of bold headings and
    bullet points live, 2026-10-06), so the limits are also enforced here: markdown marks and list bullets are dropped and
    anything over `limit` is cut at the last sentence end that fits (or at a word, with an ellipsis)."""
    s = re.sub(r"(\*\*|__|`)", "", s)
    s = re.sub(r"(?m)^\s*[-*\u2022]\s+", "", s)
    s = re.sub(r"\s+[-*\u2022]\s+(?=[A-Z])", " ", s)  # a bullet that follows other text on the same line
    s = _clean(s)
    if len(s) <= limit:
        return s
    cut = s[:limit]
    end = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
    if end > limit * 0.5:
        return cut[: end + 1]
    return cut[: cut.rfind(" ")].rstrip(" ,;:-") + "\u2026"


def _clean(s: str) -> str:
    """The text (and the model's quotes of it) carry narrow no-break spaces and other odd spacing; show plain spaces."""
    return re.sub(r"\s+", " ", re.sub(r"[\u202f\u00a0\u2009]", " ", s)).strip()


def _as_dict(row: RbiSummary) -> dict:
    return {"text": row.summary, "stance": row.stance, "rates": row.rates or None, "model": row.model}


def attach_summaries(items: list[dict], api_key: Optional[str]) -> list[dict]:
    """Adds `summary` to the newest READ_NEWEST items: the stored one when this item was read before, else a fresh read
    (needs `api_key`). Returns the same list; an item that could not be summarised simply has no `summary` key."""
    db = SessionLocal()
    try:
        for item in items[:READ_NEWEST]:
            url = item.get("url")
            if not url:
                continue
            try:
                row = db.get(RbiSummary, url)
                if row is None and api_key:
                    text = fetch_text(url)
                    if text:
                        model = ai_models.model_for("rbi_summary")
                        got = summarise(item["title"], text, api_key, model)
                        row = RbiSummary(
                            url=url, kind=item["kind"], title=item["title"], published=_parse_dt(item.get("published")),
                            stance=got["stance"], summary=_tidy(got["summary"], SUMMARY_MAX_CHARS), rates=_tidy(got.get("rates") or "", RATES_MAX_CHARS) or None,
                            model=model, read_at=datetime.now(timezone.utc),
                        )
                        db.add(row)
                        db.commit()
                if row is not None:
                    item["summary"] = _as_dict(row)
            except Exception as exc:
                db.rollback()
                logger.warning("rbi_reader: no summary for %s: %s", url, exc)
    finally:
        db.close()
    return items


def _parse_dt(iso: Optional[str]) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(iso) if iso else None
    except ValueError:
        return None
