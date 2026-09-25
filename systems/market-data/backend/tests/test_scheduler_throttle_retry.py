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
