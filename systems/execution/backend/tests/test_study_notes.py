"""The thoughts-and-plans notes: validation, the snapshot's guards, and that every route needs a login. The list/delete
queries run against Postgres (checked live on the dev stack), not against a fake - the JSONB/UUID columns do not
exist in SQLite."""

import base64
import uuid
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.domain import study_notes as sn
from app.domain.models import StudyNoteCreate
from app.domain.study_notes import StudyNoteError, create_note, decode_snapshot

ALICE = uuid.uuid4()
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
PNG_B64 = base64.b64encode(PNG).decode()


def body(**over):
    return StudyNoteCreate(**{**dict(segment="NSE", symbol="nifty", text="  Waiting for a retest of 22500  "), **over})


class FakeDb:
    def __init__(self):
        self.rows = []
        self.commits = 0

    def add(self, row):
        row.id = row.id or uuid.uuid4()
        self.rows.append(row)

    def commit(self):
        self.commits += 1

    def refresh(self, row):
        pass


# --- the request ----------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("bad", [dict(text=""), dict(text="x" * 4001), dict(segment="BSE"), dict(tag="rant"), dict(symbol=""), dict(interval="x" * 9)])
def test_the_request_is_validated(bad):
    with pytest.raises(ValidationError):
        body(**bad)


def test_every_tag_is_accepted():
    for tag in ("plan", "observation", "mistake", "review", None):
        assert body(tag=tag).tag == tag


# --- creating ---------------------------------------------------------------------------------------------------------------------


def test_a_note_is_trimmed_upper_cased_and_belongs_to_its_author():
    db = FakeDb()
    out = create_note(db, ALICE, body(interval="5min", tag="plan", context={"price": 22550.5, "regime": "ranging"}))
    row = db.rows[0]
    assert row.user_id == ALICE and row.symbol == "NIFTY" and row.text == "Waiting for a retest of 22500"
    assert out.text == "Waiting for a retest of 22500" and out.tag == "plan" and out.context == {"price": 22550.5, "regime": "ranging"}
    assert out.has_snapshot is False and db.commits == 1


def test_a_blank_note_is_refused_even_though_it_passed_the_length_check():
    with pytest.raises(StudyNoteError) as exc:
        create_note(FakeDb(), ALICE, body(text="    "))
    assert exc.value.status_code == 422


def test_the_context_has_a_size_cap():
    with pytest.raises(StudyNoteError, match="too large"):
        create_note(FakeDb(), ALICE, body(context={"blob": "x" * (sn.MAX_CONTEXT_BYTES + 1)}))


def test_a_note_can_point_at_a_trade_but_only_with_a_real_id():
    db = FakeDb()
    pid = uuid.uuid4()
    create_note(db, ALICE, body(position_id=str(pid)))
    assert db.rows[0].position_id == pid and db.rows[0].option_group_id is None
    with pytest.raises(StudyNoteError, match="position_id"):
        create_note(FakeDb(), ALICE, body(position_id="not-an-id"))


# --- the snapshot -------------------------------------------------------------------------------------------------------------------


def test_a_snapshot_is_accepted_as_a_data_url_or_bare_base64():
    assert decode_snapshot(f"data:image/png;base64,{PNG_B64}") == PNG
    assert decode_snapshot(PNG_B64) == PNG
    assert decode_snapshot(None) is None and decode_snapshot("   ") is None


def test_the_snapshot_is_stored_and_reported():
    db = FakeDb()
    out = create_note(db, ALICE, body(snapshot_png_base64=PNG_B64))
    assert db.rows[0].snapshot_png == PNG and out.has_snapshot is True


@pytest.mark.parametrize(
    "raw, why",
    [
        ("data:image/jpeg;base64," + PNG_B64, "PNG"),
        ("!!!not base64!!!", "base64"),
        (base64.b64encode(b"GIF89a-not-a-png").decode(), "PNG"),
    ],
)
def test_anything_that_is_not_a_png_is_refused(raw, why):
    with pytest.raises(StudyNoteError, match=why):
        decode_snapshot(raw)


def test_an_oversized_snapshot_is_refused(monkeypatch):
    monkeypatch.setattr(sn, "MAX_SNAPSHOT_BYTES", 16)
    with pytest.raises(StudyNoteError, match="too large"):
        decode_snapshot(PNG_B64)


# --- the routes -----------------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "method, path",
    [
        ("POST", "/study-notes"),
        ("GET", "/study-notes?segment=NSE&symbol=NIFTY"),
        ("GET", "/study-notes"),
        ("GET", "/study-notes/instruments"),
        ("GET", f"/study-notes/{uuid.uuid4()}/snapshot"),
        ("DELETE", f"/study-notes/{uuid.uuid4()}"),
    ],
)
def test_every_route_needs_a_login(method, path):
    from fastapi.testclient import TestClient

    from app.main import app

    assert TestClient(app).request(method, path, json={}).status_code == 401


def test_a_malformed_note_id_is_a_404_not_a_server_error():
    from fastapi import HTTPException

    from app.api.routes import study_notes as route

    for call in (lambda: route.note_snapshot("nope", user=SimpleNamespace(id=ALICE), db=None), lambda: route.remove_note("nope", user=SimpleNamespace(id=ALICE), db=None)):
        with pytest.raises(HTTPException) as exc:
            call()
        assert exc.value.status_code == 404


# --- the history filters ----------------------------------------------------------------------------------------------------------------


def test_search_text_is_matched_literally_so_wildcards_in_it_match_nothing_extra():
    assert sn._like_pattern("retest") == "%retest%"
    assert sn._like_pattern("50%_off") == r"%50\%\_off%"
    assert sn._like_pattern("a" + chr(92) + "b") == "%a" + chr(92) * 2 + "b%"  # a backslash is doubled


@pytest.mark.parametrize("query", ["tag=rant", "segment=BSE", "limit=0", "limit=501", "offset=-1", "q=" + "x" * 201])
def test_the_history_filters_are_validated(query):
    from fastapi.testclient import TestClient

    from app.auth import get_current_user
    from app.main import app

    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=ALICE)
    try:
        assert TestClient(app).get(f"/study-notes?{query}").status_code == 422
    finally:
        app.dependency_overrides.clear()
