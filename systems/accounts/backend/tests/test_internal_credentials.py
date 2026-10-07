"""Pure unit test for the internal-secret guard on
GET /internal/credentials/{user_id}/dhan - matches this repo's "no
DB-integration test pattern" convention (see test_security.py's own
docstring); the actual decrypt-and-return behavior against a real
BrokerCredentials row is verified live via curl, not pytest."""

import pytest
from fastapi import HTTPException

from app.api.routes.internal import _require_internal_secret
from app.config import settings


def test_require_internal_secret_accepts_the_configured_value():
    _require_internal_secret(settings.internal_service_secret)  # does not raise


def test_require_internal_secret_rejects_wrong_value():
    with pytest.raises(HTTPException) as exc:
        _require_internal_secret("wrong-secret")
    assert exc.value.status_code == 403


def test_require_internal_secret_rejects_missing_header():
    with pytest.raises(HTTPException) as exc:
        _require_internal_secret("")
    assert exc.value.status_code == 403


# ---- the platform's Dhan credentials: one source (the operator's saved keys) -----------------------------------------------------------

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.api.routes import internal
from app.domain.security import decrypt_secret, encrypt_secret


class _Q:
    def __init__(self, rows):
        self.rows = list(rows)

    def filter(self, *criteria):
        out = self.rows
        for c in criteria:
            key = getattr(getattr(c, "left", None), "key", None)
            if key is None:  # a bare column expression such as User.is_admin.is_(True)
                key = getattr(c, "element", c).key if hasattr(c, "element") else None
            value = getattr(getattr(c, "right", None), "value", True)
            out = [r for r in out if getattr(r, key) == value]
        return _Q(out)

    def order_by(self, *a):
        return _Q(sorted(self.rows, key=lambda r: r.created_at))

    def first(self):
        return self.rows[0] if self.rows else None


class _DB:
    def __init__(self, users, creds=None):
        self.users, self.creds, self.added = users, dict(creds or {}), []

    def query(self, model):
        return _Q(self.users)

    def get(self, model, key):
        return self.creds.get(key)

    def add(self, row):
        self.creds[row.user_id] = row
        self.added.append(row)

    def commit(self):
        pass


def _user(email, admin, age_days):
    return SimpleNamespace(id=uuid.uuid4(), email=email, is_admin=admin, created_at=datetime.now(timezone.utc) - timedelta(days=age_days))


def _with_owner_email(monkeypatch, email=""):
    monkeypatch.setattr(settings, "platform_dhan_owner_email", email)


def test_the_platform_owner_is_the_first_admin_not_just_the_first_user(monkeypatch):
    _with_owner_email(monkeypatch)
    plain, first_admin, later_admin = _user("a@x.com", False, 30), _user("b@x.com", True, 20), _user("c@x.com", True, 5)
    assert internal.platform_owner(_DB([later_admin, plain, first_admin])) is first_admin


def test_a_configured_email_decides_the_owner_whatever_the_admin_order(monkeypatch):
    _with_owner_email(monkeypatch, "  C@X.com ")
    a, c = _user("b@x.com", True, 20), _user("c@x.com", True, 5)
    assert internal.platform_owner(_DB([a, c])) is c


def test_with_no_admin_there_is_no_owner_and_nothing_is_returned(monkeypatch):
    _with_owner_email(monkeypatch)
    assert internal.platform_owner(_DB([_user("a@x.com", False, 3)])) is None
    assert internal.get_platform_dhan(_DB([_user("a@x.com", False, 3)])) == {"has_dhan": False, "owner_user_id": None, "dhan_client_id": None, "dhan_access_token": None}


def test_the_owners_saved_token_is_returned_decrypted_and_a_missing_or_unreadable_one_is_absent_not_an_error(monkeypatch):
    _with_owner_email(monkeypatch)
    owner = _user("a@x.com", True, 9)
    creds = SimpleNamespace(user_id=owner.id, dhan_client_id="1101", dhan_access_token_encrypted=encrypt_secret("tok.en.value"))
    out = internal.get_platform_dhan(_DB([owner], {owner.id: creds}))
    assert out == {"has_dhan": True, "owner_user_id": str(owner.id), "dhan_client_id": "1101", "dhan_access_token": "tok.en.value"}
    assert internal.get_platform_dhan(_DB([owner]))["has_dhan"] is False  # nothing saved yet
    creds.dhan_access_token_encrypted = "not-valid-ciphertext"
    assert internal.get_platform_dhan(_DB([owner], {owner.id: creds}))["has_dhan"] is False  # the key was rotated: degrade, never a 500


def test_a_renewed_token_is_written_back_encrypted_and_the_client_id_only_when_given(monkeypatch):
    _with_owner_email(monkeypatch)
    owner = _user("a@x.com", True, 9)
    creds = SimpleNamespace(user_id=owner.id, dhan_client_id="1101", dhan_access_token_encrypted=encrypt_secret("old.tok.en"))
    db = _DB([owner], {owner.id: creds})
    assert internal.put_platform_dhan(internal.PlatformDhanUpdate(dhan_access_token=" new.tok.en "), db) == {"ok": True, "owner_user_id": str(owner.id)}
    assert decrypt_secret(creds.dhan_access_token_encrypted) == "new.tok.en" and creds.dhan_client_id == "1101"  # trimmed, the id untouched
    assert "new.tok.en" not in creds.dhan_access_token_encrypted  # never plaintext at rest
    internal.put_platform_dhan(internal.PlatformDhanUpdate(dhan_access_token="newer.tok.en", dhan_client_id="2202"), db)
    assert creds.dhan_client_id == "2202"


def test_writing_a_token_creates_the_owners_row_when_none_exists_and_refuses_an_empty_token_or_no_owner(monkeypatch):
    _with_owner_email(monkeypatch)
    owner = _user("a@x.com", True, 9)
    db = _DB([owner])
    internal.put_platform_dhan(internal.PlatformDhanUpdate(dhan_access_token="t.o.k", dhan_client_id="1101"), db)
    assert db.added and decrypt_secret(db.added[0].dhan_access_token_encrypted) == "t.o.k"
    with pytest.raises(HTTPException) as e:
        internal.put_platform_dhan(internal.PlatformDhanUpdate(dhan_access_token="   "), _DB([owner]))
    assert e.value.status_code == 422
    with pytest.raises(HTTPException) as e:
        internal.put_platform_dhan(internal.PlatformDhanUpdate(dhan_access_token="t.o.k"), _DB([]))
    assert e.value.status_code == 404


def test_both_platform_routes_need_the_internal_secret():
    routes = {r.path + ":" + ",".join(sorted(r.methods)): r for r in internal.router.routes}
    for key in ("/internal/platform/dhan:GET", "/internal/platform/dhan:PUT"):
        assert any(d.call is internal._require_internal_secret for d in routes[key].dependant.dependencies), key
