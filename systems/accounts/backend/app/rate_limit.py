"""In-memory sliding-window limiter for the auth routes (Phase 0 of
docs/redesign-rollout-plan.md) - login had no brute-force protection and
signup no abuse protection at all.

Deliberately simple: per-process memory (this service runs a single
uvicorn worker; state resets on restart, and would not be shared across
several workers or replicas - move it to Redis if that ever changes).

Known tradeoff, chosen on purpose: failed logins are limited per EMAIL (so a
distributed guesser cannot hammer one account) AND per client IP. Limiting
per email means someone can lock a victim out for the window by failing on
purpose; that is preferable to unlimited password guessing, and a successful
login clears the email counter."""

import time
from collections import defaultdict, deque
from typing import Callable, Optional

from fastapi import HTTPException, Request, status

from app.config import settings


class SlidingWindowLimiter:
    def __init__(self, max_events: int, window_seconds: float, clock: Callable[[], float] = time.monotonic):
        self.max_events = max_events
        self.window = window_seconds
        self._clock = clock
        self._events: dict[str, deque] = defaultdict(deque)

    def _prune(self, key: str) -> deque:
        q = self._events[key]
        cutoff = self._clock() - self.window
        while q and q[0] <= cutoff:
            q.popleft()
        if not q:
            # Drop idle keys so the dict cannot grow without bound.
            self._events.pop(key, None)
            return deque()
        return q

    def retry_after(self, key: str) -> float:
        """Seconds until `key` may act again, 0 when it is under the limit."""
        q = self._prune(key)
        if len(q) < self.max_events:
            return 0.0
        return max(0.0, q[0] + self.window - self._clock())

    def record(self, key: str) -> None:
        self._prune(key)
        self._events[key].append(self._clock())

    def reset(self, key: str) -> None:
        self._events.pop(key, None)


def client_ip(request: Request) -> str:
    """The caller's IP. Behind Caddy on the VPS the socket peer is the proxy,
    so X-Forwarded-For (first hop) is used - but only when TRUST_FORWARDED_FOR
    is on, because otherwise anyone could spoof the header to dodge a limit."""
    if settings.trust_forwarded_for:
        forwarded = request.headers.get("x-forwarded-for", "")
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


def _too_many(seconds: float) -> HTTPException:
    wait = max(1, int(seconds + 0.999))
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=f"too many attempts - try again in {max(1, (wait + 59) // 60)} minute(s)",
        headers={"Retry-After": str(wait)},
    )


login_failures_by_email = SlidingWindowLimiter(settings.login_max_failures_per_email, settings.login_window_seconds)
login_failures_by_ip = SlidingWindowLimiter(settings.login_max_failures_per_ip, settings.login_window_seconds)
signups_by_ip = SlidingWindowLimiter(settings.signup_max_per_ip, settings.signup_window_seconds)


def check_login_allowed(email: str, ip: str) -> None:
    wait = max(login_failures_by_email.retry_after(email), login_failures_by_ip.retry_after(ip))
    if wait > 0:
        raise _too_many(wait)


def record_login_failure(email: str, ip: str) -> None:
    login_failures_by_email.record(email)
    login_failures_by_ip.record(ip)


def record_login_success(email: str) -> None:
    login_failures_by_email.reset(email)


def check_and_record_signup(ip: str) -> None:
    wait = signups_by_ip.retry_after(ip)
    if wait > 0:
        raise _too_many(wait)
    signups_by_ip.record(ip)
