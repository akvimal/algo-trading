"""Pydantic request/response contracts for the accounts service. Not a
cross-system docs/contracts/*.schema.json entry (yet) - this service has no
other backend consumer in Phase 1, only the frontend calls it directly."""

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class SignupRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=200)


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    created_at: datetime
    is_admin: bool


# All optional - PUT /credentials is a partial update, e.g. setting only
# Dhan without touching a previously-saved Delta key/secret (or vice
# versa). An explicit empty string clears that field; an omitted field
# leaves the stored value untouched - see app/api/routes/credentials.py.
class CredentialsUpdate(BaseModel):
    dhan_client_id: Optional[str] = None
    dhan_access_token: Optional[str] = None
    delta_api_key: Optional[str] = None
    delta_api_secret: Optional[str] = None


# Deliberately never carries decrypted secrets - only presence flags and a
# masked identifier, so the frontend can show "Dhan connected" without this
# service ever handing a plaintext token back over the wire after the
# initial PUT.
class CredentialsOut(BaseModel):
    has_dhan: bool
    has_delta: bool
    dhan_client_id_masked: Optional[str] = None
