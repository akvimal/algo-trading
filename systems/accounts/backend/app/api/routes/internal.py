"""Service-to-service routes - never called by a browser or by execution,
only by market-data (Phase 3 of the manual-trading SaaS, see
docs/architecture.md). Protected by a shared secret header, not a user
JWT, since the caller here is a trusted service, not a person - see
app/config.py's own comment on internal_service_secret."""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.adapters.db import models
from app.adapters.db.session import get_db
from app.config import settings
from app.domain.security import encrypt_secret, try_decrypt_secret

router = APIRouter(prefix="/internal", tags=["internal"])


def _require_internal_secret(x_internal_secret: str = Header(default="")) -> None:
    if x_internal_secret != settings.internal_service_secret:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="invalid internal service secret")


@router.get("/credentials/{user_id}/dhan", dependencies=[Depends(_require_internal_secret)])
def get_internal_dhan_credentials(user_id: uuid.UUID, db: Session = Depends(get_db)):
    """The one route in this service that returns a DECRYPTED secret -
    market-data needs the real client_id/access_token to call Dhan on
    this user's behalf. has_dhan=False (both fields null) whenever
    there's nothing stored, or the stored ciphertext fails to decrypt
    (e.g. CREDENTIALS_ENCRYPTION_KEY rotated out from under an old row) -
    never a 500, same "degrade to absent rather than crash" reasoning
    try_decrypt_secret's own docstring already establishes."""
    row = db.get(models.BrokerCredentials, user_id)
    if row is None or not row.dhan_client_id or not row.dhan_access_token_encrypted:
        return {"has_dhan": False, "dhan_client_id": None, "dhan_access_token": None}

    access_token = try_decrypt_secret(row.dhan_access_token_encrypted)
    if access_token is None:
        return {"has_dhan": False, "dhan_client_id": None, "dhan_access_token": None}

    return {"has_dhan": True, "dhan_client_id": row.dhan_client_id, "dhan_access_token": access_token}


@router.get("/credentials/{user_id}/openrouter", dependencies=[Depends(_require_internal_secret)])
def get_internal_openrouter_credentials(user_id: uuid.UUID, db: Session = Depends(get_db)):
    """Mirrors get_internal_dhan_credentials above - called by both
    market-data (news.py's AI digest) and signal-engine (screener_fetch.py's
    fundamentals read), the two BYO-OpenRouter-key consumers (2026-09-16).
    has_openrouter=False (never a 500) whenever nothing's stored or the
    ciphertext fails to decrypt, same degrade-to-absent reasoning as Dhan."""
    row = db.get(models.BrokerCredentials, user_id)
    if row is None or not row.openrouter_api_key_encrypted:
        return {"has_openrouter": False, "openrouter_api_key": None}

    api_key = try_decrypt_secret(row.openrouter_api_key_encrypted)
    if api_key is None:
        return {"has_openrouter": False, "openrouter_api_key": None}

    return {"has_openrouter": True, "openrouter_api_key": api_key}


# ---- the platform's Dhan credentials: ONE source, the operator's own saved keys --------------------------------------------------------
#
# market-data's background jobs, shared price feed and option-chain reads run as the platform, with no person logged in, and used to have a
# Dhan token of their own that nothing connected to the Settings page (so a token saved there never reached them, and a renewal of either
# copy invalidated the other). Now the platform uses the Dhan token the operator saved in Settings: the OWNER is the account with
# PLATFORM_DHAN_OWNER_EMAIL, or else the first admin. market-data reads it here, and after it renews the token it writes the new one back
# here, so there is only ever one copy.


def platform_owner(db: Session) -> "models.User | None":
    """The account whose saved Dhan credentials the platform uses: the configured email, else the first admin ever created."""
    email = (settings.platform_dhan_owner_email or "").strip().lower()
    q = db.query(models.User)
    if email:
        return q.filter(models.User.email == email).first()
    return q.filter(models.User.is_admin.is_(True)).order_by(models.User.created_at.asc()).first()


class PlatformDhanUpdate(BaseModel):
    dhan_access_token: str
    dhan_client_id: Optional[str] = None


@router.get("/platform/dhan", dependencies=[Depends(_require_internal_secret)])
def get_platform_dhan(db: Session = Depends(get_db)):
    """The platform owner's saved Dhan credentials, decrypted (like the per-user route above: absent, never a 500, when nothing is stored)."""
    owner = platform_owner(db)
    if owner is None:
        return {"has_dhan": False, "owner_user_id": None, "dhan_client_id": None, "dhan_access_token": None}
    row = db.get(models.BrokerCredentials, owner.id)
    if row is None or not row.dhan_client_id or not row.dhan_access_token_encrypted:
        return {"has_dhan": False, "owner_user_id": str(owner.id), "dhan_client_id": None, "dhan_access_token": None}
    token = try_decrypt_secret(row.dhan_access_token_encrypted)
    if token is None:
        return {"has_dhan": False, "owner_user_id": str(owner.id), "dhan_client_id": None, "dhan_access_token": None}
    return {"has_dhan": True, "owner_user_id": str(owner.id), "dhan_client_id": row.dhan_client_id, "dhan_access_token": token}


@router.put("/platform/dhan", dependencies=[Depends(_require_internal_secret)])
def put_platform_dhan(payload: PlatformDhanUpdate, db: Session = Depends(get_db)):
    """Store a (renewed) Dhan token for the platform owner. market-data calls this after a renewal so the Settings copy and the platform's
    are one and the same. The client id is only changed when one is given."""
    owner = platform_owner(db)
    if owner is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="there is no platform owner account (no admin yet)")
    token = payload.dhan_access_token.strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="an empty token cannot be stored")
    row = db.get(models.BrokerCredentials, owner.id)
    if row is None:
        row = models.BrokerCredentials(user_id=owner.id)
        db.add(row)
    row.dhan_access_token_encrypted = encrypt_secret(token)
    if payload.dhan_client_id:
        row.dhan_client_id = payload.dhan_client_id.strip()
    db.commit()
    return {"ok": True, "owner_user_id": str(owner.id)}
