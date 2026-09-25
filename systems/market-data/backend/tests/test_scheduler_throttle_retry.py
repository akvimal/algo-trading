import pytest

from app import scheduler


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(scheduler.time, "sleep", lambda _s: None)


def test_retries_backed_up_queue_then_succeeds():
    calls = []

    def flaky(x):
        calls.append(x)
        if len(calls) < 3:
            raise RuntimeError("Dhan option-chain queue is backed up (5.3s wait) - try again shortly")
        return "ok"

    assert scheduler._retry_when_throttled(flaky, "A") == "ok"
    assert calls == ["A", "A", "A"]


def test_gives_up_after_max_attempts():
    calls = []

    def always_backed_up():
        calls.append(1)
        raise RuntimeError("Dhan option-chain queue is backed up (5.3s wait) - try again shortly")

    with pytest.raises(RuntimeError, match="backed up"):
        scheduler._retry_when_throttled(always_backed_up)
    assert len(calls) == scheduler.THROTTLE_RETRY_ATTEMPTS


def test_other_errors_propagate_immediately():
    calls = []

    def boom():
        calls.append(1)
        raise RuntimeError("some other failure")

    with pytest.raises(RuntimeError, match="some other failure"):
        scheduler._retry_when_throttled(boom)
    assert len(calls) == 1


DHAN_429 = "Dhan API rate limit hit (429) on optionchain - retry shortly"


def test_a_real_dhan_429_is_retried_with_the_longer_wait(monkeypatch):
    """The scheduled OI run, and the retry script, hit real Dhan 429s
    ("rate limit hit (429) on optionchain") and used to abandon the symbol on
    the first one, so whole runs ended almost empty."""
    sleeps = []
    monkeypatch.setattr(scheduler.time, "sleep", sleeps.append)
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError(DHAN_429)
        return "ok"

    assert scheduler._retry_when_throttled(flaky) == "ok"
    assert len(calls) == 3
    assert sleeps == [scheduler.DHAN_429_RETRY_SLEEP_SECONDS] * 2
    assert scheduler.DHAN_429_RETRY_SLEEP_SECONDS > scheduler.THROTTLE_RETRY_SLEEP_SECONDS


def test_a_dhan_429_that_never_clears_gives_up_after_max_attempts():
    calls = []

    def always_429():
        calls.append(1)
        raise RuntimeError(DHAN_429)

    with pytest.raises(RuntimeError, match="429"):
        scheduler._retry_when_throttled(always_429)
    assert len(calls) == scheduler.THROTTLE_RETRY_ATTEMPTS


def test_the_two_kinds_of_throttle_error_can_alternate(monkeypatch):
    sleeps = []
    monkeypatch.setattr(scheduler.time, "sleep", sleeps.append)
    errors = iter([
        "Dhan option-chain queue is backed up (5.3s wait) - try again shortly",
        DHAN_429,
    ])

    def flaky():
        try:
            raise RuntimeError(next(errors))
        except StopIteration:
            return "ok"

    assert scheduler._retry_when_throttled(flaky) == "ok"
    assert sleeps == [scheduler.THROTTLE_RETRY_SLEEP_SECONDS, scheduler.DHAN_429_RETRY_SLEEP_SECONDS]


def test_an_auth_401_is_still_not_retried():
    calls = []

    def unauthorized():
        calls.append(1)
        raise RuntimeError("Dhan API rejected the access token (401) - it may need to be regenerated")

    with pytest.raises(RuntimeError, match="401"):
        scheduler._retry_when_throttled(unauthorized)
    assert len(calls) == 1
