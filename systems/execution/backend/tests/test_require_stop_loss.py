"""Per-account "require a stop-loss" switch on manual spot/future orders
(accounts.require_stop_loss, checked in position_manager.open_manual_position).

The function is deliberately not run end to end (it needs a live DB and
market data). A spot order reaches the new check after only an
instrument-support check and the account load, so those two are faked, and
`_reject_manual` is captured: a refusal for the stop-loss reason proves the
gate fired; a refusal for a DIFFERENT (later) reason proves the order got
past it.
"""

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.adapters.db import models as db_models
from app.api.routes import accounts as accounts_route
from app.auth import User
from app.domain import position_manager as pm
from app.domain.models import AccountUpdate

ME = uuid.UUID("11111111-1111-1111-1111-111111111111")
SL_REASON = "a stop-loss is required"


class FakeDb:
    def commit(self):
        pass


def run(monkeypatch, *, require, **order):
    """Calls open_manual_position for a plain NSE spot BUY and returns the
    list of rejection reasons recorded."""
    reasons = []
    account = SimpleNamespace(require_stop_loss=require, square_off_time=None)
    monkeypatch.setattr(pm, "load_account", lambda db, user_id, segment: account)
    # Anything after the stop-loss gate: make the very next gate reject with a
    # distinguishable reason so a pass-through is observable.
    monkeypatch.setattr(pm, "is_within_intraday_window", lambda *a, **k: False)

    def fake_reject(db, user_id, signal_id, symbol, exchange, segment, action, instrument_type, price, reason):
        reasons.append(reason)
        return SimpleNamespace(status="REJECTED", rejection_reason=reason)

    monkeypatch.setattr(pm, "_reject_manual", fake_reject)
    args = dict(
        user_id=ME,
        segment="NSE",
        symbol="RELIANCE",
        action="BUY",
        instrument_type="spot",
        price=100.0,
        quantity=None,
        stop_loss_price=None,
        settings=SimpleNamespace(timezone="Asia/Kolkata"),
        db=FakeDb(),
        resolve_underlying=lambda segment, symbol: None,
    )
    args.update(order)
    pm.open_manual_position(**args)
    return reasons


def test_order_without_a_stop_is_refused_when_the_switch_is_on(monkeypatch):
    reasons = run(monkeypatch, require=True)
    assert len(reasons) == 1 and SL_REASON in reasons[0]


def test_refusal_says_how_to_fix_it(monkeypatch):
    assert "turn off 'Require a stop-loss'" in run(monkeypatch, require=True)[0]


def test_a_stop_price_satisfies_it(monkeypatch):
    reasons = run(monkeypatch, require=True, stop_loss_price=95.0)
    assert reasons and all(SL_REASON not in r for r in reasons)


def test_a_stop_method_satisfies_it(monkeypatch):
    reasons = run(monkeypatch, require=True, stop_loss_method="percent", stop_loss_percent=2.0)
    assert reasons and all(SL_REASON not in r for r in reasons)


def test_switch_off_leaves_behavior_unchanged(monkeypatch):
    reasons = run(monkeypatch, require=False)
    assert reasons and all(SL_REASON not in r for r in reasons)


# --- the column and the route ---------------------------------------------------------------------


def test_new_accounts_default_to_on_but_the_migration_leaves_existing_off():
    col = db_models.Account.__table__.c.require_stop_loss
    assert col.default.arg is True  # accounts created through the ORM (new users) start ON
    assert str(col.server_default.arg) == "true"  # and so do raw inserts, once migration 016 flips the default
    assert col.nullable is False


def test_strategy_accounts_are_not_covered():
    assert not hasattr(db_models.StrategyAccount, "require_stop_loss")


def _account_row(**over):
    row = SimpleNamespace(
        user_id=ME, segment="NSE", starting_balance=200000, current_balance=200000, capital_per_trade=50000,
        risk_per_trade_pct=1, min_reward_risk_ratio=4, enforce_risk_based_lots=False, leverage=1,
        leverage_buffer_pct=10, mtf_annual_interest_rate_pct=None, square_off_time=None,
        live_trading_enabled=False, live_trading_consent_at=None, live_trading_consent_version=None,
        require_stop_loss=False, apply_charges=True, slippage_bps=0, max_order_value=None, max_daily_loss=None, default_interval=None,
        default_higher_interval=None, updated_at=datetime.now(timezone.utc),
    )
    for k, v in over.items():
        setattr(row, k, v)
    return row


class RouteDb:
    def query(self, model):
        return SimpleNamespace(filter_by=lambda **kw: SimpleNamespace(all=lambda: []))

    def commit(self):
        pass

    def refresh(self, row):
        pass


@pytest.fixture
def account_route(monkeypatch):
    original = accounts_route.load_account
    yield
    accounts_route.load_account = original


def test_the_route_toggles_and_reports_the_switch(account_route):
    row = _account_row(require_stop_loss=False)
    accounts_route.load_account = lambda db, uid, seg: row
    user = User(id=ME, token="t", is_admin=False)
    out = accounts_route.update_account("NSE", AccountUpdate(require_stop_loss=True), user=user, db=RouteDb())
    assert row.require_stop_loss is True and out["require_stop_loss"] is True
    out = accounts_route.update_account("NSE", AccountUpdate(require_stop_loss=False), user=user, db=RouteDb())
    assert row.require_stop_loss is False and out["require_stop_loss"] is False


def test_omitting_the_field_leaves_it_unchanged(account_route):
    row = _account_row(require_stop_loss=True)
    accounts_route.load_account = lambda db, uid, seg: row
    accounts_route.update_account("NSE", AccountUpdate(capital_per_trade=1234), user=User(id=ME, token="t"), db=RouteDb())
    assert row.require_stop_loss is True
