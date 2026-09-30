"""The risk acknowledgement recorded at signup (app/api/routes/auth.py,
app/domain/risk_ack.py). Signup is refused without it, and a successful signup
stores when it was confirmed and which wording version.

Plain fakes and direct route-function calls, like the rest of this backend."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import rate_limit
from app.api.routes import auth as auth_route
from app.domain.models import SignupRequest, UserOut
from app.domain.risk_ack import RISK_ACK_VERSION
from app.main import app
from app.rate_limit import SlidingWindowLimiter


class FakeDb:
    """No users exist yet; records what signup adds."""

    def __init__(self):
        self.added = []
        self.commits = 0

    def query(self, model):
        return SimpleNamespace(count=lambda: 1)

    def add(self, row):
        self.added.append(row)

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass

    def refresh(self, row):
        row.id = "u1"
        row.is_admin = False


def request():
    return SimpleNamespace(client=SimpleNamespace(host="10.0.0.5"), headers={})


@pytest.fixture(autouse=True)
def fresh_limiter(monkeypatch):
    monkeypatch.setattr(rate_limit, "signups_by_ip", SlidingWindowLimiter(2, 3600, lambda: 1000.0))


def signup(db, **over):
    fields = dict(email="a@example.com", name="A", password="longenoughpw")
    fields.update(over)
    return auth_route.signup(SignupRequest(**fields), request(), db)


def test_signup_without_the_acknowledgement_is_refused_and_writes_nothing():
    db = FakeDb()
    with pytest.raises(HTTPException) as exc:
        signup(db)  # accept_risk_disclosure defaults to False
    assert exc.value.status_code == 422 and "risk disclosure" in exc.value.detail
    assert db.added == [] and db.commits == 0


def test_an_explicit_false_is_refused_too():
    with pytest.raises(HTTPException) as exc:
        signup(FakeDb(), accept_risk_disclosure=False)
    assert exc.value.status_code == 422


def test_signup_records_when_and_which_version():
    db = FakeDb()
    before = datetime.now(timezone.utc)
    signup(db, accept_risk_disclosure=True)
    user = db.added[0]
    assert user.risk_acknowledged_version == RISK_ACK_VERSION
    assert before - timedelta(seconds=1) <= user.risk_acknowledged_at <= datetime.now(timezone.utc) + timedelta(seconds=1)
    assert user.risk_acknowledged_at.tzinfo is not None


def test_a_forgotten_checkbox_does_not_use_up_signup_attempts():
    """Two attempts per hour per IP here; two refusals then a good signup must still work."""
    db = FakeDb()
    for _ in range(2):
        with pytest.raises(HTTPException):
            signup(db)
    signup(db, accept_risk_disclosure=True)
    assert len(db.added) == 1


def test_the_field_is_not_taken_from_anywhere_else():
    """A client cannot pre-set the stored timestamp/version through the request."""
    req = SignupRequest(email="a@example.com", name="A", password="longenoughpw", accept_risk_disclosure=True,
                        risk_acknowledged_at="2020-01-01T00:00:00Z", risk_acknowledged_version="old")  # type: ignore[call-arg]
    db = FakeDb()
    auth_route.signup(req, request(), db)
    assert db.added[0].risk_acknowledged_version == RISK_ACK_VERSION
    assert db.added[0].risk_acknowledged_at.year >= 2026


def test_me_exposes_the_acknowledgement_and_tolerates_older_accounts():
    now = datetime.now(timezone.utc)
    new = UserOut.model_validate(SimpleNamespace(id="00000000-0000-0000-0000-000000000001", email="a@b.c", name="A",
                                                  created_at=now, is_admin=False, risk_acknowledged_at=now,
                                                  risk_acknowledged_version=RISK_ACK_VERSION))
    old = UserOut.model_validate(SimpleNamespace(id="00000000-0000-0000-0000-000000000002", email="d@e.f", name="D",
                                                  created_at=now, is_admin=False, risk_acknowledged_at=None,
                                                  risk_acknowledged_version=None))
    assert new.risk_acknowledged_version == RISK_ACK_VERSION and old.risk_acknowledged_at is None


def test_the_real_route_refuses_a_body_without_it():
    client = TestClient(app)  # no lifespan
    resp = client.post("/auth/signup", json={"email": "x@example.com", "name": "X", "password": "longenoughpw"})
    assert resp.status_code == 422
