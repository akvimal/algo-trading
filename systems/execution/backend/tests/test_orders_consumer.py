"""Tests for app/consumers/orders_consumer.py's _process_message dispatch
(Phase 4d of the options trading module added the instrument_type='option'
branch - see docs/architecture.md). No existing test file covered this
consumer before Phase 4d; SessionLocal/redis are both monkeypatched away
here rather than requiring a real DB/Redis connection, same "plain fakes"
preference the rest of this test suite uses."""

import threading
from contextlib import contextmanager
from datetime import datetime, timezone

import app.consumers.orders_consumer as consumer
from app.domain.models import ExecutionSettings


class FakeClient:
    def __init__(self, autoclaim_pages=None):
        self.acked = []
        # Each call to xautoclaim pops the next (cursor, claimed) page -
        # defaults to one empty page (nothing to reclaim), matching most
        # tests' needs; _reclaim_stale_pending tests override this.
        self._autoclaim_pages = list(autoclaim_pages) if autoclaim_pages is not None else [("0-0", [])]

    def xack(self, stream, group, message_id):
        self.acked.append(message_id)

    def xautoclaim(self, stream, group, consumer_name, min_idle_time, start_id, count):
        cursor, claimed = self._autoclaim_pages.pop(0)
        return cursor, claimed, []  # 3rd element: deleted-message ids, unused here


def _order_payload(instrument_type: str, **overrides) -> str:
    defaults = dict(
        signal_id="11111111-1111-1111-1111-111111111111",
        strategy_id="22222222-2222-2222-2222-222222222222",
        symbol="NIFTY",
        exchange="NSE",
        action="BUY",
        horizon="intraday",
        instrument_type=instrument_type,
        segment="NSE",
        price=24000.0,
        resolved_at=datetime.now(timezone.utc).isoformat(),
        status="pending",
    )
    defaults.update(overrides)
    import json

    return json.dumps(defaults)


def _patch_common(monkeypatch):
    @contextmanager
    def fake_session():
        yield object()  # never actually queried - load_settings/open_* are also faked below

    monkeypatch.setattr(consumer, "SessionLocal", fake_session)
    monkeypatch.setattr(consumer, "load_settings", lambda db: ExecutionSettings(timezone="Asia/Kolkata"))
    monkeypatch.setattr(consumer, "_client", FakeClient())


def test_process_message_dispatches_option_orders_to_open_option_group(monkeypatch):
    _patch_common(monkeypatch)
    calls = []
    monkeypatch.setattr(consumer, "open_option_group", lambda *a, **kw: calls.append("option"))
    monkeypatch.setattr(consumer, "open_position", lambda *a, **kw: calls.append("spot"))

    consumer._process_message("1-0", {"payload": _order_payload("option", strategy={"type": "bull_call_spread", "legs": []})})

    assert calls == ["option"]


def test_process_message_dispatches_spot_orders_to_open_position(monkeypatch):
    _patch_common(monkeypatch)
    calls = []
    monkeypatch.setattr(consumer, "open_option_group", lambda *a, **kw: calls.append("option"))
    monkeypatch.setattr(consumer, "open_position", lambda *a, **kw: calls.append("spot"))

    consumer._process_message("1-0", {"payload": _order_payload("spot")})

    assert calls == ["spot"]


def test_process_message_dispatches_future_orders_to_open_position(monkeypatch):
    _patch_common(monkeypatch)
    calls = []
    monkeypatch.setattr(consumer, "open_option_group", lambda *a, **kw: calls.append("option"))
    monkeypatch.setattr(consumer, "open_position", lambda *a, **kw: calls.append("spot"))

    consumer._process_message("1-0", {"payload": _order_payload("future")})

    assert calls == ["spot"]


def test_process_message_acks_after_processing(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(consumer, "open_option_group", lambda *a, **kw: None)
    monkeypatch.setattr(consumer, "open_position", lambda *a, **kw: None)

    consumer._process_message("5-0", {"payload": _order_payload("spot")})

    assert consumer._client.acked == ["5-0"]


# --- _reclaim_stale_pending (XAUTOCLAIM-based retry for messages a prior
# run left unacked - see the module docstring for why this exists) -------


def test_reclaim_reprocesses_and_acks_a_claimed_message(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(consumer, "open_option_group", lambda *a, **kw: None)
    monkeypatch.setattr(consumer, "open_position", lambda *a, **kw: None)
    claimed = [("9-0", {"payload": _order_payload("spot")})]
    monkeypatch.setattr(consumer, "_client", FakeClient(autoclaim_pages=[("0-0", claimed)]))

    consumer._reclaim_stale_pending()

    assert consumer._client.acked == ["9-0"]


def test_reclaim_walks_every_page_until_cursor_wraps_to_zero(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(consumer, "open_option_group", lambda *a, **kw: None)
    monkeypatch.setattr(consumer, "open_position", lambda *a, **kw: None)
    pages = [
        ("100-0", [("9-0", {"payload": _order_payload("spot")})]),
        ("0-0", [("10-0", {"payload": _order_payload("spot")})]),
    ]
    monkeypatch.setattr(consumer, "_client", FakeClient(autoclaim_pages=pages))

    consumer._reclaim_stale_pending()

    assert consumer._client.acked == ["9-0", "10-0"]


def test_reclaim_logs_and_continues_when_a_claimed_message_fails_again(monkeypatch):
    # A reclaimed message that fails again (still-down dependency) must
    # not crash the reclaim pass or the poll loop - it's left unacked
    # again, to be picked up by the next reclaim pass once
    # RECLAIM_MIN_IDLE_MS elapses again.
    _patch_common(monkeypatch)

    def _boom(*a, **kw):
        raise RuntimeError("still down")

    monkeypatch.setattr(consumer, "open_position", _boom)
    claimed = [("9-0", {"payload": _order_payload("spot")})]
    monkeypatch.setattr(consumer, "_client", FakeClient(autoclaim_pages=[("0-0", claimed)]))

    consumer._reclaim_stale_pending()  # must not raise

    assert consumer._client.acked == []


class _StoppingClient:
    """xreadgroup/xautoclaim fake that stops run()'s loop after a couple
    of iterations - just enough to prove _ensure_group() gets called more
    than once per run(), not just before the loop."""

    def __init__(self, stop_event: threading.Event):
        self._stop_event = stop_event
        self.xreadgroup_calls = 0

    def xautoclaim(self, stream, group, consumer_name, min_idle_time, start_id, count):
        return "0-0", [], []

    def xreadgroup(self, group, consumer_name, streams, count, block):
        self.xreadgroup_calls += 1
        if self.xreadgroup_calls >= 2:
            self._stop_event.set()
        return []


def test_run_recreates_the_consumer_group_every_iteration_not_just_once(monkeypatch):
    """Regression test for a real incident (2026-08-31, on the identical
    signal-engine twin of this consumer, deployed on the VPS): Redis lost
    the stream/consumer group while the thread kept running uninterrupted
    (a Redis restart with no persistence, or its container/volume being
    recreated) - _ensure_group() used to run only once, before the loop,
    so from that point on the thread NOGROUP-looped on every
    xautoclaim/xreadgroup call forever, with no way to recover short of
    restarting the whole service. Fixed by re-running _ensure_group()
    every iteration instead (a cheap no-op via BUSYGROUP once the group
    already exists) - this proves it's actually called more than once per
    run(), not just at startup."""
    ensure_group_calls = []
    monkeypatch.setattr(consumer, "_ensure_group", lambda: ensure_group_calls.append(1))

    stop_event = threading.Event()
    monkeypatch.setattr(consumer, "_client", _StoppingClient(stop_event))

    consumer.run(stop_event)

    assert len(ensure_group_calls) >= 2
