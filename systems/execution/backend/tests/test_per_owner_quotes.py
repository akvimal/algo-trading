"""Per-owner quote fetching (own-keys data model, execution side).

Two changes, tested here:
  * the automated jobs (exit monitor, square-off, P&L and equity snapshots, the
    pending-order watcher) can fetch quotes in one batch PER OWNER on that owner's
    own Dhan keys (X-On-Behalf-Of) instead of one batch for everyone on the shared
    platform credential - behind JOB_QUOTES_USE_OWNER_KEYS, off by default, with a
    platform fallback so an owner whose keys are missing/expired still has their
    stop-losses enforced;
  * the three user-facing live-P&L views now forward the caller's own token, so a
    browser polling its grid spends the USER's budget, not the platform's."""

import functools
import uuid
from types import SimpleNamespace

import pytest

from app.adapters.quotes import client as qc
from app.api.routes import accounts as accounts_route
from app.api.routes import option_groups as groups_route
from app.api.routes import positions as positions_route
from app.config import settings
from app.domain import pending_orders as po
from app.domain import position_manager as pm

ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
BOB = uuid.UUID("22222222-2222-2222-2222-222222222222")
SECRET = "a-real-shared-secret-value"


# --- the client header -------------------------------------------------------------------------------------------------------------


def test_on_behalf_of_travels_with_the_internal_secret_and_a_user_token_when_given(monkeypatch):
    monkeypatch.setattr(settings, "internal_service_secret", SECRET)
    assert qc._auth_headers(None) == {"X-Internal-Secret": SECRET}
    assert qc._auth_headers(None, ALICE) == {"X-Internal-Secret": SECRET, "X-On-Behalf-Of": str(ALICE)}
    assert qc._auth_headers("jwt", ALICE) == {"X-Internal-Secret": SECRET, "X-On-Behalf-Of": str(ALICE), "Authorization": "Bearer jwt"}


def test_without_a_configured_secret_no_on_behalf_of_is_sent(monkeypatch):
    """market-data would ignore it from an untrusted caller anyway; do not advertise it."""
    monkeypatch.setattr(settings, "internal_service_secret", "")
    assert qc._auth_headers(None, ALICE) == {}


def test_get_ltp_batch_sends_the_header(monkeypatch):
    monkeypatch.setattr(settings, "internal_service_secret", SECRET)
    seen = {}

    class R:
        def raise_for_status(self):
            pass

        def json(self):
            return {"prices": {"TCS": 1.0}}

    monkeypatch.setattr(qc.requests, "post", lambda url, **kw: seen.update(kw) or R())
    assert qc.get_ltp_batch("NSE", ["TCS"], on_behalf_of=ALICE) == {"TCS": 1.0}
    assert seen["headers"]["X-On-Behalf-Of"] == str(ALICE)


# --- the shared quote helper --------------------------------------------------------------------------------------------------------


def pos(symbol="TCS", owner=ALICE, exchange="NSE"):
    return SimpleNamespace(exchange=exchange, symbol=symbol, user_id=owner)


class Recorder:
    """A get_ltp_batch double: records each call, answers from `prices` (per owner, or the platform's)."""

    def __init__(self, by_owner=None, platform=None, boom_for=()):
        self.calls = []
        self.by_owner = by_owner or {}
        self.platform = platform if platform is not None else {}
        self.boom_for = set(boom_for)

    def __call__(self, exchange, symbols, on_behalf_of=None):
        self.calls.append((exchange, sorted(symbols), on_behalf_of))
        if on_behalf_of in self.boom_for:
            raise RuntimeError("market-data down")
        source = self.by_owner.get(on_behalf_of, {}) if on_behalf_of is not None else self.platform
        return {s: source[s] for s in symbols if s in source}


@pytest.fixture
def owner_mode(monkeypatch):
    def set_mode(on: bool, fallback: bool = True):
        monkeypatch.setattr(settings, "job_quotes_use_owner_keys", on)
        monkeypatch.setattr(settings, "job_quotes_platform_fallback", fallback)

    return set_mode


def test_defaults_are_off_with_the_fallback_on():
    assert settings.job_quotes_use_owner_keys is False and settings.job_quotes_platform_fallback is True


def test_flag_off_is_one_platform_batch_per_exchange_whoever_owns_the_positions(owner_mode):
    owner_mode(False)
    rec = Recorder(platform={"TCS": 10.0, "INFY": 20.0})
    quotes = pm._quotes_by_exchange([pos("TCS", ALICE), pos("INFY", BOB)], lambda ex, syms: rec(ex, syms))
    assert quotes == {("NSE", "TCS"): 10.0, ("NSE", "INFY"): 20.0}
    assert rec.calls == [("NSE", ["INFY", "TCS"], None)]  # ONE call, no owner: exactly the old behaviour


def test_flag_on_each_owner_is_fetched_on_their_own_keys(owner_mode):
    owner_mode(True)
    rec = Recorder(by_owner={ALICE: {"TCS": 10.0}, BOB: {"INFY": 20.0}})
    quotes = pm._quotes_by_exchange([pos("TCS", ALICE), pos("INFY", BOB)], rec)
    assert quotes == {("NSE", "TCS"): 10.0, ("NSE", "INFY"): 20.0}
    assert sorted(rec.calls, key=lambda c: str(c[2])) == [("NSE", ["TCS"], ALICE), ("NSE", ["INFY"], BOB)]


def test_flag_on_two_owners_of_the_same_symbol_are_each_fetched_on_their_own_budget(owner_mode):
    owner_mode(True)
    rec = Recorder(by_owner={ALICE: {"TCS": 10.0}, BOB: {"TCS": 10.0}})
    pm._quotes_by_exchange([pos("TCS", ALICE), pos("TCS", BOB)], rec)
    assert sorted(c[2] for c in rec.calls) == sorted([ALICE, BOB])


def test_flag_on_one_owners_symbols_on_one_exchange_are_still_one_batch(owner_mode):
    owner_mode(True)
    rec = Recorder(by_owner={ALICE: {"TCS": 1.0, "INFY": 2.0}})
    pm._quotes_by_exchange([pos("TCS", ALICE), pos("INFY", ALICE)], rec)
    assert rec.calls == [("NSE", ["INFY", "TCS"], ALICE)]


def test_flag_on_positions_with_no_owner_use_the_platform_credential(owner_mode):
    owner_mode(True)
    rec = Recorder(platform={"TCS": 5.0})
    quotes = pm._quotes_by_exchange([pos("TCS", None)], rec)
    assert quotes == {("NSE", "TCS"): 5.0} and rec.calls == [("NSE", ["TCS"], None)]


def test_an_owner_with_no_usable_keys_falls_back_to_the_platform_so_their_stop_is_still_enforced(owner_mode):
    owner_mode(True, fallback=True)
    rec = Recorder(by_owner={ALICE: {}}, platform={"TCS": 10.0})  # Alice's own batch comes back empty (expired token)
    quotes = pm._quotes_by_exchange([pos("TCS", ALICE)], rec)
    assert quotes == {("NSE", "TCS"): 10.0}
    assert rec.calls == [("NSE", ["TCS"], ALICE), ("NSE", ["TCS"], None)]


def test_no_fallback_is_strict(owner_mode):
    owner_mode(True, fallback=False)
    rec = Recorder(by_owner={ALICE: {}}, platform={"TCS": 10.0})
    assert pm._quotes_by_exchange([pos("TCS", ALICE)], rec) == {}
    assert rec.calls == [("NSE", ["TCS"], ALICE)]  # the platform credential is never touched


def test_a_good_owner_batch_never_triggers_the_fallback(owner_mode):
    owner_mode(True, fallback=True)
    rec = Recorder(by_owner={ALICE: {"TCS": 10.0}}, platform={"TCS": 99.0})
    assert pm._quotes_by_exchange([pos("TCS", ALICE)], rec) == {("NSE", "TCS"): 10.0}
    assert len(rec.calls) == 1


def test_one_owners_failure_does_not_stop_the_others(owner_mode):
    owner_mode(True)
    rec = Recorder(by_owner={BOB: {"INFY": 20.0}}, boom_for=[ALICE])
    quotes = pm._quotes_by_exchange([pos("TCS", ALICE), pos("INFY", BOB)], rec)
    assert quotes == {("NSE", "INFY"): 20.0}


def test_compute_unrealized_pnl_values_each_position_on_its_owners_keys(owner_mode):
    owner_mode(True)
    rec = Recorder(by_owner={ALICE: {"TCS": 110.0}, BOB: {"TCS": 110.0}})
    long_a = SimpleNamespace(id=1, status="OPEN", exchange="NSE", symbol="TCS", user_id=ALICE, action="BUY", entry_price=100.0, quantity=10)
    long_b = SimpleNamespace(id=2, status="OPEN", exchange="NSE", symbol="TCS", user_id=BOB, action="BUY", entry_price=100.0, quantity=5)
    out = pm.compute_unrealized_pnl([long_a, long_b], rec)
    assert out[1] == (110.0, 100.0) and out[2] == (110.0, 50.0)
    assert sorted(c[2] for c in rec.calls) == sorted([ALICE, BOB])


# --- the pending-order watcher -----------------------------------------------------------------------------------------------------------


def test_the_default_watcher_feed_reads_on_the_owners_keys_and_falls_back(monkeypatch):
    from app.adapters.quotes import client as client_module

    calls = []

    def get_batch(exchange, symbols, token=None, on_behalf_of=None):
        calls.append((token, on_behalf_of))
        return {} if on_behalf_of == ALICE else {"NIFTY-SPOT": 24000.0}  # Alice's own keys give nothing; the platform's do

    monkeypatch.setattr(client_module, "resolve_underlying", lambda segment, symbol: {"chart_exchange": "NSE", "chart_symbol": "NIFTY-SPOT"})
    monkeypatch.setattr(client_module, "get_ltp_batch", get_batch)
    po._resolve_cache.clear()
    feed = po.default_deps().underlying_ltp

    monkeypatch.setattr(settings, "job_quotes_platform_fallback", True)
    assert feed("NSE", "NIFTY", owner=ALICE) == 24000.0
    assert calls == [(None, ALICE), (None, None)]  # her keys first, then the platform's

    calls.clear()
    monkeypatch.setattr(settings, "job_quotes_platform_fallback", False)
    with pytest.raises(po.UnderlyingUnavailable):
        feed("NSE", "NIFTY", owner=ALICE)
    assert calls == [(None, ALICE)]

    calls.clear()
    assert feed("NSE", "NIFTY", token="user-jwt") == 24000.0 and calls == [("user-jwt", None)]  # a user arming an order: their token


def _order(owner, symbol="NIFTY"):
    return SimpleNamespace(id=uuid.uuid4(), user_id=owner, segment="NSE", symbol=symbol, status="pending", started_above=True, trigger_price=100.0,
                           expires_at=po._now().replace(year=2099), last_price=None, last_checked_at=None)


def test_the_watcher_prices_per_owner_only_when_the_flag_is_on(monkeypatch):
    from tests.test_pending_orders import FakeDb, fake_deps

    for flag, expected in ((False, 1), (True, 2)):
        monkeypatch.setattr(settings, "job_quotes_use_owner_keys", flag)
        db = FakeDb()
        for owner in (ALICE, BOB):
            row = _order(owner)
            db.rows.append(row)
        deps = fake_deps({("NSE", "NIFTY"): 105.0})
        po.process_pending_orders(db, deps)
        assert len(deps.log.price_calls) == expected, flag


def test_arming_reads_the_price_on_the_callers_own_token():
    from tests.test_pending_orders import FakeDb, body, fake_deps

    tokens = []
    deps = fake_deps({("NSE", "NIFTY"): 105.0})
    inner = deps.underlying_ltp
    deps.underlying_ltp = lambda segment, symbol, token=None, owner=None: tokens.append(token) or inner(segment, symbol)
    po.create_pending_order(FakeDb(), ALICE, body(), deps, False, token="alice-jwt")
    assert tokens == ["alice-jwt"]


# --- the user-facing live-P&L views ----------------------------------------------------------------------------------------------------------


class Chain:
    """db.query(...).filter_by(...).filter(...).order_by(...).limit(...).all() -> []"""

    def __getattr__(self, name):
        return lambda *a, **k: self

    def all(self):
        return []


class ChainDb:
    def query(self, model):
        return Chain()


def capture_quote_fn(monkeypatch, module, name):
    """Replace the mark-to-market function with one that hands back the quote callable it was given."""
    seen = {}
    monkeypatch.setattr(module, name, lambda rows, *rest: seen.update(quote=rest[-1]) or {})
    return seen


def bound_call(monkeypatch, module, quote_fn):
    """The token the quote callable is bound to: the route builds functools.partial(get_ltp_batch,
    token=...) for a user, and hands the plain client function on for the platform view."""
    if isinstance(quote_fn, functools.partial):
        assert quote_fn.func is qc.get_ltp_batch  # it wraps the real client, nothing else
        return quote_fn.keywords.get("token")
    assert quote_fn is qc.get_ltp_batch
    return None


def test_the_positions_view_values_positions_on_the_callers_token(monkeypatch):
    seen = {}
    monkeypatch.setattr(positions_route, "compute_unrealized_pnl", lambda rows, quote: seen.update(quote=quote) or {})
    positions_route._query_positions(ChainDb(), ALICE, None, None, None, None, False, 10, True, token="alice-jwt")
    assert bound_call(monkeypatch, positions_route, seen["quote"]) == "alice-jwt"


def test_the_platform_positions_view_has_no_token(monkeypatch):
    seen = {}
    monkeypatch.setattr(positions_route, "compute_unrealized_pnl", lambda rows, quote: seen.update(quote=quote) or {})
    positions_route._query_positions(ChainDb(), None, None, None, None, None, False, 10, True)
    assert bound_call(monkeypatch, positions_route, seen["quote"]) is None


def test_the_option_groups_view_values_groups_on_the_callers_token(monkeypatch):
    seen = {}
    monkeypatch.setattr(groups_route, "legs_by_group", lambda db, rows: {})
    monkeypatch.setattr(groups_route, "compute_group_unrealized_pnl", lambda rows, legs, quote: seen.update(quote=quote) or {})
    groups_route._query_option_groups(ChainDb(), ALICE, None, None, None, None, False, 10, True, token="alice-jwt")
    assert bound_call(monkeypatch, groups_route, seen["quote"]) == "alice-jwt"


def test_the_account_summary_values_open_positions_on_the_callers_token(monkeypatch):
    seen = {}
    monkeypatch.setattr(accounts_route, "compute_unrealized_pnl", lambda rows, quote: seen.update(quote=quote) or {})
    assert accounts_route._unrealized_pnl(ChainDb(), [SimpleNamespace()], "alice-jwt") == 0.0
    assert bound_call(monkeypatch, accounts_route, seen["quote"]) == "alice-jwt"
    accounts_route._unrealized_pnl(ChainDb(), [SimpleNamespace()])  # no token: unchanged
    assert bound_call(monkeypatch, accounts_route, seen["quote"]) is None


def test_the_user_scoped_account_routes_pass_the_token_through(monkeypatch):
    received = []
    monkeypatch.setattr(accounts_route, "_unrealized_pnl", lambda db, open_positions, token=None: received.append(token) or 0.0)
    row = SimpleNamespace(user_id=ALICE, segment="NSE", starting_balance=1, current_balance=1, capital_per_trade=1, risk_per_trade_pct=1,
                          min_reward_risk_ratio=4, enforce_risk_based_lots=False, leverage=1, leverage_buffer_pct=10, mtf_annual_interest_rate_pct=None,
                          square_off_time=None, live_trading_enabled=False, live_trading_consent_at=None, require_stop_loss=False, apply_charges=True,
                          slippage_bps=0, max_order_value=None, max_daily_loss=None, default_interval=None, default_higher_interval=None,
                          updated_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc))
    accounts_route._to_out(ChainDb(), row, token="alice-jwt")
    accounts_route._to_out(ChainDb(), row)
    assert received == ["alice-jwt", None]
