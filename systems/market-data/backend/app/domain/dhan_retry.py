import time
from typing import Callable, Optional, TypeVar

T = TypeVar("T")

# Short, interactive-appropriate budget - NOT scheduler.py's
# THROTTLE_RETRY_ATTEMPTS/8/5s/10s (that job runs unattended over ~2000
# symbols and can afford to wait out a real rate-limit window). A live
# route is answering someone's click: a couple of quick retries is enough
# to ride out the collision this actually exists for (see below) without
# turning a snappy page into one that hangs for the better part of a
# minute if Dhan is genuinely down.
INTERACTIVE_RETRY_ATTEMPTS = 3
INTERACTIVE_QUEUE_RETRY_SLEEP_SECONDS = 1.0
INTERACTIVE_429_RETRY_SLEEP_SECONDS = 2.0


def dhan_retry_delay(message: str, queue_sleep_seconds: float, rate_limit_sleep_seconds: float) -> Optional[float]:
    """How long to wait before retrying a DhanProvider RuntimeError, or None if it should not be
    retried at all (a bad symbol, an auth failure, anything else that a wait cannot fix). Shared
    classification between scheduler.py's own (long-budget) retry loop and interactive_retry
    below (short-budget) - same two flavours scheduler.py's _retry_when_throttled already
    handles, just re-exposed as a pure function so a second caller doesn't have to duplicate the
    message-sniffing."""
    if "rate limit hit (429)" in message:
        return rate_limit_sleep_seconds
    if "queue is backed up" in message:
        return queue_sleep_seconds
    return None


def interactive_retry(fn: Callable[..., T], *args, sleep: Callable[[float], None] = time.sleep) -> T:
    """Calls fn(*args), retrying a couple of times on the same two transient-throttle shapes
    scheduler.py's _retry_when_throttled already knows to ride out (see its own docstring) -
    with a much shorter budget, for a route answering a live request rather than an unattended
    batch job.

    Why this exists: opening (or switching the symbol on) the Live Chart fires several
    DIFFERENT Dhan endpoint calls at once - LTP, candles (sometimes two intervals), regime,
    option expiries, OI summary. Each one is individually throttled to Dhan's own documented
    pace, but each throttle clock only tracks ITS OWN endpoint category, and on a page that
    hasn't called any of them recently every one of those clocks lets its first call straight
    through with no wait - so a chart load can genuinely fire five or six requests inside the
    same instant. Dhan's real per-account budget then rejects some of them with a 429 (or this
    process's own local queue briefly backs up), even though each category was individually
    compliant. Reproduced live 2026-09-28 on NSE and MCX alike (BANKNIFTY, NIFTY, GOLDM,
    CRUDEOILM), self-clearing within ~30s without any user action - exactly the shape a short
    retry here is meant to absorb, invisibly, instead of surfacing as an error the user has to
    notice self-resolved on its own."""
    for attempt in range(INTERACTIVE_RETRY_ATTEMPTS):
        try:
            return fn(*args)
        except RuntimeError as e:
            delay = dhan_retry_delay(str(e), INTERACTIVE_QUEUE_RETRY_SLEEP_SECONDS, INTERACTIVE_429_RETRY_SLEEP_SECONDS)
            if delay is None or attempt == INTERACTIVE_RETRY_ATTEMPTS - 1:
                raise
            sleep(delay)
    raise AssertionError("unreachable")  # the loop above always returns or raises
