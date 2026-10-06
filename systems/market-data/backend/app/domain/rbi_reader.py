"""Reads the RBI speeches and policy releases behind the pre-market report's "Recent from the RBI" links.

Until now the model saw only each item's title. This fetches the full text of the newest few (RBI's speech and press-release
pages carry the whole text inline, ~15-17k characters for a Governor's address; confirmed live 2026-10-06), has a model
summarise each ONCE, and stores the summary keyed by the item's url so a later report reuses it instead of paying again.

The summary is an AI reading of the text, shown to the user as such, next to the link. The prompt only allows a stance when the
text itself signals one, and forbids forecasting what the RBI will do. Everything here is best effort: a page that cannot be
read, a model that fails or no key all just leave an item without a summary - the report never fails because of this.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

import requests

from app.adapters.db.models import RbiReadAttempt, RbiSummary
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

# An item that cannot be read (page down or unreadable, model failing) is not retried every morning forever: after a failure it
# waits, and after MAX_ATTEMPTS failures it is left alone. The waits are a little short of whole days so the daily 08:45 job
# is not skipped by a few seconds of drift: 1st failure -> next day, 2nd -> two days, 3rd -> four days, 4th -> given up.
MAX_ATTEMPTS = 4
_RETRY_AFTER_HOURS = {1: 12, 2: 36, 3: 84}

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


def text_hash(text: str) -> str:
    """Identifies an item's TEXT, whatever url it was published under (RBI can put the same address on a speech page and a press
    release): lower-cased, whitespace-collapsed, with the page's "Date : Oct 03, 2026" header dropped."""
    body = re.sub(r"^\s*date\s*:\s*[a-z]{3,9}\s+\d{1,2},\s*\d{4}\s*", "", text.lower())
    return hashlib.sha256(re.sub(r"\s+", " ", body).strip().encode("utf-8")).hexdigest()


def _may_try(attempt: Optional[RbiReadAttempt], now: datetime) -> bool:
    """Whether a previously failed item is due another go."""
    if attempt is None:
        return True
    if attempt.attempts >= MAX_ATTEMPTS:
        return False
    wait = timedelta(hours=_RETRY_AFTER_HOURS.get(attempt.attempts, _RETRY_AFTER_HOURS[3]))
    return now - attempt.last_attempt_at >= wait


def _record_failure(db, url: str, error: str) -> None:
    row = db.get(RbiReadAttempt, url)
    if row is None:
        row = RbiReadAttempt(url=url, attempts=0)
        db.add(row)
    row.attempts = (row.attempts or 0) + 1
    row.last_attempt_at = datetime.now(timezone.utc)
    row.last_error = error[:300]
    db.commit()


def _clean(s: str) -> str:
    """The text (and the model's quotes of it) carry narrow no-break spaces and other odd spacing; show plain spaces."""
    return re.sub(r"\s+", " ", re.sub(r"[\u202f\u00a0\u2009]", " ", s)).strip()


def _as_dict(row: RbiSummary) -> dict:
    return {"text": row.summary, "stance": row.stance, "rates": row.rates or None, "model": row.model}


def _same_text(db, h: str) -> Optional[RbiSummary]:
    return db.query(RbiSummary).filter(RbiSummary.text_hash == h).first()


def attach_summaries(items: list[dict], api_key: Optional[str]) -> list[dict]:
    """Adds `summary` to the newest READ_NEWEST items: the stored one when this item was read before, else a fresh read
    (needs `api_key`). Returns the same list; an item that could not be summarised simply has no `summary` key.

    Each item is processed once:
      * a stored summary for the url is reused (no fetch, no model call);
      * a new url whose TEXT matches an item already summarised (the same address under another url) copies that summary
        (a fetch, but no model call);
      * an item that failed recently waits before it is tried again, and is dropped after MAX_ATTEMPTS failures."""
    db = SessionLocal()
    try:
        for item in items[:READ_NEWEST]:
            url = item.get("url")
            if not url:
                continue
            try:
                row = db.get(RbiSummary, url)
                if row is None and api_key:
                    row = _read_new(db, item, api_key)
                if row is not None:
                    item["summary"] = _as_dict(row)
            except Exception as exc:
                db.rollback()
                logger.warning("rbi_reader: no summary for %s: %s", url, exc)
    finally:
        db.close()
    return items


def _read_new(db, item: dict, api_key: str) -> Optional[RbiSummary]:
    """Fetch, (reuse or) summarise and store one unseen item. Returns its row, or None after recording why it could not be read."""
    url = item["url"]
    if not _may_try(db.get(RbiReadAttempt, url), datetime.now(timezone.utc)):
        return None
    text = fetch_text(url)
    if not text:
        _record_failure(db, url, "page could not be read or was too short")
        return None
    h = text_hash(text)
    twin = _same_text(db, h)
    try:
        if twin is not None:
            fields = dict(stance=twin.stance, summary=twin.summary, rates=twin.rates, model=twin.model)
        else:
            model = ai_models.model_for("rbi_summary")
            got = summarise(item["title"], text, api_key, model)
            fields = dict(stance=got["stance"], summary=_tidy(got["summary"], SUMMARY_MAX_CHARS), rates=_tidy(got.get("rates") or "", RATES_MAX_CHARS) or None, model=model)
    except Exception as exc:
        db.rollback()
        _record_failure(db, url, f"{type(exc).__name__}: {exc}")
        raise
    row = RbiSummary(url=url, kind=item["kind"], title=item["title"], published=_parse_dt(item.get("published")), text_hash=h, read_at=datetime.now(timezone.utc), **fields)
    db.add(row)
    stale = db.get(RbiReadAttempt, url)
    if stale is not None:
        db.delete(stale)  # it worked after all
    db.commit()
    return row


def _parse_dt(iso: Optional[str]) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(iso) if iso else None
    except ValueError:
        return None
