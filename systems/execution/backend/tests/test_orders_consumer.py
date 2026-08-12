"""Tests for app/consumers/orders_consumer.py's _process_message dispatch
(Phase 4d of the options trading module added the instrument_type='option'
branch - see docs/architecture.md). No existing test file covered this
consumer before Phase 4d; SessionLocal/redis are both monkeypatched away
here rather than requiring a real DB/Redis connection, same "plain fakes"
preference the rest of this test suite uses."""

from contextlib import contextmanager
from datetime import datetime, timezone

import app.consumers.orders_consumer as consumer
from app.domain.models import ExecutionSettings


class FakeClient:
    def __init__(self):
        self.acked = []

    def xack(self, stream, group, message_id):
        self.acked.append(message_id)


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
