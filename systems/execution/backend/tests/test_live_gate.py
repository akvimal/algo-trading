"""The server-side live-trading gate (app/domain/live_gate.py + the three
routes that can enable real-money orders in app/api/routes/accounts.py).

Plain fakes, direct route-function calls - same convention as the rest of this
backend's tests. `user_has_dhan_credentials` (an HTTP call to accounts) is
monkeypatched; nothing here touches a network or a DB.
"""

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.routes import accounts as accounts_route
from app.auth import User
from app.config import settings
from app.domain.live_gate import CONSENT_VERSION, LIVE_SEGMENTS, unmet_requirements
from app.domain.models import AccountUpdate, StrategyAccountUpdate

ME = uuid.UUID("11111111-1111-1111-1111-111111111111")
OTHER = uuid.UUID("22222222-2222-2222-2222-222222222222")


def user(uid=ME, admin=False):
    return User(id=uid, token="tok", is_admin=admin)


def gate(**over):
    args = dict(
        segment="NSE",
        max_order_value=50000.0,
        max_daily_loss=5000.0,
        kill_switch_on=False,
        is_transition_to_live=True,
        consent_given=True,
        has_broker_credentials=True,
        check_credentials=True,
    )
    args.update(over)
    return unmet_requirements(**args)


# --- the pure validator ---------------------------------------------------------------------


def test_everything_satisfied_is_allowed():
    assert gate() == []


def test_live_segments_are_nse_and_mcx_only():
    assert LIVE_SEGMENTS == ("NSE", "MCX")


def test_crypto_can_never_go_live_and_nothing_else_is_asked():
    problems = gate(segment="CRYPTO", max_order_value=None, consent_given=False)
    assert len(problems) == 1 and "only available for NSE and MCX" in problems[0]


def test_every_missing_requirement_is_listed_at_once():
    problems = gate(max_order_value=None, max_daily_loss=None, consent_given=False, has_broker_credentials=False)
    joined = " | ".join(problems)
    for needle in ("max order value", "max daily loss", "risk disclosure", "Dhan broker credentials"):
        assert needle in joined, needle
    assert len(problems) == 4


@pytest.mark.parametrize("bad", [None, 0, -5])
def test_caps_must_be_positive(bad):
    assert any("max order value" in p for p in gate(max_order_value=bad))
    assert any("max daily loss" in p for p in gate(max_daily_loss=bad))


def test_unverifiable_credentials_fail_closed():
    problems = gate(has_broker_credentials=None)
    assert len(problems) == 1 and "could not verify" in problems[0]


def test_credentials_not_checked_when_not_applicable():
    assert gate(has_broker_credentials=False, check_credentials=False) == []


def test_kill_switch_blocks_turning_on():
    assert any("kill switch" in p for p in gate(kill_switch_on=True))


def test_already_live_only_needs_the_caps():
    # consent, credentials and the kill switch are demanded only on off->on
    assert gate(is_transition_to_live=False, consent_given=False, has_broker_credentials=False, kill_switch_on=True) == []
    assert any("max order value" in p for p in gate(is_transition_to_live=False, max_order_value=None))


# --- fakes for the routes -----------------------------------------------------------------------


class FakeQuery:
    def filter_by(self, **kw):
        return self

    def all(self):
        return []


class FakeDb:
    def __init__(self, strategy_row=None):
        self.strategy_row = strategy_row
        self.committed = False

    def query(self, model):
        return FakeQuery()

    def get(self, model, key):
        return self.strategy_row

    def commit(self):
        self.committed = True

    def refresh(self, row):
        pass


def account_row(**over):
    row = SimpleNamespace(
        user_id=ME,
        segment="NSE",
        starting_balance=200000,
        current_balance=200000,
        capital_per_trade=50000,
        risk_per_trade_pct=1,
        min_reward_risk_ratio=4,
        enforce_risk_based_lots=False,
        leverage=1,
        leverage_buffer_pct=10,
        mtf_annual_interest_rate_pct=None,
        square_off_time=None,
        live_trading_enabled=False,
        live_trading_consent_at=None,
        live_trading_consent_version=None,
        require_stop_loss=False,
        apply_charges=True, slippage_bps=0,
        max_order_value=None,
        max_daily_loss=None,
        default_interval=None,
        default_higher_interval=None,
        updated_at=datetime.now(timezone.utc),
    )
    for k, v in over.items():
        setattr(row, k, v)
    return row


@pytest.fixture
def creds(monkeypatch):
    """Control what the accounts service says about the caller's Dhan creds."""
    state = {"value": True}
    monkeypatch.setattr(accounts_route, "user_has_dhan_credentials", lambda token: state["value"])
    return state


def put_account(row, update, segment="NSE", u=None, monkeypatch=None):
    accounts_route.load_account = lambda db, uid, seg: row
    return accounts_route.update_account(segment, update, user=u or user(), db=FakeDb())


@pytest.fixture(autouse=True)
def restore_load_account():
    original = accounts_route.load_account
    yield
    accounts_route.load_account = original


# --- personal account: PUT /accounts/{segment} ------------------------------------------------


def enable(**over):
    fields = dict(live_trading_enabled=True, max_order_value=50000, max_daily_loss=5000, live_trading_consent=True)
    fields.update(over)
    return AccountUpdate(**fields)


def test_enabling_live_with_everything_in_order_records_consent(creds):
    row = account_row()
    out = put_account(row, enable())
    assert row.live_trading_enabled is True
    assert row.live_trading_consent_version == CONSENT_VERSION
    assert row.live_trading_consent_at is not None
    assert out["live_trading_enabled"] is True and out["live_trading_consent_at"] is not None


def test_enabling_without_consent_is_refused_and_changes_nothing(creds):
    row = account_row()
    with pytest.raises(HTTPException) as exc:
        put_account(row, enable(live_trading_consent=None))
    assert exc.value.status_code == 422 and "risk disclosure" in exc.value.detail
    assert row.live_trading_enabled is False and row.live_trading_consent_at is None


def test_enabling_without_caps_lists_both_caps(creds):
    row = account_row()
    with pytest.raises(HTTPException) as exc:
        put_account(row, AccountUpdate(live_trading_enabled=True, live_trading_consent=True))
    assert "max order value" in exc.value.detail and "max daily loss" in exc.value.detail
    assert row.live_trading_enabled is False


def test_caps_already_stored_count(creds):
    row = account_row(max_order_value=1000, max_daily_loss=500)
    put_account(row, AccountUpdate(live_trading_enabled=True, live_trading_consent=True))
    assert row.live_trading_enabled is True


def test_enabling_without_saved_broker_credentials_is_refused(creds):
    creds["value"] = False
    with pytest.raises(HTTPException) as exc:
        put_account(account_row(), enable())
    assert "Dhan broker credentials" in exc.value.detail


def test_enabling_when_accounts_service_is_unreachable_is_refused(creds):
    creds["value"] = None
    with pytest.raises(HTTPException) as exc:
        put_account(account_row(), enable())
    assert "could not verify" in exc.value.detail


def test_crypto_cannot_be_enabled(creds):
    with pytest.raises(HTTPException) as exc:
        put_account(account_row(segment="CRYPTO"), enable(), segment="CRYPTO")
    assert "only available for NSE and MCX" in exc.value.detail


def test_kill_switch_blocks_enabling(creds, monkeypatch):
    monkeypatch.setattr(settings, "live_trading_kill_switch", True)
    with pytest.raises(HTTPException) as exc:
        put_account(account_row(), enable())
    assert "kill switch" in exc.value.detail


def test_disabling_live_is_always_allowed_even_with_nothing_set(creds):
    creds["value"] = None
    row = account_row(live_trading_enabled=True)  # grandfathered: live with no caps
    put_account(row, AccountUpdate(live_trading_enabled=False))
    assert row.live_trading_enabled is False


def test_cannot_blank_the_caps_of_a_live_account(creds):
    row = account_row(live_trading_enabled=True, max_order_value=1000, max_daily_loss=500)
    with pytest.raises(HTTPException) as exc:
        put_account(row, AccountUpdate(max_order_value=None))
    assert "max order value" in exc.value.detail


def test_editing_other_fields_of_a_live_account_needs_no_new_consent_or_credentials(creds):
    creds["value"] = None  # would fail closed if it were consulted
    row = account_row(live_trading_enabled=True, max_order_value=1000, max_daily_loss=500)
    put_account(row, AccountUpdate(capital_per_trade=20000))
    assert row.live_trading_enabled is True and float(row.capital_per_trade) == 20000


def test_paper_only_edits_are_unaffected(creds):
    creds["value"] = None
    row = account_row()
    put_account(row, AccountUpdate(capital_per_trade=20000, leverage=2))
    assert float(row.capital_per_trade) == 20000 and row.live_trading_enabled is False


def test_re_enabling_after_a_disable_demands_fresh_consent(creds):
    row = account_row(live_trading_enabled=False, max_order_value=1000, max_daily_loss=500, live_trading_consent_at=datetime.now(timezone.utc))
    with pytest.raises(HTTPException) as exc:
        put_account(row, AccountUpdate(live_trading_enabled=True))
    assert "risk disclosure" in exc.value.detail


# --- platform account ---------------------------------------------------------------------------


def put_platform(row, update):
    accounts_route.load_account = lambda db, uid, seg: row
    return accounts_route.update_platform_account("NSE", update, admin=user(admin=True), db=FakeDb())


def test_platform_account_can_never_be_enabled():
    row = account_row(user_id=None)
    with pytest.raises(HTTPException) as exc:
        put_platform(row, enable())
    assert exc.value.status_code == 422 and "platform account cannot trade live" in exc.value.detail
    assert row.live_trading_enabled is False


def test_platform_account_caps_stay_editable_and_it_can_be_switched_off():
    row = account_row(user_id=None, live_trading_enabled=True)
    put_platform(row, AccountUpdate(live_trading_enabled=False, max_order_value=1234))
    assert row.live_trading_enabled is False and float(row.max_order_value) == 1234


# --- strategy accounts ------------------------------------------------------------------------


def strategy_row(**over):
    row = SimpleNamespace(
        strategy_id=uuid.uuid4(),
        segment="NSE",
        starting_balance=200000,
        current_balance=200000,
        capital_per_trade=10000,
        risk_per_trade_pct=1,
        # The acting user owns the account by default: these tests are about the
        # live-trading rules, not visibility (see test_strategy_account_ownership.py).
        owner_user_id=ME,
        live_trading_user_id=None,
        live_trading_enabled=False,
        live_trading_consent_at=None,
        live_trading_consent_version=None,
        max_order_value=None,
        max_daily_loss=None,
        updated_at=datetime.now(timezone.utc),
    )
    for k, v in over.items():
        setattr(row, k, v)
    return row


def put_strategy(row, update, u):
    return accounts_route.update_strategy_account(str(row.strategy_id), update, user=u, db=FakeDb(strategy_row=row))


def strategy_enable(live_user=ME, **over):
    fields = dict(
        live_trading_user_id=str(live_user),
        live_trading_enabled=True,
        max_order_value=50000,
        max_daily_loss=5000,
        live_trading_consent=True,
    )
    fields.update(over)
    return StrategyAccountUpdate(**fields)


def test_strategy_account_owner_can_enable_live_on_their_own_broker(creds):
    row = strategy_row()
    put_strategy(row, strategy_enable(live_user=ME), user(ME))
    assert row.live_trading_enabled is True and row.live_trading_user_id == ME
    assert row.live_trading_consent_at is not None


def test_cannot_point_real_orders_at_someone_elses_broker(creds):
    row = strategy_row()
    with pytest.raises(HTTPException) as exc:
        put_strategy(row, strategy_enable(live_user=OTHER), user(ME))
    assert exc.value.status_code == 403 and row.live_trading_enabled is False


def test_an_admin_cannot_switch_live_on_for_another_user(creds):
    row = strategy_row(live_trading_user_id=OTHER)
    with pytest.raises(HTTPException) as exc:
        put_strategy(row, StrategyAccountUpdate(live_trading_enabled=True, max_order_value=1, max_daily_loss=1, live_trading_consent=True), user(uid=uuid.uuid4(), admin=True))
    assert exc.value.status_code == 403


def test_strategy_account_still_needs_consent_caps_and_credentials(creds):
    with pytest.raises(HTTPException) as exc:
        put_strategy(strategy_row(), strategy_enable(live_trading_consent=None), user(ME))
    assert "risk disclosure" in exc.value.detail
    creds["value"] = False
    with pytest.raises(HTTPException) as exc:
        put_strategy(strategy_row(), strategy_enable(), user(ME))
    assert "Dhan broker credentials" in exc.value.detail
    with pytest.raises(HTTPException) as exc:
        put_strategy(strategy_row(), StrategyAccountUpdate(live_trading_user_id=str(ME), live_trading_enabled=True, live_trading_consent=True), user(ME))
    assert "max order value" in exc.value.detail


def test_enabling_without_a_live_user_is_still_a_422(creds):
    with pytest.raises(HTTPException) as exc:
        put_strategy(strategy_row(), StrategyAccountUpdate(live_trading_enabled=True, max_order_value=1, max_daily_loss=1, live_trading_consent=True), user(ME))
    assert exc.value.status_code in (403, 422)


def test_admin_can_adjust_caps_on_an_already_live_account_of_another_user(creds):
    row = strategy_row(live_trading_user_id=OTHER, live_trading_enabled=True, max_order_value=1000, max_daily_loss=500)
    put_strategy(row, StrategyAccountUpdate(max_order_value=2000), user(uid=uuid.uuid4(), admin=True))
    assert float(row.max_order_value) == 2000


def test_a_stranger_cannot_touch_live_settings_of_a_live_account(creds):
    row = strategy_row(live_trading_user_id=OTHER, live_trading_enabled=True, max_order_value=1000, max_daily_loss=500)
    with pytest.raises(HTTPException) as exc:
        put_strategy(row, StrategyAccountUpdate(max_order_value=2000), user(ME))
    assert exc.value.status_code == 403 and float(row.max_order_value) == 1000


def test_paper_only_strategy_account_edits_are_unaffected(creds):
    creds["value"] = None
    row = strategy_row()
    put_strategy(row, StrategyAccountUpdate(capital_per_trade=5000, live_trading_enabled=False), user(ME))
    assert float(row.capital_per_trade) == 5000 and row.live_trading_enabled is False
