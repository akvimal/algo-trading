"""Auth rate limiting (app/rate_limit.py, wired into app/api/routes/auth.py).

A fake clock drives the sliding window; the routes are called directly with a
fake DB and a fake Request, same "plain fakes" convention as this backend's
other tests."""

import pytest
from fastapi import HTTPException
from types import SimpleNamespace

from app import rate_limit
from app.api.routes import auth as auth_route
from app.config import settings
from app.domain.models import LoginRequest, SignupRequest
from app.rate_limit import SlidingWindowLimiter, client_ip


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


# --- the limiter ------------------------------------------------------------------------------


def test_allows_up_to_the_limit_then_blocks_with_a_retry_time():
    clock = Clock()
    lim = SlidingWindowLimiter(3, 60, clock)
    for _ in range(3):
        assert lim.retry_after("k") == 0
        lim.record("k")
    assert lim.retry_after("k") == pytest.approx(60)
    clock.now += 20
    assert lim.retry_after("k") == pytest.approx(40)


def test_the_window_slides_so_old_events_stop_counting():
    clock = Clock()
    lim = SlidingWindowLimiter(2, 60, clock)
    lim.record("k")
    clock.now += 30
    lim.record("k")
    assert lim.retry_after("k") > 0
    clock.now += 31  # the first event is now 61s old
    assert lim.retry_after("k") == 0


def test_keys_are_independent_and_reset_clears_one():
    lim = SlidingWindowLimiter(1, 60, Clock())
    lim.record("a")
    assert lim.retry_after("a") > 0 and lim.retry_after("b") == 0
    lim.reset("a")
    assert lim.retry_after("a") == 0


def test_idle_keys_are_dropped_so_memory_cannot_grow_unbounded():
    clock = Clock()
    lim = SlidingWindowLimiter(5, 60, clock)
    for i in range(100):
        lim.record(f"ip-{i}")
    clock.now += 61
    for i in range(100):
        lim.retry_after(f"ip-{i}")
    assert lim._events == {}


# --- client IP ----------------------------------------------------------------------------------


def request(peer="10.0.0.5", forwarded=None):
    headers = {"x-forwarded-for": forwarded} if forwarded else {}
    return SimpleNamespace(client=SimpleNamespace(host=peer), headers=headers)


def test_forwarded_for_is_ignored_unless_trusted(monkeypatch):
    monkeypatch.setattr(settings, "trust_forwarded_for", False)
    assert client_ip(request(forwarded="1.2.3.4")) == "10.0.0.5"


def test_forwarded_for_first_hop_is_used_when_trusted(monkeypatch):
    monkeypatch.setattr(settings, "trust_forwarded_for", True)
    assert client_ip(request(forwarded="1.2.3.4, 10.0.0.1")) == "1.2.3.4"
    assert client_ip(request(forwarded="")) == "10.0.0.5"


# --- the routes ---------------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def fresh_limiters(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(rate_limit, "login_failures_by_email", SlidingWindowLimiter(3, 900, clock))
    monkeypatch.setattr(rate_limit, "login_failures_by_ip", SlidingWindowLimiter(5, 900, clock))
    monkeypatch.setattr(rate_limit, "signups_by_ip", SlidingWindowLimiter(2, 3600, clock))
    monkeypatch.setattr(settings, "trust_forwarded_for", False)
    return clock


class NoUserDb:
    """A DB where no user exists, so every login fails with 401."""

    def query(self, model):
        return SimpleNamespace(filter=lambda *a, **k: SimpleNamespace(first=lambda: None), count=lambda: 1)

    def add(self, row):
        pass

    def commit(self):
        pass

    def refresh(self, row):
        row.id = "u1"
        row.is_admin = False


def try_login(email="a@example.com", password="pw", peer="10.0.0.5"):
    return auth_route.login(LoginRequest(email=email, password=password), request(peer), NoUserDb())


def test_repeated_failures_for_one_email_end_in_429_with_retry_after():
    for _ in range(3):
        with pytest.raises(HTTPException) as exc:
            try_login()
        assert exc.value.status_code == 401
    with pytest.raises(HTTPException) as exc:
        try_login()
    assert exc.value.status_code == 429
    assert int(exc.value.headers["Retry-After"]) > 0
    assert "too many attempts" in exc.value.detail


def test_the_lockout_follows_the_email_across_ips():
    for i in range(3):
        with pytest.raises(HTTPException):
            try_login(peer=f"10.0.0.{i}")
    with pytest.raises(HTTPException) as exc:
        try_login(peer="10.9.9.9")  # a brand-new IP, same email
    assert exc.value.status_code == 429


def test_one_ip_guessing_many_emails_is_stopped_by_the_ip_limit():
    for i in range(5):
        with pytest.raises(HTTPException) as exc:
            try_login(email=f"user{i}@example.com")
        assert exc.value.status_code == 401
    with pytest.raises(HTTPException) as exc:
        try_login(email="fresh@example.com")
    assert exc.value.status_code == 429


def test_other_emails_from_other_ips_are_unaffected():
    for _ in range(3):
        with pytest.raises(HTTPException):
            try_login()
    with pytest.raises(HTTPException) as exc:
        try_login(email="someone-else@example.com", peer="10.7.7.7")
    assert exc.value.status_code == 401  # a normal failed login, not a lockout


def test_a_successful_login_clears_the_email_counter(monkeypatch):
    for _ in range(2):
        with pytest.raises(HTTPException):
            try_login()
    rate_limit.record_login_success("a@example.com")
    assert rate_limit.login_failures_by_email.retry_after("a@example.com") == 0


def test_signup_is_limited_per_ip():
    def signup(peer="10.0.0.5", email="n@example.com"):
        return auth_route.signup(SignupRequest(email=email, name="N", password="longenoughpw"), request(peer), NoUserDb())

    signup()
    signup(email="m@example.com")
    with pytest.raises(HTTPException) as exc:
        signup(email="o@example.com")
    assert exc.value.status_code == 429
    signup(peer="10.1.1.1", email="p@example.com")  # another IP is fine
