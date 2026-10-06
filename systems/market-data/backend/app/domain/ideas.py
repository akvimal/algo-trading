"""Publishing a note as an "idea" to a Telegram channel or group, through a SEPARATE bot (settings.telegram_ideas_bot_token) from the
private alerts bot.

Who and what, by design:
  * Only an admin (the operator) publishes, to one destination the operator sets. It is not offered to other users.
  * Only "plan" and "observation" notes can be published; "mistake" and "review" are private by nature.
  * Every post ends with a disclaimer, appended HERE on the server, so no client, preview or code path can send a post without it.
    The wording is configurable (IDEAS_DISCLAIMER) and an optional registration line (IDEAS_REGISTRATION_LINE, for example a SEBI
    registration number) is appended after it; the default is a general "not advice" notice and should be reviewed by counsel
    before the audience widens - it does not assert any registration status.
  * The context line is built from an allow-list of the note's market context (price, regime, trend, PCR). The position held
    (`holding`) and the AI read are NEVER published, whatever the client sends.
  * Each note is published once; it can be unpublished (the message is deleted) and then published again.
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.adapters.db.models import IdeasDestination, PublishedIdea
from app.config import settings
from app.domain import telegram_api

PUBLISHABLE_TAGS = ("plan", "observation")
NOTE_MAX = 500
CAPTION_MAX = 1024  # Telegram's limit for a photo caption
MESSAGE_MAX = 4096
MAX_IMAGE_BYTES = 4_000_000

DEFAULT_DISCLAIMER = (
    "Disclaimer: Personal study note shared for education and information only. Not investment advice, a recommendation, or an "
    "offer to buy or sell any security or derivative. Markets involve risk, including loss of capital; past performance does not "
    "indicate future results. Do your own research or consult a SEBI-registered adviser before acting."
)

_REGIME_WORD = {"trending_up": "Trending up", "trending_down": "Trending down", "ranging": "Ranging", "transitional": "Changing"}


class IdeaError(Exception):
    """A refusal or failure with a status code and a message the person can act on."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


@dataclass
class Idea:
    note_id: UUID
    segment: str
    symbol: str
    interval: Optional[str]
    tag: str
    text: str
    context: Optional[dict]
    include_context: bool
    image: Optional[bytes]


def disclaimer() -> str:
    text = (settings.ideas_disclaimer or "").strip() or DEFAULT_DISCLAIMER
    reg = (settings.ideas_registration_line or "").strip()
    return f"{text}\n{reg}" if reg else text


def _num(v) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def context_line(ctx: Optional[dict]) -> str:
    """What the market looked like, from the allow-list only. Anything else in `ctx` (holding, ai_read, oi buildup...) is ignored."""
    if not isinstance(ctx, dict):
        return ""
    parts = []
    price = _num(ctx.get("price"))
    if price is not None:
        parts.append(f"Price {price:,.2f}")
    regime = ctx.get("regime")
    if isinstance(regime, dict) and isinstance(regime.get("regime"), str):
        adx = _num(regime.get("adx"))
        parts.append(_REGIME_WORD.get(regime["regime"], regime["regime"]) + (f" · ADX {adx:.0f}" if adx is not None else ""))
    trend = ctx.get("structure_trend")
    if isinstance(trend, dict):
        for tf, t in trend.items():
            if isinstance(tf, str) and isinstance(t, str) and len(tf) <= 8 and len(t) <= 12:
                parts.append(f"{tf} {'sideways' if t == 'range' else t}")
    oi = ctx.get("oi")
    pcr = _num(oi.get("pcr")) if isinstance(oi, dict) else None
    if pcr is not None:
        parts.append(f"PCR {pcr:.2f}")
    return " · ".join(parts)


def _interval_word(interval: Optional[str]) -> str:
    return interval.replace("min", "m") if interval else ""


def header(idea: Idea) -> str:
    return " · ".join(p for p in (f"💡 {idea.symbol}", _interval_word(idea.interval), idea.tag) if p)


def build_text(idea: Idea) -> str:
    """The whole post as text: header, the note, the market line (if asked for) and the disclaimer."""
    blocks = [header(idea), idea.text.strip()]
    if idea.include_context:
        line = context_line(idea.context)
        if line:
            blocks.append(line)
    blocks.append(disclaimer())
    return "\n\n".join(blocks)


@dataclass
class Plan:
    """How the post goes out: one text message, one photo with the whole post as its caption, or (when that would not fit a caption)
    a photo captioned with the header followed by the full text."""

    messages: list[tuple[str, str]]  # ("text" | "photo", body)
    text: str


def plan_post(idea: Idea) -> Plan:
    text = build_text(idea)
    if len(text) > MESSAGE_MAX:
        raise IdeaError(422, "That post is too long for Telegram.")
    if idea.image is None:
        return Plan([("text", text)], text)
    if len(text) <= CAPTION_MAX:
        return Plan([("photo", text)], text)
    return Plan([("photo", header(idea)), ("text", text)], text)


def decode_image(data: Optional[str]) -> Optional[bytes]:
    """A chart snapshot sent as base64 (with or without a data: URL prefix). None when there is none; 422 when it is not a PNG."""
    if not data:
        return None
    raw = re.sub(r"^data:image/[a-z]+;base64,", "", data.strip())
    try:
        png = base64.b64decode(raw, validate=True)
    except ValueError:
        raise IdeaError(422, "The chart snapshot could not be read.")
    if not png.startswith(b"\x89PNG"):
        raise IdeaError(422, "The chart snapshot is not a PNG image.")
    if len(png) > MAX_IMAGE_BYTES:
        raise IdeaError(422, "The chart snapshot is too large to send.")
    return png


def check_publishable(idea: Idea) -> None:
    if idea.tag not in PUBLISHABLE_TAGS:
        raise IdeaError(422, f"Only {' and '.join(PUBLISHABLE_TAGS)} notes can be published; '{idea.tag}' notes stay private.")
    text = idea.text.strip()
    if not text:
        raise IdeaError(422, "The note is empty.")
    if len(text) > NOTE_MAX:
        raise IdeaError(422, f"The note is longer than {NOTE_MAX} characters.")


def destination(db: Session) -> Optional[str]:
    row = db.get(IdeasDestination, 1)
    return row.telegram_chat_id if row else None


def _ready(db: Session) -> tuple[str, str]:
    token = settings.telegram_ideas_bot_token
    if not token:
        raise IdeaError(503, "The ideas bot is not set up on this server (TELEGRAM_IDEAS_BOT_TOKEN).")
    chat = destination(db)
    if not chat:
        raise IdeaError(400, "Set the ideas channel first.")
    return token, chat


def get_published(db: Session, note_id: UUID) -> Optional[PublishedIdea]:
    return db.get(PublishedIdea, note_id)


def publish(db: Session, user_id: UUID, idea: Idea) -> PublishedIdea:
    check_publishable(idea)
    token, chat = _ready(db)
    existing = get_published(db, idea.note_id)
    if existing is not None and existing.unpublished_at is None:
        raise IdeaError(409, "This note is already published. Unpublish it first to post it again.")
    plan = plan_post(idea)

    sent: list[int] = []
    for kind, body in plan.messages:
        result = telegram_api.send_photo(token, chat, idea.image, body) if kind == "photo" else telegram_api.send_message(token, chat, body)
        if not result.ok or result.message_id is None:
            for mid in sent:  # do not leave half a post in the channel
                telegram_api.delete_message(token, chat, mid)
            raise IdeaError(502, f"Could not post: {result.error or 'no message id returned'}.")
        sent.append(result.message_id)

    row = existing or PublishedIdea(note_id=idea.note_id)
    row.published_by, row.chat_id, row.message_ids, row.text = user_id, chat, sent, plan.text
    row.has_image = idea.image is not None
    row.published_at, row.unpublished_at = datetime.now(timezone.utc), None
    db.add(row)
    db.commit()
    return row


def unpublish(db: Session, note_id: UUID, force: bool = False) -> PublishedIdea:
    """Delete the post from the channel and mark it unpublished. Telegram only lets a bot delete its messages for a limited time
    (about 48 hours); when it refuses, `force` records it as unpublished anyway so the person can delete the message by hand."""
    row = get_published(db, note_id)
    if row is None or row.unpublished_at is not None:
        raise IdeaError(404, "This note is not published.")
    token = settings.telegram_ideas_bot_token
    if not token:
        raise IdeaError(503, "The ideas bot is not set up on this server (TELEGRAM_IDEAS_BOT_TOKEN).")
    failures = [r.error for mid in row.message_ids if not (r := telegram_api.delete_message(token, row.chat_id, mid)).ok]
    if failures and not force:
        raise IdeaError(409, f"Telegram would not delete it ({failures[0]}). If it is old, delete it in Telegram yourself, then mark it unpublished here.")
    row.unpublished_at = datetime.now(timezone.utc)
    db.commit()
    return row
