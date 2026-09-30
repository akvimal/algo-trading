import pytest

from app.domain.dhan_retry import INTERACTIVE_RETRY_ATTEMPTS, dhan_retry_delay, interactive_retry

DHAN_429 = "Dhan API rate limit hit (429) on optionchain - retry shortly"
QUEUE_BACKED_UP = "Dhan option-chain queue is backed up (5.3s wait) - try again shortly"


def test_dhan_retry_delay_classifies_the_two_retryable_shapes():
    assert dhan_retry_delay(DHAN_429, queue_sleep_seconds=1.0, rate_limit_sleep_seconds=2.0) == 2.0
    assert dhan_retry_delay(QUEUE_BACKED_UP, queue_sleep_seconds=1.0, rate_limit_sleep_seconds=2.0) == 1.0


def test_dhan_retry_delay_does_not_retry_anything_else():
    assert dhan_retry_delay("some other failure", queue_sleep_seconds=1.0, rate_limit_sleep_seconds=2.0) is None
    assert dhan_retry_delay("Dhan API rejected the access token (401)", queue_sleep_seconds=1.0, rate_limit_sleep_seconds=2.0) is None


def test_interactive_retry_rides_out_a_burst_collision_then_succeeds():
    """The scenario this exists for: a chart load fires several Dhan endpoints at once, each
    individually within its own throttle but colliding on Dhan's real account-wide budget - the
    second call in the burst gets a 429, then the retry (after its own short local throttle wait)
    succeeds."""
    sleeps = []
    calls = []

    def flaky(symbol):
        calls.append(symbol)
        if len(calls) < 2:
            raise RuntimeError(DHAN_429)
        return 1234.5

    assert interactive_retry(flaky, "RELIANCE", sleep=sleeps.append) == 1234.5
    assert calls == ["RELIANCE", "RELIANCE"]
    assert sleeps == [2.0]  # INTERACTIVE_429_RETRY_SLEEP_SECONDS


def test_interactive_retry_gives_up_after_its_own_short_budget():
    calls = []

    def always_429():
        calls.append(1)
        raise RuntimeError(DHAN_429)

    with pytest.raises(RuntimeError, match="429"):
        interactive_retry(always_429, sleep=lambda _s: None)
    assert len(calls) == INTERACTIVE_RETRY_ATTEMPTS


def test_interactive_retry_never_retries_a_real_error():
    calls = []

    def unauthorized():
        calls.append(1)
        raise RuntimeError("Dhan API rejected the access token (401) - it may need to be regenerated")

    with pytest.raises(RuntimeError, match="401"):
        interactive_retry(unauthorized, sleep=lambda _s: None)
    assert len(calls) == 1  # not retried at all - a wait cannot fix a bad token


def test_interactive_retry_passes_through_positional_args():
    seen = []

    def fn(a, b, credentials):
        seen.append((a, b, credentials))
        return "ok"

    assert interactive_retry(fn, "NIFTY", "5min", None, sleep=lambda _s: None) == "ok"
    assert seen == [("NIFTY", "5min", None)]
