"""Service-to-service routes - never called by a browser or by execution,
only by market-data (Phase 3 of the manual-trading SaaS, see
docs/architecture.md). Protected by a shared secret header, not a user
JWT, since the caller here is a trusted service, not a person - see
app/config.py's own comment on internal_service_secret."""

import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.adapters.db import models
from app.adapters.db.session import get_db
from app.config import settings
from app.domain.security import try_decrypt_secret

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
