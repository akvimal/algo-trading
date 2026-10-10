"""Chart snapshots kept with a trade: the plan at entry, later updates, and what rides along with a waiting order or a plan note. Plain fakes, direct calls."""

import asyncio
import base64
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.adapters.db import models as db_models
from app.api.routes import trade_images as route
from app.domain import trade_snapshots as ts
from app.domain.pending_orders import PendingOrderError, link_note_to_position
from tests.test_pending_orders import ALICE, FakeDb, account_state, arm, fake_deps, run  # noqa: F401 - account_state is the watcher's autouse fixture

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64
PNG_B64 = "data:image/png;base64," + base64.b64encode(PNG).decode()


class ImgDb(FakeDb):
    """The pending-orders fake, plus somewhere for trade pictures to land."""

    def __init__(self):
        super().__init__()
        self.images = []

    def add(self, row):
        if isinstance(row, db_models.TradeImage):
            row.id = uuid.uuid4()
            self.images.append(row)
        else:
            super().add(row)

    def get(self, model, key):
        if model is db_models.Position:
            return SimpleNamespace(entry_price=100, stop_loss_price=95, target_price=120)
        return super().get(model, key)


# ---- the helper ------------------------------------------------------------------------------------------------------------------------


def test_a_picture_belongs_to_exactly_one_position_or_spread():
    db = ImgDb()
    with pytest.raises(ValueError):
        ts.add_image(db, data=PNG)
    with pytest.raises(ValueError):
        ts.add_image(db, data=PNG, position_id=uuid.uuid4(), option_group_id=uuid.uuid4())
    with pytest.raises(ValueError):
        ts.add_image(db, data=PNG, position_id=uuid.uuid4(), kind="whatever")
    assert db.images == []


def test_a_picture_keeps_its_kind_caption_and_the_levels_in_force():
    db = ImgDb()
    pid = uuid.uuid4()
    row = ts.add_image(db, data=PNG, position_id=pid, kind="update", caption="  moved the stop to breakeven  ", entry=100, stop=100, target=130)
    assert (row.kind, row.caption, row.position_id) == ("update", "moved the stop to breakeven", pid)
    assert (row.entry_price, row.stop_price, row.target_price) == (100, 100, 130)
    assert ts.add_image(db, data=PNG, position_id=pid, caption="   ").caption is None
    assert len(ts.add_image(db, data=PNG, position_id=pid, caption="x" * 900).caption) == ts.CAPTION_MAX


# ---- the routes ------------------------------------------------------------------------------------------------------------------------


class Upload:
    def __init__(self, data=PNG, content_type="image/png"):
        self.data, self.content_type = data, content_type

    async def read(self):
        return self.data


class RouteDb(ImgDb):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner

    def get(self, model, key):
        return self.owner


ME = SimpleNamespace(id=ALICE)


def upload(db, **kw):
    return asyncio.run(route.upload_position_image(str(uuid.uuid4()), file=kw.pop("file", Upload()), user=ME, db=db, **{"kind": "upload", "caption": None, "entry_price": None, "stop_price": None, "target_price": None, **kw}))


def test_an_update_picture_is_saved_with_its_levels_and_comes_back_in_the_listing():
    db = RouteDb(SimpleNamespace(user_id=ALICE))
    out = upload(db, kind="update", caption="new stop", entry_price=100.0, stop_price=104.5, target_price=130.0)
    assert (out["kind"], out["caption"], out["entry_price"], out["stop_price"], out["target_price"]) == ("update", "new stop", 100.0, 104.5, 130.0)
    assert len(db.images) == 1


def test_an_old_style_upload_is_still_just_an_upload():
    out = upload(RouteDb(SimpleNamespace(user_id=ALICE)))
    assert out["kind"] == "upload" and out["caption"] is None and out["stop_price"] is None


def test_someone_elses_trade_cannot_be_photographed_and_odd_kinds_and_files_are_refused():
    with pytest.raises(HTTPException) as e:
        upload(RouteDb(SimpleNamespace(user_id=uuid.uuid4())))
    assert e.value.status_code == 404
    db = RouteDb(SimpleNamespace(user_id=ALICE))
    with pytest.raises(HTTPException) as e:
        upload(db, kind="profit-screenshot")
    assert e.value.status_code == 422
    with pytest.raises(HTTPException) as e:
        upload(db, file=Upload(content_type="application/pdf"))
    assert e.value.status_code == 422
    assert db.images == []


# ---- a waiting order carries its plan picture --------------------------------------------------------------------------------------------


def test_an_order_armed_with_a_plan_picture_keeps_it():
    row = arm(ImgDb(), fake_deps({("NSE", "NIFTY"): 105.0}), plan_snapshot_png_base64=PNG_B64)
    assert bytes(row.plan_snapshot) == PNG


def test_an_order_armed_without_one_has_none_and_a_picture_that_is_not_a_png_is_refused():
    assert arm(ImgDb(), fake_deps({("NSE", "NIFTY"): 105.0})).plan_snapshot is None
    with pytest.raises(PendingOrderError) as e:
        arm(ImgDb(), fake_deps({("NSE", "NIFTY"): 105.0}), plan_snapshot_png_base64="data:image/png;base64," + base64.b64encode(b"not a picture").decode())
    assert e.value.status_code == 422


def test_when_the_order_fills_its_plan_picture_goes_to_the_position_with_the_levels_it_was_armed_at():
    db = ImgDb()
    order = arm(db, fake_deps({("NSE", "NIFTY"): 105.0}), stop_loss_price=95.0, target_price=120.0, trigger_price=100.0, plan_snapshot_png_base64=PNG_B64)
    counts, _ = run(db, {("NSE", "NIFTY"): 99.0})
    assert counts["triggered"] == 1 and order.status == "triggered"
    (img,) = db.images
    assert (img.kind, img.position_id, img.option_group_id) == ("entry", order.position_id, None)
    assert (img.entry_price, img.stop_price, img.target_price) == (100.0, 95.0, 120.0)
    assert bytes(img.image_data) == PNG and img.caption == "The plan when the order was placed"


def test_an_order_without_a_picture_attaches_nothing():
    db = ImgDb()
    arm(db, fake_deps({("NSE", "NIFTY"): 105.0}), trigger_price=100.0)
    run(db, {("NSE", "NIFTY"): 99.0})
    assert db.images == []


def test_a_spread_that_fills_keeps_the_picture_against_the_spread():
    db = ImgDb()
    order = arm(db, fake_deps({("NSE", "NIFTY"): 105.0}), strategy="naked", trigger_price=100.0, plan_snapshot_png_base64=PNG_B64)
    run(db, {("NSE", "NIFTY"): 99.0})
    (img,) = db.images
    assert img.option_group_id == order.option_group_id and img.position_id is None


def test_a_picture_that_cannot_be_saved_never_undoes_the_fill(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(ts, "add_image", boom)
    db = ImgDb()
    order = arm(db, fake_deps({("NSE", "NIFTY"): 105.0}), trigger_price=100.0, plan_snapshot_png_base64=PNG_B64)
    counts, _ = run(db, {("NSE", "NIFTY"): 99.0})
    assert counts["triggered"] == 1 and order.status == "triggered" and order.position_id is not None


# ---- a trade opened from a plan note keeps the note's picture ----------------------------------------------------------------------------


def test_a_trade_from_a_plan_note_keeps_the_notes_picture_as_its_plan_at_entry():
    db = ImgDb()
    note = SimpleNamespace(user_id=ALICE, position_id=None, snapshot_png=PNG)
    pid = uuid.uuid4()
    db.get = lambda model, key: note if model is db_models.StudyNote else SimpleNamespace(entry_price=100, stop_loss_price=95, target_price=120)
    link_note_to_position(db, ALICE, uuid.uuid4(), pid)
    (img,) = db.images
    assert (img.kind, img.position_id, img.caption) == ("entry", pid, "From your plan note")
    assert (img.entry_price, img.stop_price, img.target_price) == (100, 95, 120)


def test_a_note_without_a_picture_adds_none_and_a_failure_to_copy_does_not_undo_the_link(monkeypatch):
    db = ImgDb()
    note = SimpleNamespace(user_id=ALICE, position_id=None, snapshot_png=None)
    db.get = lambda model, key: note
    link_note_to_position(db, ALICE, uuid.uuid4(), uuid.uuid4())
    assert db.images == [] and note.position_id is not None
    note2 = SimpleNamespace(user_id=ALICE, position_id=None, snapshot_png=PNG)
    db.get = lambda model, key: note2 if model is db_models.StudyNote else None
    monkeypatch.setattr(ts, "add_image", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no")))
    link_note_to_position(db, ALICE, uuid.uuid4(), uuid.uuid4())
    assert note2.position_id is not None
