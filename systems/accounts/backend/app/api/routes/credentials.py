from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.adapters.db import models
from app.adapters.db.session import get_db
from app.auth import get_current_user
from app.domain.models import CredentialsOut, CredentialsUpdate
from app.domain.security import encrypt_secret

router = APIRouter(prefix="/credentials", tags=["credentials"])


def _mask(client_id: str | None) -> str | None:
    if not client_id:
        return None
    if len(client_id) <= 4:
        return "****"
    return f"****{client_id[-4:]}"


def _to_out(row: models.BrokerCredentials | None) -> CredentialsOut:
    if row is None:
        return CredentialsOut(has_dhan=False, has_delta=False, dhan_client_id_masked=None)
    return CredentialsOut(
        has_dhan=bool(row.dhan_client_id and row.dhan_access_token_encrypted),
        has_delta=bool(row.delta_api_key_encrypted and row.delta_api_secret_encrypted),
        dhan_client_id_masked=_mask(row.dhan_client_id),
    )


@router.get("", response_model=CredentialsOut)
def get_credentials(user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.get(models.BrokerCredentials, user.id)
    return _to_out(row)


# Partial update - only fields present (non-None) in the payload are
# touched, so setting Dhan credentials doesn't wipe a previously-saved
# Delta key/secret (or vice versa). Creates the row lazily on first call
# (see models.BrokerCredentials's own comment - no row exists at signup).
@router.put("", response_model=CredentialsOut)
def update_credentials(
    payload: CredentialsUpdate,
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    row = db.get(models.BrokerCredentials, user.id)
    if row is None:
        row = models.BrokerCredentials(user_id=user.id)
        db.add(row)

    if payload.dhan_client_id is not None:
        row.dhan_client_id = payload.dhan_client_id
    if payload.dhan_access_token is not None:
        row.dhan_access_token_encrypted = encrypt_secret(payload.dhan_access_token)
    if payload.delta_api_key is not None:
        row.delta_api_key_encrypted = encrypt_secret(payload.delta_api_key)
    if payload.delta_api_secret is not None:
        row.delta_api_secret_encrypted = encrypt_secret(payload.delta_api_secret)

    db.commit()
    db.refresh(row)
    return _to_out(row)
