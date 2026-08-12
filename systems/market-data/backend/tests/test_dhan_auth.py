"""Tests for app/providers/dhan.py's shared, in-memory access-token
state (current_access_token/renew_access_token/renew_token_status) - see
https://docs.dhanhq.co/api/v2/authentication/renew-token.

_renewed_token is module-level global state shared across the whole test
session, so every test here resets it via monkeypatch.setattr before
touching it - monkeypatch restores whatever value it captured at
teardown regardless of renew_access_token's own `global` reassignment
during the test, which keeps a renewal in one test from leaking into
another test's expectations (or into test_dhan_provider.py's tests,
which assume current_access_token() falls straight through to
settings.dhan_access_token)."""

import json

import responses

from app.config import settings
from app.providers import dhan


def test_current_access_token_falls_through_to_settings_before_any_renewal(monkeypatch):
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(settings, "dhan_access_token", "seed-token")

    assert dhan.current_access_token() == "seed-token"


@responses.activate
def test_renew_access_token_updates_shared_state(monkeypatch):
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(dhan, "_last_renewed_at", None)
    monkeypatch.setattr(dhan, "_last_renewal_response", None)
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "seed-token")

    responses.add(
        responses.GET,
        dhan.RENEW_TOKEN_URL,
        body=json.dumps(
            {
                "dhanClientId": "test-client",
                "dhanClientName": "Test User",
                "dhanClientUcc": "ABC123",
                "givenPowerOfAttorney": True,
                "accessToken": "renewed-token",
                "expiryTime": "2026-08-13T09:00:00Z",
            }
        ),
        status=200,
    )

    result = dhan.renew_access_token()

    assert result["accessToken"] == "renewed-token"
    assert dhan.current_access_token() == "renewed-token"

    status = dhan.renew_token_status()
    assert status["renewed"] is True
    assert status["expiry_time"] == "2026-08-13T09:00:00Z"
    assert status["dhan_client_name"] == "Test User"
    assert status["last_renewed_at"] is not None

    # Verify the request used the current (seed) token and the
    # endpoint-specific "dhanClientId" header, not "client-id".
    sent = responses.calls[0].request
    assert sent.headers["access-token"] == "seed-token"
    assert sent.headers["dhanClientId"] == "test-client"


@responses.activate
def test_renew_access_token_uses_previously_renewed_token(monkeypatch):
    monkeypatch.setattr(dhan, "_renewed_token", "already-renewed-once")
    monkeypatch.setattr(dhan, "_last_renewed_at", None)
    monkeypatch.setattr(dhan, "_last_renewal_response", None)
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")

    responses.add(
        responses.GET,
        dhan.RENEW_TOKEN_URL,
        body=json.dumps({"accessToken": "renewed-again", "expiryTime": "2026-08-14T09:00:00Z"}),
        status=200,
    )

    dhan.renew_access_token()

    sent = responses.calls[0].request
    assert sent.headers["access-token"] == "already-renewed-once"
    assert dhan.current_access_token() == "renewed-again"


@responses.activate
def test_renew_access_token_raises_on_401(monkeypatch):
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "expired-token")

    responses.add(responses.GET, dhan.RENEW_TOKEN_URL, body="{}", status=401)

    try:
        dhan.renew_access_token()
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "401" in str(exc)


@responses.activate
def test_renew_access_token_raises_when_200_response_has_no_access_token(monkeypatch):
    # Observed live: Dhan doesn't always signal a rejected renewal (e.g.
    # an already-expired token) via a non-200 status - sometimes it's a
    # 200 with an errorType/errorCode/errorMessage body instead of
    # accessToken. Must not raise an unhandled KeyError.
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "expired-token")

    responses.add(
        responses.GET,
        dhan.RENEW_TOKEN_URL,
        body=json.dumps({"errorType": "Order_Error", "errorCode": "DH-906", "errorMessage": "Invalid Token"}),
        status=200,
    )

    try:
        dhan.renew_access_token()
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "did not return an accessToken" in str(exc)
    # Must not have mutated shared state on failure.
    assert dhan.current_access_token() == "expired-token"


def test_renew_access_token_without_credentials_raises(monkeypatch):
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(settings, "dhan_client_id", "")
    monkeypatch.setattr(settings, "dhan_access_token", "")

    try:
        dhan.renew_access_token()
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "DHAN_CLIENT_ID" in str(exc)


def test_renew_token_status_before_any_renewal(monkeypatch):
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(dhan, "_last_renewed_at", None)
    monkeypatch.setattr(dhan, "_last_renewal_response", None)

    status = dhan.renew_token_status()

    assert status == {
        "renewed": False,
        "last_renewed_at": None,
        "expiry_time": None,
        "dhan_client_name": None,
    }
