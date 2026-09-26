"""First-run onboarding state on the user (app/api/routes/auth.py update_preferences,
migrations/024-onboarding.sql): the chosen experience and when the first-run flow was finished.

Plain fakes and direct route-function calls, like the rest of this backend."""

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.routes import auth as auth_route
from app.domain.models import PreferencesUpdate, UserOut
from app.main import app


class FakeDb:
    def __init__(self):
        self.commits = 0
        self.refreshed = 0

    def commit(self):
        self.commits += 1

    def refresh(self, row):
        self.refreshed += 1


def user(**over):
    fields = dict(id="00000000-0000-0000-0000-000000000001", email="a@b.c", name="A", created_at=datetime.now(timezone.utc),
                  is_admin=False, risk_acknowledged_at=None, risk_acknowledged_version=None, experience="guided", onboarded_at=None)
    fields.update(over)
    return SimpleNamespace(**fields)


def update(row, **body):
    return auth_route.update_preferences(PreferencesUpdate(**body), row, FakeDb())


def test_a_new_user_is_not_onboarded_and_defaults_to_guided():
    out = UserOut.model_validate(user())
    assert out.onboarded_at is None and out.experience == "guided"


def test_older_rows_without_the_fields_still_serialise():
    """A user object from before the columns existed (as the existing tests build them)."""
    bare = SimpleNamespace(id="00000000-0000-0000-0000-000000000002", email="d@e.f", name="D", created_at=datetime.now(timezone.utc),
                           is_admin=False, risk_acknowledged_at=None, risk_acknowledged_version=None)
    out = UserOut.model_validate(bare)
    assert out.experience == "guided" and out.onboarded_at is None


def test_choosing_an_experience_changes_only_that():
    row = user()
    update(row, experience="pro")
    assert row.experience == "pro" and row.onboarded_at is None


def test_finishing_onboarding_records_when_and_is_not_moved_by_a_repeat():
    row = user()
    update(row, onboarded=True)
    first = row.onboarded_at
    assert first is not None and first.tzinfo is not None
    update(row, onboarded=True)
    assert row.onboarded_at == first  # finishing twice keeps the original time


def test_onboarded_false_clears_it_so_the_flow_can_be_replayed():
    row = user(onboarded_at=datetime.now(timezone.utc))
    update(row, onboarded=False)
    assert row.onboarded_at is None


def test_an_empty_update_changes_nothing():
    stamp = datetime.now(timezone.utc)
    row = user(experience="pro", onboarded_at=stamp)
    update(row)
    assert row.experience == "pro" and row.onboarded_at == stamp


def test_it_writes_once_and_returns_the_fresh_row():
    db, row = FakeDb(), user()
    out = auth_route.update_preferences(PreferencesUpdate(experience="pro"), row, db)
    assert out is row and db.commits == 1 and db.refreshed == 1


def test_an_unknown_experience_is_refused():
    with pytest.raises(ValidationError):
        PreferencesUpdate(experience="expert")


def test_nothing_else_about_the_account_can_be_set_through_it():
    """Extra fields are ignored, never applied: no way to grant admin or edit the acknowledgement here."""
    body = PreferencesUpdate(**{"experience": "pro", "is_admin": True, "risk_acknowledged_version": "x"})  # type: ignore[arg-type]
    row = user()
    auth_route.update_preferences(body, row, FakeDb())
    assert row.is_admin is False and row.risk_acknowledged_version is None


def test_the_real_route_needs_a_login():
    client = TestClient(app)  # no lifespan
    assert client.put("/auth/me/preferences", json={"experience": "pro"}).status_code == 401


def test_a_new_user_has_all_three_markets_until_they_choose():
    assert UserOut.model_validate(user()).markets == ["NSE", "MCX", "CRYPTO"]


def test_older_rows_without_markets_still_serialise_as_all_three():
    bare = SimpleNamespace(id="00000000-0000-0000-0000-000000000003", email="d@e.f", name="D", created_at=datetime.now(timezone.utc),
                           is_admin=False, risk_acknowledged_at=None, risk_acknowledged_version=None)
    assert UserOut.model_validate(bare).markets == ["NSE", "MCX", "CRYPTO"]


def test_choosing_markets_keeps_the_order_and_drops_duplicates():
    row = user()
    update(row, markets=["MCX", "NSE", "MCX"])
    assert row.markets == ["MCX", "NSE"]


def test_at_least_one_market_and_only_known_ones():
    with pytest.raises(ValidationError):
        PreferencesUpdate(markets=[])
    with pytest.raises(ValidationError):
        PreferencesUpdate(markets=["NSE", "FOREX"])


def test_markets_alone_changes_nothing_else():
    stamp = datetime.now(timezone.utc)
    row = user(experience="pro", onboarded_at=stamp)
    update(row, markets=["NSE"])
    assert row.experience == "pro" and row.onboarded_at == stamp and row.markets == ["NSE"]
