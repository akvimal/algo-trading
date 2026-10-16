"""The in-app inbox (app/domain/inbox.py): what a line must carry, that an event is posted once, and that a to-do follows its condition."""

import uuid
from types import SimpleNamespace

import pytest

from app.domain import inbox

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")


class FakeQuery:
    def __init__(self, row):
        self.row = row

    def filter(self, *a):
        return self

    def first(self):
        return self.row


class FakeDB:
    """Just enough of a session: query() hands back one prepared row (or none), add/commit are recorded."""

    def __init__(self, row=None):
        self.row, self.added, self.commits, self.rollbacks = row, [], 0, 0

    def query(self, *a):
        return FakeQuery(self.row)

    def add(self, item):
        self.added.append(item)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def test_a_line_needs_a_known_kind_and_severity_and_a_title():
    with pytest.raises(inbox.InboxError):
        inbox.post(FakeDB(), USER, "bot", "x", kind="memo")
    with pytest.raises(inbox.InboxError):
        inbox.post(FakeDB(), USER, "bot", "x", severity="panic")
    with pytest.raises(inbox.InboxError):
        inbox.post(FakeDB(), USER, "bot", "   ")
    with pytest.raises(inbox.InboxError):
        inbox.post(FakeDB(), USER, "", "title")


def test_a_line_is_stored_with_the_limits_applied():
    db = FakeDB()
    item = inbox.post(db, USER, "bot", "T" * 500, body="b" * 9000, link="/more/settings", severity="warn", dedupe_key="k")
    assert item is not None and db.added == [item] and db.commits == 1
    assert len(item.title) == 200 and len(item.body) == 4000 and item.link == "/more/settings" and item.severity == "warn" and item.kind == "event"


def test_the_same_dedupe_key_is_posted_once():
    db = FakeDB(row=SimpleNamespace(id=1))  # the key is already there
    assert inbox.post(db, USER, "bot", "again", dedupe_key="bot-loss:2026-10-16") is None
    assert db.added == [] and db.commits == 0


def test_a_to_do_is_created_while_its_condition_holds():
    db = FakeDB()
    inbox.sync_todo(db, USER, "todo:review", "review", True, title="3 closed trades not reviewed yet", body="b", link="/portfolio?tab=review")
    assert len(db.added) == 1 and db.added[0].kind == "todo" and db.added[0].dedupe_key == "todo:review"


def test_a_to_do_is_resolved_when_the_condition_clears_and_nothing_is_made_if_it_never_held():
    row = SimpleNamespace(resolved_at=None)
    db = FakeDB(row=row)
    inbox.sync_todo(db, USER, "todo:review", "review", False)
    assert row.resolved_at is not None and db.commits == 1
    nothing = FakeDB()
    inbox.sync_todo(nothing, USER, "todo:review", "review", False)
    assert nothing.added == [] and nothing.commits == 0


def _todo(**over):
    base = dict(title="2 closed trades not reviewed yet", body=None, link=None, severity="warn", category="review", kind="todo", read_at="r", dismissed_at="d", resolved_at=None, created_at="old")
    return SimpleNamespace(**{**base, **over})


def test_a_to_do_that_changed_comes_back_unread_and_one_that_did_not_stays_as_it_was():
    changed = _todo()
    inbox.sync_todo(FakeDB(row=changed), USER, "todo:review", "review", True, title="3 closed trades not reviewed yet")
    assert changed.read_at is None and changed.dismissed_at is None and changed.title.startswith("3 ")
    same = _todo()
    inbox.sync_todo(FakeDB(row=same), USER, "todo:review", "review", True, title="2 closed trades not reviewed yet")
    assert same.read_at == "r" and same.dismissed_at == "d"  # a dismissed to-do stays dismissed until its count changes


def test_a_resolved_to_do_that_returns_is_a_new_unread_line():
    back = _todo(resolved_at="then", read_at="r")
    inbox.sync_todo(FakeDB(row=back), USER, "todo:review", "review", True, title="2 closed trades not reviewed yet")
    assert back.resolved_at is None and back.read_at is None
