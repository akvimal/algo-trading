import base64
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.api.routes import ideas as route
from app.auth import require_admin
from app.config import settings
from app.domain import ideas, telegram_api
from app.domain.telegram_api import TgResult

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64
ADMIN = uuid4()
NOTE = uuid4()
CHAT = "-1001234567890"


def make_idea(**over):
    base = dict(note_id=NOTE, segment="NSE", symbol="NIFTY", interval="15min", tag="plan", text="Watching 23,100 for a retest.", context=None, include_context=True, image=None)
    base.update(over)
    return ideas.Idea(**base)


class FakeDB:
    """Just enough Session: get / add / commit for the two ideas tables."""

    def __init__(self, chat=CHAT, published=None):
        self.dest = SimpleNamespace(telegram_chat_id=chat) if chat else None
        self.rows = {NOTE: published} if published else {}
        self.commits = 0

    def get(self, model, key):
        return self.dest if model is route.IdeasDestination else self.rows.get(key)

    def add(self, row):
        if isinstance(row, route.IdeasDestination):
            self.dest = row
        else:
            self.rows[row.note_id] = row

    def commit(self):
        self.commits += 1


class FakeTelegram:
    def __init__(self, monkeypatch, fail_on=None, fail_delete=False):
        self.sent, self.deleted, self.fail_on, self.fail_delete, self._id = [], [], fail_on, fail_delete, 100
        monkeypatch.setattr(settings, "telegram_ideas_bot_token", "TOKEN")
        monkeypatch.setattr(telegram_api, "send_message", self.message)
        monkeypatch.setattr(telegram_api, "send_photo", self.photo)
        monkeypatch.setattr(telegram_api, "delete_message", self.delete)

    def _next(self, kind, body):
        if self.fail_on is not None and len(self.sent) == self.fail_on:
            return TgResult(False, error="the bot is not allowed to post there")
        self._id += 1
        self.sent.append((kind, body))
        return TgResult(True, message_id=self._id)

    def message(self, token, chat, text):
        return self._next("text", text)

    def photo(self, token, chat, png, caption):
        return self._next("photo", caption)

    def delete(self, token, chat, mid):
        if self.fail_delete:
            return TgResult(False, error="message can't be deleted")
        self.deleted.append(mid)
        return TgResult(True)


# ---- the disclaimer is on every post ------------------------------------------------------------------------------------


def test_every_post_ends_with_the_disclaimer_whatever_the_note_or_options():
    for idea in (make_idea(), make_idea(include_context=False), make_idea(context={"price": 23100}), make_idea(text="x" * 500), make_idea(tag="observation")):
        assert ideas.build_text(idea).endswith(ideas.DEFAULT_DISCLAIMER)


def test_the_default_disclaimer_says_it_is_not_advice_and_claims_no_registration():
    d = ideas.DEFAULT_DISCLAIMER.lower()
    assert "not investment advice" in d and "sebi-registered adviser" in d and "risk" in d
    assert "registered research analyst" not in d and "we are registered" not in d  # it must not assert a status nobody has confirmed


def test_the_disclaimer_and_a_registration_line_can_be_set_and_still_come_last(monkeypatch):
    monkeypatch.setattr(settings, "ideas_disclaimer", "Custom notice.")
    monkeypatch.setattr(settings, "ideas_registration_line", "SEBI Reg. No. INH000000000")
    assert ideas.build_text(make_idea()).endswith("Custom notice.\nSEBI Reg. No. INH000000000")


def test_every_message_that_is_sent_carries_the_disclaimer_in_each_layout(monkeypatch):
    tg = FakeTelegram(monkeypatch)
    ctx = {"price": 23140.5, "regime": {"regime": "trending_up", "adx": 31.2}, "structure_trend": {"15m": "up", "1h": "range"}, "oi": {"pcr": 0.84}}
    layouts = [make_idea(), make_idea(context=ctx, image=PNG), make_idea(text="y" * 500, context=ctx, image=PNG)]
    for i, idea in enumerate(layouts):
        ideas.publish(FakeDB(), ADMIN, idea.__class__(**{**idea.__dict__, "note_id": uuid4()}))
    full_posts = [body for kind, body in tg.sent if len(body) > 200]
    assert full_posts and all(b.endswith(ideas.DEFAULT_DISCLAIMER) for b in full_posts)
    assert all(ideas.DEFAULT_DISCLAIMER in body for kind, body in tg.sent if kind == "text")  # a text message is always the whole post


# ---- what is and is not published ---------------------------------------------------------------------------------------------


def test_the_context_line_comes_from_an_allow_list_and_never_includes_the_position_or_the_ai_read():
    ctx = {
        "price": 23140.5, "interval": "15min", "regime": {"regime": "trending_up", "adx": 31.2, "atr_percentile": 70},
        "structure_trend": {"15m": "up", "1h": "range"}, "oi": {"pcr": 0.84, "call_buildup": "long_buildup"},
        "ai_read": {"bias": "bullish", "confidence": 80, "one_liner": "SECRET AI VIEW"}, "holding": "long 50 NIFTY @ 23,000",
    }
    line = ideas.context_line(ctx)
    assert line == "Price 23,140.50 · Trending up · ADX 31 · 15m up · 1h sideways · PCR 0.84"
    post = ideas.build_text(make_idea(context=ctx))
    for private in ("holding", "long 50", "SECRET AI VIEW", "bullish", "long_buildup"):
        assert private not in post


def test_junk_in_the_context_is_ignored_not_trusted():
    assert ideas.context_line({"price": "23100", "regime": "up", "structure_trend": {"x" * 20: "up"}, "oi": {"pcr": True}}) == ""
    assert ideas.context_line(None) == "" and ideas.context_line("price") == ""


def test_the_market_line_can_be_left_out():
    assert "Price" not in ideas.build_text(make_idea(context={"price": 23100}, include_context=False))


def test_only_plan_and_observation_notes_can_be_published():
    for ok in ("plan", "observation"):
        ideas.check_publishable(make_idea(tag=ok))
    for private in ("mistake", "review", "", "anything"):
        with pytest.raises(ideas.IdeaError) as e:
            ideas.check_publishable(make_idea(tag=private))
        assert e.value.status == 422


def test_an_empty_or_overlong_note_is_refused():
    for text in ("   ", "x" * (ideas.NOTE_MAX + 1)):
        with pytest.raises(ideas.IdeaError):
            ideas.check_publishable(make_idea(text=text))


def test_the_post_header_names_the_instrument_interval_and_type():
    assert ideas.header(make_idea()) == "💡 NIFTY · 15m · plan"
    assert ideas.header(make_idea(interval=None, tag="observation")) == "💡 NIFTY · observation"


# ---- how it goes out ------------------------------------------------------------------------------------------------------------


def test_a_text_post_is_one_message():
    plan = ideas.plan_post(make_idea())
    assert [k for k, _ in plan.messages] == ["text"]


def test_a_photo_post_that_fits_a_caption_is_one_photo_with_the_whole_post(monkeypatch):
    monkeypatch.setattr(settings, "ideas_disclaimer", "Short notice.")
    plan = ideas.plan_post(make_idea(image=PNG))
    assert plan.messages == [("photo", plan.text)] and len(plan.text) <= ideas.CAPTION_MAX


LONG_NOTICE = "Long custom notice. " * 30  # 600 characters: a registration-style disclaimer, which is what pushes a post past a caption


def test_the_default_disclaimer_and_a_full_length_note_still_fit_one_photo_caption():
    plan = ideas.plan_post(make_idea(image=PNG, text="z" * 500, context={"price": 23140.5, "regime": {"regime": "trending_up", "adx": 31.2}, "structure_trend": {"15m": "up", "1h": "range"}, "oi": {"pcr": 0.84}}))
    assert [k for k, _ in plan.messages] == ["photo"] and len(plan.text) <= ideas.CAPTION_MAX


def test_a_photo_post_too_long_for_a_caption_is_a_photo_with_a_header_then_the_full_text(monkeypatch):
    monkeypatch.setattr(settings, "ideas_disclaimer", LONG_NOTICE)
    plan = ideas.plan_post(make_idea(image=PNG, text="z" * 500))
    assert [k for k, _ in plan.messages] == ["photo", "text"]
    assert plan.messages[0][1] == ideas.header(make_idea()) and plan.messages[1][1] == plan.text and plan.text.endswith(LONG_NOTICE.strip())


def test_images_are_decoded_and_checked():
    assert ideas.decode_image(None) is None and ideas.decode_image("") is None
    assert ideas.decode_image(base64.b64encode(PNG).decode()) == PNG
    assert ideas.decode_image("data:image/png;base64," + base64.b64encode(PNG).decode()) == PNG
    for bad in ("not base64!!", base64.b64encode(b"GIF89a....").decode()):
        with pytest.raises(ideas.IdeaError) as e:
            ideas.decode_image(bad)
        assert e.value.status == 422
    with pytest.raises(ideas.IdeaError):
        ideas.decode_image(base64.b64encode(b"\x89PNG" + b"0" * (ideas.MAX_IMAGE_BYTES + 1)).decode())


# ---- publishing and unpublishing ----------------------------------------------------------------------------------------------


def test_publishing_posts_the_text_and_records_what_was_sent(monkeypatch):
    tg, db = FakeTelegram(monkeypatch), FakeDB()
    row = ideas.publish(db, ADMIN, make_idea())
    assert tg.sent[0][0] == "text" and row.message_ids == [101] and row.chat_id == CHAT and row.published_by == ADMIN
    assert row.text == tg.sent[0][1] and row.unpublished_at is None and db.commits == 1


def test_nothing_is_posted_when_the_bot_or_destination_is_not_set_up(monkeypatch):
    tg = FakeTelegram(monkeypatch)
    monkeypatch.setattr(settings, "telegram_ideas_bot_token", "")
    with pytest.raises(ideas.IdeaError) as e:
        ideas.publish(FakeDB(), ADMIN, make_idea())
    assert e.value.status == 503
    monkeypatch.setattr(settings, "telegram_ideas_bot_token", "TOKEN")
    with pytest.raises(ideas.IdeaError) as e:
        ideas.publish(FakeDB(chat=None), ADMIN, make_idea())
    assert e.value.status == 400 and tg.sent == []


def test_a_note_cannot_be_published_twice_at_once(monkeypatch):
    FakeTelegram(monkeypatch)
    db = FakeDB()
    ideas.publish(db, ADMIN, make_idea())
    with pytest.raises(ideas.IdeaError) as e:
        ideas.publish(db, ADMIN, make_idea())
    assert e.value.status == 409


def test_a_private_note_is_refused_before_anything_is_sent(monkeypatch):
    tg = FakeTelegram(monkeypatch)
    with pytest.raises(ideas.IdeaError):
        ideas.publish(FakeDB(), ADMIN, make_idea(tag="mistake"))
    assert tg.sent == []


def test_a_failed_post_stores_nothing_and_says_why(monkeypatch):
    tg, db = FakeTelegram(monkeypatch, fail_on=0), FakeDB()
    with pytest.raises(ideas.IdeaError) as e:
        ideas.publish(db, ADMIN, make_idea())
    assert e.value.status == 502 and "not allowed to post there" in e.value.detail
    assert db.rows == {} and db.commits == 0


def test_if_the_second_message_fails_the_first_is_taken_back_down(monkeypatch):
    monkeypatch.setattr(settings, "ideas_disclaimer", LONG_NOTICE)
    tg, db = FakeTelegram(monkeypatch, fail_on=1), FakeDB()
    with pytest.raises(ideas.IdeaError):
        ideas.publish(db, ADMIN, make_idea(image=PNG, text="z" * 500))
    assert tg.deleted == [101] and db.rows == {}  # no half a post left in the channel


def test_unpublishing_deletes_every_message_and_allows_publishing_again(monkeypatch):
    monkeypatch.setattr(settings, "ideas_disclaimer", LONG_NOTICE)
    tg, db = FakeTelegram(monkeypatch), FakeDB()
    row = ideas.publish(db, ADMIN, make_idea(image=PNG, text="z" * 500))
    assert row.message_ids == [101, 102]
    out = ideas.unpublish(db, NOTE)
    assert tg.deleted == [101, 102] and out.unpublished_at is not None
    again = ideas.publish(db, ADMIN, make_idea())
    assert again.unpublished_at is None and again.message_ids == [103]


def test_when_telegram_refuses_to_delete_the_post_stays_published_unless_forced(monkeypatch):
    FakeTelegram(monkeypatch, fail_delete=True)
    db = FakeDB()
    ideas.publish(db, ADMIN, make_idea())
    with pytest.raises(ideas.IdeaError) as e:
        ideas.unpublish(db, NOTE)
    assert e.value.status == 409 and "delete it in Telegram yourself" in e.value.detail
    assert db.rows[NOTE].unpublished_at is None
    assert ideas.unpublish(db, NOTE, force=True).unpublished_at is not None


def test_unpublishing_something_not_published_is_a_404(monkeypatch):
    FakeTelegram(monkeypatch)
    with pytest.raises(ideas.IdeaError) as e:
        ideas.unpublish(FakeDB(), NOTE)
    assert e.value.status == 404


# ---- the routes -------------------------------------------------------------------------------------------------------------------


def test_every_ideas_route_is_admin_only():
    guarded = {}
    for r in route.router.routes:
        guarded[(r.path, tuple(sorted(r.methods)))] = require_admin in {d.call for d in r.dependant.dependencies}
    assert guarded and all(guarded.values()), f"not admin-only: {[k for k, v in guarded.items() if not v]}"
    assert len(guarded) == 7


def payload(**over):
    base = dict(note_id=NOTE, segment="NSE", symbol=" nifty ", interval="15min", tag="plan", text="Watching 23,100.", context={"price": 23100, "holding": "long 50"}, include_context=True)
    base.update(over)
    return route.IdeaIn(**base)


def test_preview_shows_exactly_what_will_be_sent_with_the_disclaimer_and_without_the_position(monkeypatch):
    monkeypatch.setattr(settings, "telegram_ideas_bot_token", "TOKEN")
    out = route.preview(payload(snapshot_png_base64=base64.b64encode(PNG).decode()), FakeDB(), ADMIN)
    assert out.text.startswith("💡 NIFTY · 15m · plan") and out.text.endswith(ideas.DEFAULT_DISCLAIMER)
    assert "holding" not in out.text and "long 50" not in out.text
    assert out.has_image and out.messages == 1 and out.destination_hint == "…7890"  # one photo carrying the whole post
    monkeypatch.setattr(settings, "ideas_disclaimer", LONG_NOTICE)
    assert route.preview(payload(text="z" * 500, snapshot_png_base64=base64.b64encode(PNG).decode()), FakeDB(), ADMIN).messages == 2


def test_preview_and_publish_agree_on_the_text(monkeypatch):
    tg = FakeTelegram(monkeypatch)
    shown = route.preview(payload(), FakeDB(), ADMIN).text
    route.publish(payload(), FakeDB(), ADMIN)
    assert tg.sent[0][1] == shown


def test_the_routes_turn_refusals_into_http_errors(monkeypatch):
    FakeTelegram(monkeypatch)
    for call in (lambda: route.publish(payload(tag="mistake"), FakeDB(), ADMIN), lambda: route.preview(payload(text="  "), FakeDB(), ADMIN), lambda: route.publish(payload(snapshot_png_base64="@@@"), FakeDB(), ADMIN)):
        with pytest.raises(HTTPException) as e:
            call()
        assert e.value.status_code == 422


def test_the_destination_must_look_like_a_chat_id_or_channel_name():
    db = FakeDB(chat=None)
    for bad in ("hello", "12", "@ab", "https://t.me/x"):
        with pytest.raises(HTTPException) as e:
            route.set_destination(route.DestinationIn(telegram_chat_id=bad), db, ADMIN)
        assert e.value.status_code == 422
    for good in ("-1001234567890", "123456789", "@my_ideas_channel"):
        route.set_destination(route.DestinationIn(telegram_chat_id=good), FakeDB(chat=None), ADMIN)


def test_the_config_reports_the_disclaimer_that_will_be_used_and_hides_the_chat_id(monkeypatch):
    monkeypatch.setattr(settings, "telegram_ideas_bot_token", "TOKEN")
    cfg = route.get_config(FakeDB(), ADMIN)
    assert cfg.bot_configured and cfg.destination_set and cfg.destination_hint == "…7890" and cfg.disclaimer == ideas.DEFAULT_DISCLAIMER
    assert CHAT not in cfg.model_dump_json()
