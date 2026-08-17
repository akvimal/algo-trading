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
def test_renew_access_token_updates_shared_state(monkeypatch, tmp_path):
    # This is the REAL live response shape (confirmed empirically against
    # api.dhan.co) - "token" and "createTime", not the "accessToken"/
    # "dhanClientName"/etc Dhan's own docs describe. See
    # renew_access_token's comment.
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(dhan, "_last_renewed_at", None)
    monkeypatch.setattr(dhan, "_last_renewal_response", None)
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "seed-token")
    # A successful renewal now also persists to disk (see
    # test_dhan_credentials_persistence.py) - redirect that write to a
    # throwaway path so this test doesn't touch the real
    # /data/dhan-credentials.json default.
    monkeypatch.setattr(settings, "dhan_credentials_file_path", str(tmp_path / "creds.json"))

    responses.add(
        responses.GET,
        dhan.RENEW_TOKEN_URL,
        body=json.dumps(
            {
                "createTime": "2026-08-12T15:49:07.392",
                "expiryTime": "2026-08-13T15:49:07.389",
                "token": "renewed-token",
            }
        ),
        status=200,
    )

    result = dhan.renew_access_token()

    assert result["token"] == "renewed-token"
    assert dhan.current_access_token() == "renewed-token"

    status = dhan.renew_token_status()
    assert status["renewed"] is True
    assert status["expiry_time"] == "2026-08-13T15:49:07.389"
    assert status["create_time"] == "2026-08-12T15:49:07.392"
    assert status["last_renewed_at"] is not None

    # Verify the request used the current (seed) token and the
    # endpoint-specific "dhanClientId" header, not "client-id".
    sent = responses.calls[0].request
    assert sent.headers["access-token"] == "seed-token"
    assert sent.headers["dhanClientId"] == "test-client"


@responses.activate
def test_renew_access_token_also_accepts_documented_access_token_field(monkeypatch, tmp_path):
    # Defensive fallback for Dhan's own documented shape
    # (https://docs.dhanhq.co/api/v2/authentication/renew-token), in case
    # it varies by account/plan or Dhan fixes the docs/response mismatch.
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_access_token", "seed-token")
    monkeypatch.setattr(settings, "dhan_credentials_file_path", str(tmp_path / "creds.json"))

    responses.add(
        responses.GET,
        dhan.RENEW_TOKEN_URL,
        body=json.dumps({"accessToken": "renewed-token", "expiryTime": "2026-08-13T09:00:00Z"}),
        status=200,
    )

    dhan.renew_access_token()

    assert dhan.current_access_token() == "renewed-token"


@responses.activate
def test_renew_access_token_uses_previously_renewed_token(monkeypatch, tmp_path):
    monkeypatch.setattr(dhan, "_renewed_token", "already-renewed-once")
    monkeypatch.setattr(dhan, "_last_renewed_at", None)
    monkeypatch.setattr(dhan, "_last_renewal_response", None)
    monkeypatch.setattr(settings, "dhan_client_id", "test-client")
    monkeypatch.setattr(settings, "dhan_credentials_file_path", str(tmp_path / "creds.json"))

    responses.add(
        responses.GET,
        dhan.RENEW_TOKEN_URL,
        body=json.dumps({"token": "renewed-again", "expiryTime": "2026-08-14T09:00:00Z"}),
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
        assert "did not return a token" in str(exc)
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
        "create_time": None,
    }


def test_set_manual_credentials_updates_shared_state(monkeypatch, tmp_path):
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(dhan, "_last_renewed_at", None)
    monkeypatch.setattr(dhan, "_last_renewal_response", None)
    monkeypatch.setattr(settings, "dhan_client_id", "")
    monkeypatch.setattr(settings, "dhan_access_token", "")
    monkeypatch.setattr(settings, "dhan_credentials_file_path", str(tmp_path / "creds.json"))

    dhan.set_manual_credentials("manual-client", "manual-token")

    assert settings.dhan_client_id == "manual-client"
    assert dhan.current_access_token() == "manual-token"
    status = dhan.renew_token_status()
    assert status["renewed"] is True
    assert status["last_renewed_at"] is not None
    # No real Dhan RenewToken response backs a manually-set token.
    assert status["expiry_time"] is None
    assert status["dhan_client_name"] is None


def test_set_manual_credentials_overrides_a_previous_renewal(monkeypatch, tmp_path):
    monkeypatch.setattr(dhan, "_renewed_token", "old-renewed-token")
    monkeypatch.setattr(dhan, "_last_renewed_at", None)
    monkeypatch.setattr(dhan, "_last_renewal_response", {"expiryTime": "2026-08-13T09:00:00Z"})
    monkeypatch.setattr(settings, "dhan_client_id", "old-client")
    monkeypatch.setattr(settings, "dhan_credentials_file_path", str(tmp_path / "creds.json"))

    dhan.set_manual_credentials("new-client", "new-token")

    assert settings.dhan_client_id == "new-client"
    assert dhan.current_access_token() == "new-token"
    # The stale renewal response must not leak into the new credentials'
    # status - a manual set is a fresh, unvalidated token.
    assert dhan.renew_token_status()["expiry_time"] is None


# --- credential persistence (survives a container restart) -----------------------------------


def test_set_manual_credentials_persists_to_disk(monkeypatch, tmp_path):
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(dhan, "_last_renewed_at", None)
    monkeypatch.setattr(dhan, "_last_renewal_response", None)
    path = tmp_path / "creds.json"
    monkeypatch.setattr(settings, "dhan_credentials_file_path", str(path))

    dhan.set_manual_credentials("manual-client", "manual-token")

    assert json.loads(path.read_text()) == {"client_id": "manual-client", "access_token": "manual-token"}


def test_load_persisted_credentials_restores_shared_state(monkeypatch, tmp_path):
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(dhan, "_last_renewed_at", None)
    monkeypatch.setattr(settings, "dhan_client_id", "")
    path = tmp_path / "creds.json"
    path.write_text(json.dumps({"client_id": "persisted-client", "access_token": "persisted-token"}))
    monkeypatch.setattr(settings, "dhan_credentials_file_path", str(path))

    dhan.load_persisted_credentials()

    assert settings.dhan_client_id == "persisted-client"
    assert dhan.current_access_token() == "persisted-token"


def test_load_persisted_credentials_noop_when_file_does_not_exist(monkeypatch, tmp_path):
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(settings, "dhan_access_token", "seed-token")
    monkeypatch.setattr(settings, "dhan_credentials_file_path", str(tmp_path / "does-not-exist.json"))

    dhan.load_persisted_credentials()  # no error

    # Falls through to the environment seed, same as before this existed.
    assert dhan.current_access_token() == "seed-token"


def test_load_persisted_credentials_noop_on_corrupt_file(monkeypatch, tmp_path):
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(settings, "dhan_access_token", "seed-token")
    path = tmp_path / "creds.json"
    path.write_text("not valid json{{{")
    monkeypatch.setattr(settings, "dhan_credentials_file_path", str(path))

    dhan.load_persisted_credentials()  # no error, logged and swallowed

    assert dhan.current_access_token() == "seed-token"


def test_set_manual_credentials_survives_a_simulated_restart(monkeypatch, tmp_path):
    """The actual end-to-end guarantee this whole feature exists for:
    set_manual_credentials (PUT /dhan/credentials) followed by a fresh
    process (simulated here by resetting every in-memory global exactly
    like a real restart would) must come back with the SAME credentials,
    not fall back to the environment seed - this was the real outage
    (see docs/architecture.md)."""
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(dhan, "_last_renewed_at", None)
    monkeypatch.setattr(dhan, "_last_renewal_response", None)
    monkeypatch.setattr(settings, "dhan_client_id", "old-client")
    monkeypatch.setattr(settings, "dhan_access_token", "stale-env-seed")
    monkeypatch.setattr(settings, "dhan_credentials_file_path", str(tmp_path / "creds.json"))

    dhan.set_manual_credentials("ui-client", "ui-token")

    # Simulate a container restart: every in-memory global resets, but the
    # file (and the env seed, unchanged) survive.
    monkeypatch.setattr(dhan, "_renewed_token", None)
    monkeypatch.setattr(dhan, "_last_renewed_at", None)
    monkeypatch.setattr(settings, "dhan_client_id", "old-client")

    dhan.load_persisted_credentials()

    assert settings.dhan_client_id == "ui-client"
    assert dhan.current_access_token() == "ui-token"  # not "stale-env-seed"
