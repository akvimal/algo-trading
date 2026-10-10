"""Publishing notes as ideas to a Telegram channel/group through a separate bot (app/domain/ideas.py).

Admin only, end to end: the operator publishes their own ideas to a destination they set; no other user can see or call any of this.
The server builds the post itself (the disclaimer, the allow-listed context line, the tag rule), so what is previewed is what is sent."""

import re
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.adapters.db.models import IdeasDestination, PublishedIdea
from app.adapters.db.session import get_db
from app.auth import require_admin
from app.config import settings
from app.domain import ideas, telegram_api

router = APIRouter()

_DEST_RE = re.compile(r"^(-?\d{3,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$")  # a numeric chat id, or a public channel's @name


def _fail(e: ideas.IdeaError) -> HTTPException:
    return HTTPException(status_code=e.status, detail=e.detail)


class TradeIn(BaseModel):
    """A closed trade to show with the idea. Only these fields exist and anything else is refused (extra="forbid"): a client that
    sends a quantity, lots, a rupee P&L or charges gets a 422 rather than having them quietly dropped or, worse, published."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    kind: Literal["position", "group"]
    label: str = Field(min_length=1, max_length=80)
    side: Literal["BUY", "SELL"]
    live: bool
    entry: Optional[float] = Field(default=None, gt=0, lt=1e9)
    stop: Optional[float] = Field(default=None, gt=0, lt=1e9)
    target: Optional[float] = Field(default=None, gt=0, lt=1e9)
    exit: Optional[float] = Field(default=None, gt=0, lt=1e9)
    exit_reason: Optional[str] = Field(default=None, max_length=30)
    result_pct: Optional[float] = Field(default=None, ge=-100, le=100000)


Bias = Literal["bullish", "bearish", "neutral"]


class AnalysisLevelIn(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    low: float = Field(gt=0, lt=1e9)
    high: float = Field(gt=0, lt=1e9)
    distance_pct: float = Field(ge=0, le=1000)


class AnalysisIn(BaseModel):
    """An AI analysis of the stock to show with the idea (see ideas.Analysis). Only these fields exist and anything else is refused
    (extra="forbid"); the post's wording is written by the server from them, and each text is trimmed there."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    verdict: str = Field(min_length=1, max_length=300)
    agreement: Literal["aligned", "mixed", "conflicting", "technical_only"]
    overall: Bias
    overall_strength: Optional[Literal["strong", "moderate", "slight"]] = None
    chart_bias: Bias
    chart_points: list[str] = Field(default_factory=list, max_length=8)
    price: Optional[float] = Field(default=None, gt=0, lt=1e9)
    as_of: Optional[str] = Field(default=None, max_length=12)
    business_bias: Optional[Bias] = None
    business_confidence: Optional[float] = Field(default=None, ge=0, le=1)
    business_summary: Optional[str] = Field(default=None, max_length=1000)
    pros: list[str] = Field(default_factory=list, max_length=8)
    cons: list[str] = Field(default_factory=list, max_length=8)
    support: Optional[AnalysisLevelIn] = None
    resistance: Optional[AnalysisLevelIn] = None


class IdeaIn(BaseModel):
    note_id: UUID
    segment: Literal["NSE", "MCX", "CRYPTO"]
    symbol: str = Field(min_length=1, max_length=40)
    interval: Optional[str] = Field(default=None, max_length=12)
    tag: str = Field(max_length=20)
    text: str = Field(max_length=2000)  # checked against the note limit in ideas.check_publishable, with a clearer message
    context: Optional[dict] = None
    include_context: bool = True
    snapshot_png_base64: Optional[str] = None
    trade: Optional[TradeIn] = None
    analysis: Optional[AnalysisIn] = None


class DestinationIn(BaseModel):
    telegram_chat_id: str


class ConfigOut(BaseModel):
    bot_configured: bool
    destination_set: bool
    destination_hint: Optional[str] = None
    disclaimer: str


class PreviewOut(BaseModel):
    text: str
    messages: int  # how many Telegram messages it goes out as
    has_image: bool
    destination_hint: Optional[str] = None
    disclaimer: str = ""  # the closing notice inside `text`, so a screen can show it in a smaller type


class PublishedOut(BaseModel):
    note_id: UUID
    published: bool  # False once unpublished
    published_at: Optional[str] = None
    unpublished_at: Optional[str] = None
    destination_hint: Optional[str] = None
    has_image: bool = False


def _hint(chat: Optional[str]) -> Optional[str]:
    return None if not chat else (chat if chat.startswith("@") else f"…{chat[-4:]}")


def _analysis(a: Optional[AnalysisIn]) -> Optional[ideas.Analysis]:
    if a is None:
        return None
    data = a.model_dump()
    for key in ("support", "resistance"):
        data[key] = ideas.AnalysisLevel(**data[key]) if data[key] else None
    return ideas.Analysis(**data)


def _idea(payload: IdeaIn) -> ideas.Idea:
    try:
        image = ideas.decode_image(payload.snapshot_png_base64)
    except ideas.IdeaError as e:
        raise _fail(e)
    return ideas.Idea(
        note_id=payload.note_id, segment=payload.segment, symbol=payload.symbol.strip().upper(), interval=payload.interval,
        tag=payload.tag, text=payload.text, context=payload.context, include_context=payload.include_context, image=image,
        trade=ideas.Trade(**payload.trade.model_dump()) if payload.trade else None,
        analysis=_analysis(payload.analysis),
    )


def _out(row: PublishedIdea) -> PublishedOut:
    return PublishedOut(
        note_id=row.note_id, published=row.unpublished_at is None, published_at=row.published_at.isoformat() if row.published_at else None,
        unpublished_at=row.unpublished_at.isoformat() if row.unpublished_at else None, destination_hint=_hint(row.chat_id), has_image=bool(row.has_image),
    )


@router.get("/ideas/config", response_model=ConfigOut)
def get_config(db: Session = Depends(get_db), _admin: UUID = Depends(require_admin)):
    chat = ideas.destination(db)
    return ConfigOut(bot_configured=bool(settings.telegram_ideas_bot_token), destination_set=bool(chat), destination_hint=_hint(chat), disclaimer=ideas.disclaimer())


@router.put("/ideas/destination", response_model=ConfigOut)
def set_destination(payload: DestinationIn, db: Session = Depends(get_db), admin: UUID = Depends(require_admin)):
    """Where ideas are posted: a numeric chat id (a group's or channel's starts with a minus sign) or a public channel's @name. The bot
    must be in it as an admin able to post. An empty value clears it."""
    chat = payload.telegram_chat_id.strip()
    row = db.get(IdeasDestination, 1)
    if not chat:
        if row is not None:
            db.delete(row)
            db.commit()
        return get_config(db, admin)
    if not _DEST_RE.match(chat):
        raise HTTPException(status_code=422, detail="Use the channel's numeric id (it starts with -100 for a channel) or its @name.")
    if row is None:
        db.add(IdeasDestination(id=1, telegram_chat_id=chat, updated_by=admin))
    else:
        row.telegram_chat_id, row.updated_by = chat, admin
    db.commit()
    return get_config(db, admin)


@router.post("/ideas/preview", response_model=PreviewOut)
def preview(payload: IdeaIn, db: Session = Depends(get_db), _admin: UUID = Depends(require_admin)):
    """Exactly what would be posted, with the disclaimer and the allow-listed context, and how many messages it goes out as."""
    idea = _idea(payload)
    try:
        ideas.check_publishable(idea)
        plan = ideas.plan_post(idea)
    except ideas.IdeaError as e:
        raise _fail(e)
    return PreviewOut(text=plan.text, messages=len(plan.messages), has_image=idea.image is not None, destination_hint=_hint(ideas.destination(db)), disclaimer=ideas.disclaimer())


@router.post("/ideas/publish", response_model=PublishedOut)
def publish(payload: IdeaIn, db: Session = Depends(get_db), admin: UUID = Depends(require_admin)):
    try:
        return _out(ideas.publish(db, admin, _idea(payload)))
    except ideas.IdeaError as e:
        raise _fail(e)


@router.post("/ideas/{note_id}/unpublish", response_model=PublishedOut)
def unpublish(note_id: UUID, force: bool = False, db: Session = Depends(get_db), _admin: UUID = Depends(require_admin)):
    try:
        return _out(ideas.unpublish(db, note_id, force))
    except ideas.IdeaError as e:
        raise _fail(e)


@router.get("/ideas/published", response_model=list[PublishedOut])
def published(note_ids: str = Query("", description="Comma-separated note ids"), db: Session = Depends(get_db), _admin: UUID = Depends(require_admin)):
    """The publish state of the given notes (only notes that have been published at some point are returned)."""
    ids = []
    for part in note_ids.split(","):
        try:
            ids.append(UUID(part.strip()))
        except ValueError:
            continue
    if not ids:
        return []
    return [_out(r) for r in db.query(PublishedIdea).filter(PublishedIdea.note_id.in_(ids[:200])).all()]


@router.post("/ideas/test")
def test_post(db: Session = Depends(get_db), _admin: UUID = Depends(require_admin)):
    """Posts a short line (with the disclaimer) to the destination, to check the bot can post there. It IS a real post."""
    try:
        token, chat = ideas._ready(db)
    except ideas.IdeaError as e:
        raise _fail(e)
    result = telegram_api.send_message(token, chat, f"Test post from the ideas bot - please ignore.\n\n{ideas.disclaimer()}")
    if not result.ok:
        raise HTTPException(status_code=502, detail=f"Could not post: {result.error}.")
    return {"sent": True}
