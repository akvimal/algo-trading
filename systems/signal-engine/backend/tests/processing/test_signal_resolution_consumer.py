"""Tests for app/consumers/signal_resolution_consumer.py's _process_message
dispatch - moves resolve()'s Dhan-throttled option-chain calls off the
webhook/POST /signals request-response cycle (see
app/domain/intake/core.py's create_signal_from_ingest/resolve_and_finalize_signal
split). SessionLocal/redis are both monkeypatched away here rather than
requiring a real DB/Redis connection - same "plain fakes" pattern
execution/backend/tests/test_orders_consumer.py already uses for the
analogous orders.resolved consumer."""

import json
from contextlib import contextmanager
from datetime import datetime, timezone

import app.consumers.signal_resolution_consumer as consumer


class FakeClient:
    def __init__(self, autoclaim_pages=None):
        self.acked = []
        self._autoclaim_pages = list(autoclaim_pages) if autoclaim_pages is not None else [("0-0", [])]

    def xack(self, stream, group, message_id):
        self.acked.append(message_id)

    def xautoclaim(self, stream, group, consumer_name, min_idle_time, start_id, count):
        cursor, claimed = self._autoclaim_pages.pop(0)
        return cursor, claimed, []  # 3rd element: deleted-message ids, unused here


def _signal_payload(**overrides) -> str:
    defaults = dict(
        strategy_id="22222222-2222-2222-2222-222222222222",
        symbol="RELIANCE",
        exchange="NSE",
        action="BUY",
        price=2500.0,
        timestamp=datetime.now(timezone.utc).isoformat(),
        source="chartink",
        source_meta={"scan_name": "Bullish Breakout"},
    )
    defaults.update(overrides)
    return json.dumps(defaults)


def _patch_common(monkeypatch):
    @contextmanager
    def fake_session():
        yield object()  # never actually queried - resolve_and_finalize_signal is faked below

    monkeypatch.setattr(consumer, "SessionLocal", fake_session)
    monkeypatch.setattr(consumer, "_client", FakeClient())


def test_process_message_calls_resolve_and_finalize_signal_with_parsed_signal(monkeypatch):
    _patch_common(monkeypatch)
    calls = []
    monkeypatch.setattr(
        consumer,
        "resolve_and_finalize_signal",
        lambda db, signal_id, signal: calls.append((signal_id, signal.symbol, signal.strategy_id)),
    )

    consumer._process_message(
        "1-0", {"signal_id": "11111111-1111-1111-1111-111111111111", "payload": _signal_payload()}
    )

    assert calls == [("11111111-1111-1111-1111-111111111111", "RELIANCE", "22222222-2222-2222-2222-222222222222")]


def test_process_message_acks_after_processing(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(consumer, "resolve_and_finalize_signal", lambda db, signal_id, signal: None)

    consumer._process_message("5-0", {"signal_id": "11111111-1111-1111-1111-111111111111", "payload": _signal_payload()})

    assert consumer._client.acked == ["5-0"]


def test_process_message_does_not_ack_if_resolution_raises(monkeypatch):
    """Matches orders_consumer.py's own semantics: an exception during
    processing must propagate (leaving the message unacked for Redis
    Streams redelivery) rather than being swallowed here - run()'s own
    try/except around _process_message is what actually handles this."""

    def _raise(db, signal_id, signal):
        raise RuntimeError("boom")

    _patch_common(monkeypatch)
    monkeypatch.setattr(consumer, "resolve_and_finalize_signal", _raise)

    try:
        consumer._process_message("9-0", {"signal_id": "11111111-1111-1111-1111-111111111111", "payload": _signal_payload()})
        assert False, "expected RuntimeError to propagate"
    except RuntimeError:
        pass

    assert consumer._client.acked == []


# --- _reclaim_stale_pending (XAUTOCLAIM-based retry - see
# app/consumers/orders_consumer.py's identical function/docstring for why
# this exists) ------------------------------------------------------------


def test_reclaim_reprocesses_and_acks_a_claimed_message(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(consumer, "resolve_and_finalize_signal", lambda db, signal_id, signal: None)
    claimed = [("9-0", {"signal_id": "11111111-1111-1111-1111-111111111111", "payload": _signal_payload()})]
    monkeypatch.setattr(consumer, "_client", FakeClient(autoclaim_pages=[("0-0", claimed)]))

    consumer._reclaim_stale_pending()

    assert consumer._client.acked == ["9-0"]


def test_reclaim_logs_and_continues_when_a_claimed_message_fails_again(monkeypatch):
    _patch_common(monkeypatch)

    def _raise(db, signal_id, signal):
        raise RuntimeError("still down")

    monkeypatch.setattr(consumer, "resolve_and_finalize_signal", _raise)
    claimed = [("9-0", {"signal_id": "11111111-1111-1111-1111-111111111111", "payload": _signal_payload()})]
    monkeypatch.setattr(consumer, "_client", FakeClient(autoclaim_pages=[("0-0", claimed)]))

    consumer._reclaim_stale_pending()  # must not raise

    assert consumer._client.acked == []
