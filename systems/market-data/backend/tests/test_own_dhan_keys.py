"""The own-keys data model (app/data_access.py, app/auth.py's Caller, the quote
WebSocket): with REQUIRE_OWN_DHAN_KEYS on, live Dhan-backed market data is only
served to a signed-in user on their OWN saved keys and never falls back to the
shared platform credential; trusted internal services may still use the platform
credential or act on behalf of one user. Off by default, and then nothing changes.

Plain fakes, no TestClient (the convention of this suite): the routes are called
directly, with the accounts lookup and the provider faked."""

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import jwt
import pytest
from fastapi import HTTPException

from app import data_access
from app.adapters.accounts_client import CredentialLookupFailed
from app.api.routes import candles as candles_route
from app.api.routes import options as options_route
from app.api.routes import order_blocks as ob_route
from app.api.routes import quotes as quotes_route
from app.api.routes import quotes_ws
from app.api.routes import regime as regime_route
from app.auth import Caller, get_caller, user_id_from_token
from app.config import settings
from app.domain.models import BatchQuoteRequest, Candle
from app.providers.dhan import DhanCredentials

ALICE = uuid.UUID("11111111-1111-1111-1111-111111111111")
BOB = uuid.UUID("22222222-2222-2222-2222-222222222222")
CAROL = uuid.UUID("33333333-3333-3333-3333-333333333333")
ALICE_KEYS = DhanCredentials(client_id="alice-client", access_token="alice-token", throttle_key=str(ALICE))

ANON = Caller()
SIGNED_IN_ALICE = Caller(user_id=ALICE)
SIGNED_IN_BOB = Caller(user_id=BOB)  # no saved keys
SERVICE = Caller(trusted_service=True)
SERVICE_FOR_ALICE = Caller(trusted_service=True, on_behalf_of=ALICE)
SERVICE_FOR_BOB = Caller(trusted_service=True, on_behalf_of=BOB)


@pytest.fixture
def accounts(monkeypatch):
    """The accounts lookup: ALICE has keys, BOB has none, CAROL's lookup fails (accounts down)."""
    calls = []

    def fake(user_id, raise_on_failure=False):
        calls.append((user_id, raise_on_failure))
        if user_id == CAROL:
            if raise_on_failure:
                raise CredentialLookupFailed("accounts unreachable")
            return None  # the old behaviour: an outage looks like "no keys" -> platform
        return ALICE_KEYS if user_id == ALICE else None

    monkeypatch.setattr(data_access, "get_user_dhan_credentials", fake)
    return calls


@pytest.fixture
def flag(monkeypatch):
    def set_flag(on: bool):
        monkeypatch.setattr(settings, "require_own_dhan_keys", on)

    return set_flag


def code_of(exc: HTTPException):
    return (exc.headers or {}).get("X-Error-Code")


# --- who is calling -----------------------------------------------------------------------------------------------------------


def bearer(uid):
    token = jwt.encode({"sub": str(uid), "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return SimpleNamespace(credentials=token)


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setattr(settings, "internal_service_secret", "a-real-shared-secret-value")
    return "a-real-shared-secret-value"


def test_no_headers_is_an_anonymous_caller():
    assert get_caller(None, None, None) == Caller()


def test_a_valid_token_identifies_the_user_and_a_bad_one_is_anonymous():
    assert get_caller(bearer(ALICE), None, None).user_id == ALICE
    assert get_caller(SimpleNamespace(credentials="garbage"), None, None) == Caller()
    assert user_id_from_token(None) is None and user_id_from_token("") is None and user_id_from_token("x.y.z") is None
    expired = jwt.encode({"sub": str(ALICE), "exp": datetime.now(timezone.utc) - timedelta(minutes=1)}, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    assert user_id_from_token(expired) is None


def test_the_shared_secret_makes_a_caller_a_trusted_service(secret):
    assert get_caller(None, secret, None).trusted_service is True
    assert get_caller(None, "wrong-secret", None).trusted_service is False
    assert get_caller(None, "", None).trusted_service is False


def test_an_empty_configured_secret_never_trusts_anyone(monkeypatch):
    monkeypatch.setattr(settings, "internal_service_secret", "")
    assert get_caller(None, "", None).trusted_service is False and get_caller(None, "anything", None).trusted_service is False


def test_on_behalf_of_is_honoured_only_for_a_trusted_service(secret):
    assert get_caller(None, secret, str(ALICE)).on_behalf_of == ALICE
    assert get_caller(None, "wrong-secret", str(ALICE)).on_behalf_of is None  # a browser cannot claim to be a user
    assert get_caller(bearer(BOB), None, str(ALICE)).on_behalf_of is None


def test_a_malformed_on_behalf_of_from_a_trusted_service_is_a_400_not_a_platform_request(secret):
    with pytest.raises(HTTPException) as exc:
        get_caller(None, secret, "not-a-uuid")
    assert exc.value.status_code == 400


# --- the policy, flag off: exactly the old behaviour -----------------------------------------------------------------------------


def test_defaults_to_off():
    assert settings.require_own_dhan_keys is False


@pytest.mark.parametrize(
    "caller, expected",
    [(ANON, None), (SIGNED_IN_ALICE, ALICE_KEYS), (SIGNED_IN_BOB, None), (SERVICE, None), (SERVICE_FOR_ALICE, ALICE_KEYS)],
)
def test_flag_off_nothing_changes(accounts, flag, caller, expected):
    flag(False)
    assert data_access.data_credentials(caller, "NSE") == expected  # a keyless user falls back to the platform, as before


def test_flag_off_does_not_use_the_strict_lookup(accounts, flag):
    flag(False)
    data_access.data_credentials(SIGNED_IN_ALICE, "NSE")
    assert accounts == [(ALICE, False)]


# --- the policy, flag on -------------------------------------------------------------------------------------------------------------


def test_anonymous_is_refused_and_never_gets_the_platform_credential(accounts, flag):
    flag(True)
    with pytest.raises(HTTPException) as exc:
        data_access.data_credentials(ANON, "NSE")
    assert exc.value.status_code == 401 and accounts == []


def test_a_user_with_keys_runs_on_their_own_keys(accounts, flag):
    flag(True)
    assert data_access.data_credentials(SIGNED_IN_ALICE, "NSE") is ALICE_KEYS
    assert accounts == [(ALICE, True)]  # the STRICT lookup: an outage must not look like "no keys"


def test_a_user_without_keys_gets_a_clear_403_with_a_machine_readable_code(accounts, flag):
    flag(True)
    with pytest.raises(HTTPException) as exc:
        data_access.data_credentials(SIGNED_IN_BOB, "NSE")
    assert exc.value.status_code == 403 and code_of(exc.value) == "own_dhan_keys_required"
    assert exc.value.detail.startswith("own_dhan_keys_required:") and "Dhan API keys" in exc.value.detail


def test_an_accounts_outage_is_a_503_never_no_keys_and_never_the_platform(accounts, flag):
    flag(True)
    with pytest.raises(HTTPException) as exc:
        data_access.data_credentials(Caller(user_id=CAROL), "NSE")
    assert exc.value.status_code == 503 and code_of(exc.value) is None


def test_a_trusted_service_without_a_user_may_use_the_platform_credential(accounts, flag):
    flag(True)
    assert data_access.data_credentials(SERVICE, "NSE") is None and accounts == []


def test_a_trusted_service_acting_for_a_user_runs_on_that_users_keys(accounts, flag):
    flag(True)
    assert data_access.data_credentials(SERVICE_FOR_ALICE, "NSE") is ALICE_KEYS


def test_a_trusted_service_acting_for_a_keyless_user_is_refused_not_downgraded_to_the_platform(accounts, flag):
    flag(True)
    with pytest.raises(HTTPException) as exc:
        data_access.data_credentials(SERVICE_FOR_BOB, "NSE")
    assert exc.value.status_code == 403


def test_a_signed_in_user_wins_over_a_claimed_on_behalf_of(accounts, flag):
    flag(True)
    both = Caller(user_id=ALICE, trusted_service=True, on_behalf_of=BOB)
    assert data_access.data_credentials(both, "NSE") is ALICE_KEYS


def test_an_untrusted_on_behalf_of_is_ignored(accounts, flag):
    """get_caller drops it, but the policy must not honour it either if it ever arrives."""
    flag(True)
    with pytest.raises(HTTPException) as exc:
        data_access.data_credentials(Caller(on_behalf_of=ALICE), "NSE")
    assert exc.value.status_code == 401


@pytest.mark.parametrize("exchange", ["CRYPTO", "crypto"])
def test_crypto_is_public_data_and_never_needs_keys(accounts, flag, exchange):
    flag(True)
    assert data_access.data_credentials(ANON, exchange) is None  # no error, no platform credential involved
    assert data_access.data_credentials(SIGNED_IN_BOB, exchange) is None


@pytest.mark.parametrize("exchange", ["NSE", "MCX", None])
def test_every_dhan_exchange_and_an_unspecified_one_is_gated(accounts, flag, exchange):
    flag(True)
    with pytest.raises(HTTPException):
        data_access.data_credentials(ANON, exchange)


# --- every data route goes through the policy ------------------------------------------------------------------------------------------


class RecordingProvider:
    """Records the credentials each data call was made with."""

    name = "fake"

    def __init__(self):
        self.credentials = []

    def _rec(self, credentials):
        self.credentials.append(credentials)

    def get_ltp(self, symbol, credentials=None):
        self._rec(credentials)
        return 100.0

    def get_ltp_batch(self, symbols, credentials=None):
        self._rec(credentials)
        return {s: 100.0 for s in symbols}

    def get_previous_candle(self, symbol, interval, credentials=None):
        self._rec(credentials)
        return Candle(exchange="NSE", symbol=symbol, interval=interval, open=1, high=2, low=1, close=2, volume=1, timestamp="2026-01-01T00:00:00", provider="fake")

    def get_candle_history(self, symbol, interval, from_date, to_date, credentials=None):
        self._rec(credentials)
        return []

    def get_expiry_list(self, symbol, credentials=None):
        self._rec(credentials)
        return ["2026-09-29"]

    def get_option_chain(self, symbol, expiry, credentials=None):
        self._rec(credentials)
        return {"chain": True}

    def get_oi_changes(self, *a, **k):
        return {}


@pytest.fixture
def provider(monkeypatch):
    p = RecordingProvider()
    for module in (quotes_route, candles_route, options_route, ob_route, regime_route):
        monkeypatch.setattr(module, "get_provider", lambda exchange, p=p: p)
    candles_route._history_cache.clear()
    return p


def _swallow(fn):
    """Routes whose success path builds a real domain object from a fake: the policy runs
    first, so a downstream error still leaves the recorded credentials to inspect."""

    def run(*a, **k):
        try:
            return fn(*a, **k)
        except HTTPException:
            raise
        except Exception:
            return None

    return run


ROUTES = {
    "ltp": lambda c, ex="NSE": quotes_route.get_ltp(ex, "TCS", caller=c),
    "ltp_batch": lambda c, ex="NSE": quotes_route.get_ltp_batch(BatchQuoteRequest(exchange=ex, symbols=["TCS"]), caller=c),
    "candles_previous": lambda c, ex="NSE": candles_route.get_previous_candle(ex, "TCS", "15min", caller=c),
    "candles_history": lambda c, ex="NSE": candles_route.get_candle_history(ex, "TCS", "15min", caller=c),
    "options_expiries": lambda c, ex="NSE": options_route.get_expiries(ex, "NIFTY", caller=c),
    "options_chain": lambda c, ex="NSE": options_route.get_chain(ex, "NIFTY", "2026-09-29", caller=c),
    "options_oi_summary": lambda c, ex="NSE": _swallow(options_route.get_oi_summary)(ex, "NIFTY", "2026-09-29", caller=c),
    "order_blocks": lambda c, ex="NSE": _swallow(ob_route.get_order_blocks)(ex, "TCS", "15min", caller=c),
    "regime": lambda c, ex="NSE": _swallow(regime_route.get_regime)(ex, "TCS", "15min", caller=c),
}


@pytest.mark.parametrize("name", sorted(ROUTES))
def test_flag_on_an_anonymous_request_is_refused_before_the_provider_is_touched(accounts, flag, provider, name):
    flag(True)
    with pytest.raises(HTTPException) as exc:
        ROUTES[name](ANON)
    assert exc.value.status_code == 401 and provider.credentials == []


@pytest.mark.parametrize("name", sorted(ROUTES))
def test_flag_on_a_keyless_user_gets_the_403_code(accounts, flag, provider, name):
    flag(True)
    with pytest.raises(HTTPException) as exc:
        ROUTES[name](SIGNED_IN_BOB)
    assert exc.value.status_code == 403 and code_of(exc.value) == "own_dhan_keys_required" and provider.credentials == []


@pytest.mark.parametrize("name", sorted(ROUTES))
def test_flag_on_a_user_with_keys_is_served_on_their_own_keys(accounts, flag, provider, name):
    flag(True)
    ROUTES[name](SIGNED_IN_ALICE)
    assert provider.credentials and all(c is ALICE_KEYS for c in provider.credentials)


@pytest.mark.parametrize("name", sorted(ROUTES))
def test_flag_on_a_trusted_service_still_gets_data_on_the_platform_credential(accounts, flag, provider, name):
    flag(True)
    ROUTES[name](SERVICE)
    assert provider.credentials and all(c is None for c in provider.credentials)


@pytest.mark.parametrize("name", sorted(ROUTES))
def test_flag_off_an_anonymous_request_is_served_as_before(accounts, flag, provider, name):
    flag(False)
    ROUTES[name](ANON)
    assert provider.credentials and all(c is None for c in provider.credentials)


@pytest.mark.parametrize("name", ["ltp", "ltp_batch", "candles_previous", "candles_history"])
def test_flag_on_crypto_data_is_still_public(accounts, flag, provider, name):
    flag(True)
    ROUTES[name](ANON, "CRYPTO")
    assert provider.credentials == [None]


def test_flag_on_the_sentiment_badge_is_gated_too(accounts, flag, monkeypatch):
    flag(True)
    monkeypatch.setattr(options_route, "fetch_underlying_sentiment", lambda *a, **k: pytest.fail("must not fetch for a refused caller"))
    with pytest.raises(HTTPException) as exc:
        options_route.get_sentiment(caller=ANON)
    assert exc.value.status_code == 401
    with pytest.raises(HTTPException) as exc:
        options_route.get_sentiment(caller=SIGNED_IN_BOB)
    assert exc.value.status_code == 403


def test_source_yahoo_is_public_data_and_is_never_gated(accounts, flag, monkeypatch):
    flag(True)
    candles_route._history_cache.clear()
    monkeypatch.setattr(candles_route.yahoo, "get_candle_history", lambda exchange, symbol, interval, from_date, to_date: [])
    assert candles_route.get_candle_history("NSE", "TCS", "daily", source="yahoo", caller=ANON) == []
    assert accounts == []  # no credential lookup at all
    monkeypatch.setattr(ob_route, "get_provider", lambda exchange: pytest.fail("yahoo must not resolve a provider"))
    _swallow(ob_route.get_order_blocks)("NSE", "TCS", "daily", source="yahoo", caller=ANON)


def test_the_policy_runs_before_the_shared_candle_cache(accounts, flag, provider):
    """A keyless user must not read candles another user paid to fetch and cached."""
    flag(True)
    ROUTES["candles_history"](SIGNED_IN_ALICE)  # populates the shared cache
    with pytest.raises(HTTPException) as exc:
        ROUTES["candles_history"](SIGNED_IN_BOB)
    assert exc.value.status_code == 403


# --- the quote WebSocket -----------------------------------------------------------------------------------------------------------------


def test_ws_flag_off_anyone_may_subscribe(accounts, flag):
    flag(False)
    assert data_access.ws_dhan_allowed(None) is True and accounts == []


def test_ws_flag_on_needs_a_signed_in_user_with_keys(accounts, flag):
    flag(True)
    assert data_access.ws_dhan_allowed(None) is False
    assert data_access.ws_dhan_allowed(ALICE) is True
    assert data_access.ws_dhan_allowed(BOB) is False
    assert data_access.ws_dhan_allowed(CAROL) is False  # accounts down: fail closed


class FakeWs:
    def __init__(self, messages):
        self._messages = list(messages)
        self.sent = []
        self.query_params = {}

    async def accept(self):
        pass

    async def receive_json(self):
        if not self._messages:
            from fastapi import WebSocketDisconnect

            raise WebSocketDisconnect()
        return self._messages.pop(0)

    async def send_json(self, data):
        self.sent.append(data)


def run_ws(monkeypatch, messages, token=None):
    subscribed = []

    async def noop():
        pass

    async def no_snapshot(exchange, symbol):
        return None

    monkeypatch.setattr(quotes_ws, "_subscribers", {})
    monkeypatch.setattr(quotes_ws, "_ensure_pubsub_started", noop)
    monkeypatch.setattr(quotes_ws, "_snapshot", no_snapshot)
    monkeypatch.setattr(quotes_ws.dhan_feed, "start_feed", lambda: None)
    monkeypatch.setattr(quotes_ws.dhan_feed, "subscribe", lambda ex, sym: subscribed.append((ex, sym)))
    if token:  # the connection authenticates with a first frame, never a URL token (access logs)
        messages = [{"action": "auth", "token": token}] + list(messages)
    ws = FakeWs(messages)
    asyncio.run(quotes_ws.quotes_ws(ws))
    return ws, subscribed


def sub(exchange, symbol):
    return {"action": "subscribe", "exchange": exchange, "symbol": symbol}


def test_ws_flag_on_an_anonymous_connection_gets_an_error_frame_for_dhan_symbols_but_crypto_works(accounts, flag, monkeypatch):
    flag(True)
    ws, subscribed = run_ws(monkeypatch, [sub("NSE", "NIFTY"), sub("CRYPTO", "BTCUSD")])
    assert ws.sent == [{"type": "error", "code": "own_dhan_keys_required", "detail": "add your own Dhan API keys to see live prices"}]
    assert subscribed == [("CRYPTO", "BTCUSD")]


def test_ws_flag_on_a_user_with_keys_can_subscribe_after_an_auth_frame(accounts, flag, monkeypatch):
    flag(True)
    token = bearer(ALICE).credentials
    ws, subscribed = run_ws(monkeypatch, [sub("NSE", "NIFTY")], token=token)
    assert subscribed == [("NSE", "NIFTY")] and ws.sent == []


def test_ws_flag_on_a_keyless_user_is_refused(accounts, flag, monkeypatch):
    flag(True)
    ws, subscribed = run_ws(monkeypatch, [sub("NSE", "NIFTY")], token=bearer(BOB).credentials)
    assert subscribed == [] and ws.sent[0]["code"] == "own_dhan_keys_required"


def test_ws_flag_off_is_unchanged(accounts, flag, monkeypatch):
    flag(False)
    ws, subscribed = run_ws(monkeypatch, [sub("NSE", "NIFTY")])
    assert subscribed == [("NSE", "NIFTY")] and ws.sent == []


def test_ws_a_bad_token_leaves_the_connection_unauthorised_but_open(accounts, flag, monkeypatch):
    flag(True)
    ws, subscribed = run_ws(monkeypatch, [sub("NSE", "NIFTY")], token="garbage")
    assert subscribed == [] and ws.sent[0]["code"] == "own_dhan_keys_required"


def test_ws_the_auth_frame_can_arrive_after_a_first_refused_subscribe(accounts, flag, monkeypatch):
    flag(True)
    ws, subscribed = run_ws(monkeypatch, [sub("NSE", "NIFTY"), {"action": "auth", "token": bearer(ALICE).credentials}, sub("NSE", "NIFTY")])
    assert len(ws.sent) == 1 and subscribed == [("NSE", "NIFTY")]  # refused once, then allowed after authenticating


# --- the credential cache: "no keys" must not stick after the user saves keys ---------------------------------------------------------------


class _AccountsResp:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def test_a_negative_answer_is_cached_briefly_and_a_positive_one_for_the_full_window(monkeypatch):
    from app.adapters import accounts_client as ac

    clock = {"t": 1000.0}
    monkeypatch.setattr(ac.time, "monotonic", lambda: clock["t"])
    monkeypatch.setattr(ac, "_cache", {})
    answers = {"has_dhan": False}
    calls = []

    def fake_get(url, **kw):
        calls.append(url)
        body = {"has_dhan": False} if not answers["has_dhan"] else {"has_dhan": True, "dhan_client_id": "c", "dhan_access_token": "t"}
        return _AccountsResp(body)

    monkeypatch.setattr(ac.requests, "get", fake_get)
    uid = uuid.uuid4()
    assert ac.get_user_dhan_credentials(uid) is None and len(calls) == 1
    clock["t"] += 5
    assert ac.get_user_dhan_credentials(uid) is None and len(calls) == 1  # still cached: absorbs a burst
    answers["has_dhan"] = True  # the user saves their keys
    clock["t"] += 6  # 11s since the negative answer: past its short TTL
    creds = ac.get_user_dhan_credentials(uid)
    assert creds is not None and creds.client_id == "c" and len(calls) == 2  # picked up well inside 5 minutes
    clock["t"] += 200
    ac.get_user_dhan_credentials(uid)
    assert len(calls) == 2  # a positive answer is still cached for the long window
    clock["t"] += 200  # 406s > 300s
    ac.get_user_dhan_credentials(uid)
    assert len(calls) == 3
