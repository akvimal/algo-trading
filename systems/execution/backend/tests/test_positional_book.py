"""The positional book: a hard-separate paper balance per user and segment for multi-day (positional, spot) trades.

Plain fakes and direct calls, like the rest of this backend."""

import uuid
from decimal import Decimal
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.domain import position_manager as pm
from app.domain.models import ManualPositionCreate

ME = uuid.UUID("11111111-1111-1111-1111-111111111111")


class FakeQuery:
    def __init__(self, rows):
        self.rows = rows

    def filter_by(self, **kw):
        self.kw = kw
        return self

    def one_or_none(self):
        return None

    def all(self):
        return []


class FakeDb:
    def __init__(self):
        self.added = []
        self.commits = 0

    def query(self, model):
        return FakeQuery([])

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        self.commits += 1


def test_a_positional_trade_by_a_user_lives_on_the_positional_book_everything_else_on_the_intraday_one():
    assert pm.book_of("positional", ME) == "positional"
    assert pm.book_of("intraday", ME) == "intraday"
    assert pm.book_of(None, ME) == "intraday"
    # the platform's own automated flow has a single account, whatever the horizon
    assert pm.book_of("positional", None) == "intraday"


def test_accounts_are_filed_under_their_old_key_except_the_positional_book():
    assert pm._account_key(ME, "NSE") == (ME, "NSE")
    assert pm._account_key(ME, "NSE", "positional") == (ME, "NSE", "positional")


def test_a_closing_trade_finds_the_account_of_its_own_book():
    intraday, positional = object(), object()
    accounts = {(ME, "NSE"): intraday, (ME, "NSE", "positional"): positional}
    spot_swing = SimpleNamespace(user_id=ME, segment="NSE", horizon="positional", strategy_id=None)
    spot_day = SimpleNamespace(user_id=ME, segment="NSE", horizon="intraday", strategy_id=None)
    assert pm._resolve_capital_account(spot_swing, accounts, {}) is positional
    assert pm._resolve_capital_account(spot_day, accounts, {}) is intraday


def test_the_positional_account_is_created_lazily_with_no_square_off_time():
    db = FakeDb()
    row = pm.load_account(db, ME, "NSE", "positional")
    assert row.book == "positional" and row.square_off_time is None and row.user_id == ME
    assert db.added == [row]
    # the intraday one keeps the segment's own cutoff, as before
    assert pm.load_account(FakeDb(), ME, "NSE").square_off_time is not None


def test_a_positional_order_must_be_spot_and_is_paper_only_in_the_request_model():
    base = dict(segment="NSE", symbol="RELIANCE", action="BUY", price=100)
    assert ManualPositionCreate(**base, instrument_type="spot", horizon="positional").horizon == "positional"
    assert ManualPositionCreate(**base, instrument_type="future").horizon == "intraday"
    with pytest.raises(ValidationError):
        ManualPositionCreate(**base, instrument_type="future", horizon="positional")


def _open(monkeypatch, *, instrument_type="spot", horizon="positional", intraday_window_open=False):
    seen = {"books": [], "rejections": []}
    account = SimpleNamespace(
        require_stop_loss=False, square_off_time=None, capital_per_trade=Decimal(50000), current_balance=Decimal(200000), leverage=Decimal(1),
        risk_per_trade_pct=Decimal(1), max_order_value=None, apply_charges=False, slippage_bps=Decimal(0), live_trading_enabled=False,
        mtf_annual_interest_rate_pct=None, leverage_buffer_pct=Decimal(10),
    )

    def fake_load_account(db, user_id, segment, book="intraday"):
        seen["books"].append(book)
        return account

    def fake_reject(db, user_id, signal_id, symbol, exchange, segment, action, instrument_type, price, reason):
        seen["rejections"].append(reason)
        return SimpleNamespace(status="REJECTED", rejection_reason=reason)

    monkeypatch.setattr(pm, "load_account", fake_load_account)
    monkeypatch.setattr(pm, "_reject_manual", fake_reject)
    # the intraday window: a positional trade must not even ask
    monkeypatch.setattr(pm, "is_within_intraday_window", lambda *a, **k: intraday_window_open)
    db = FakeDb()
    row = pm.open_manual_position(
        user_id=ME, segment="NSE", symbol="RELIANCE", action="BUY", instrument_type=instrument_type, price=100.0, quantity=10,
        stop_loss_price=95.0, settings=SimpleNamespace(timezone="Asia/Kolkata", usdinr_rate=None), db=db,
        resolve_underlying=lambda segment, symbol: None, horizon=horizon,
    )
    return row, seen, db


def test_a_positional_order_opens_on_the_positional_book_and_is_never_squared_off_or_blocked_by_the_intraday_window(monkeypatch):
    row, seen, db = _open(monkeypatch, horizon="positional", intraday_window_open=False)
    assert seen["rejections"] == []
    assert seen["books"] == ["positional"]
    assert row.horizon == "positional" and row.status == "OPEN" and row.square_off_time is None and row.is_live_broker_order is False


def test_an_intraday_order_still_uses_the_intraday_book_and_the_window(monkeypatch):
    row, seen, _ = _open(monkeypatch, horizon="intraday", intraday_window_open=False)
    assert seen["books"] == ["intraday"]
    assert row.status == "REJECTED" and "intraday window" in seen["rejections"][0]


def test_a_positional_future_is_refused(monkeypatch):
    row, seen, _ = _open(monkeypatch, instrument_type="future", horizon="positional")
    assert row.status == "REJECTED" and "must be spot" in seen["rejections"][0]
