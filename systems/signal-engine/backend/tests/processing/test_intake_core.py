"""Tests for app/domain/intake/core.py's resolve_and_finalize_signal - in
particular the dict it hand-builds for publish_resolved_order (the
signal-processing -> execution contract, docs/contracts/resolved-order.schema.json).
That dict is NOT built from ResolvedOrderDraft.model_dump() - every field is
listed out by name - so adding a field to ResolvedOrderDraft (app/domain/models.py)
without also adding it here silently drops it off the wire. Reproduced live
2026-08-27: use_margin was added to ResolvedOrderDraft/the resolve() pipeline
but forgotten here, so every order silently published use_margin=False
regardless of the resolved Strategy's own value, until this was caught by a
real end-to-end webhook test. These tests exist to catch that class of bug
going forward - not just for use_margin, but for the whole publish dict."""

from datetime import datetime, timezone
from types import SimpleNamespace

import app.domain.processing.intake.core as core
from app.domain.processing.models import ResolvedOrderDraft, SignalIngest


class _FakeQuery:
    def __init__(self, row):
        self._row = row

    def filter_by(self, **kwargs):
        return self

    def one(self):
        return self._row


class _FakeDb:
    def __init__(self, row):
        self._row = row
        self.committed = False

    def query(self, model):
        return _FakeQuery(self._row)

    def commit(self):
        self.committed = True

    def refresh(self, row):
        pass


def _signal() -> SignalIngest:
    return SignalIngest(
        strategy_id="22222222-2222-2222-2222-222222222222",
        symbol="RELIANCE",
        exchange="NSE",
        action="BUY",
        price=2500.0,
        timestamp=datetime.now(timezone.utc),
        source="chartink",
    )


def _order_row():
    return SimpleNamespace(status="queued", rejection_reason=None, horizon=None, instrument_type=None, strategy=None, resolved_at=datetime.now(timezone.utc))


def test_resolve_and_finalize_signal_publishes_use_margin_true(monkeypatch):
    row = _order_row()
    db = _FakeDb(row)
    monkeypatch.setattr(
        core,
        "resolve",
        lambda signal, fetch_strategy: ResolvedOrderDraft(horizon="positional", instrument_type="spot", segment="NSE", use_margin=True),
    )
    published = {}
    monkeypatch.setattr(core, "publish_resolved_order", lambda payload: published.update(payload))

    core.resolve_and_finalize_signal(db, "11111111-1111-1111-1111-111111111111", _signal())

    assert published["use_margin"] is True


def test_resolve_and_finalize_signal_publishes_use_margin_false_by_default(monkeypatch):
    row = _order_row()
    db = _FakeDb(row)
    monkeypatch.setattr(
        core,
        "resolve",
        lambda signal, fetch_strategy: ResolvedOrderDraft(horizon="intraday", instrument_type="spot", segment="NSE"),
    )
    published = {}
    monkeypatch.setattr(core, "publish_resolved_order", lambda payload: published.update(payload))

    core.resolve_and_finalize_signal(db, "11111111-1111-1111-1111-111111111111", _signal())

    assert published["use_margin"] is False


def test_resolve_and_finalize_signal_publish_dict_matches_every_resolved_order_draft_field(monkeypatch):
    """Every field ResolvedOrderDraft declares (minus `strategy`, published
    under its own name already) must appear in the published payload -
    guards the whole class of "added a field, forgot this dict" bug, not
    just use_margin specifically."""
    row = _order_row()
    db = _FakeDb(row)
    monkeypatch.setattr(
        core,
        "resolve",
        lambda signal, fetch_strategy: ResolvedOrderDraft(horizon="intraday", instrument_type="spot", segment="NSE"),
    )
    published = {}
    monkeypatch.setattr(core, "publish_resolved_order", lambda payload: published.update(payload))

    core.resolve_and_finalize_signal(db, "11111111-1111-1111-1111-111111111111", _signal())

    draft_fields = set(ResolvedOrderDraft.model_fields.keys())
    assert draft_fields <= set(published.keys())
