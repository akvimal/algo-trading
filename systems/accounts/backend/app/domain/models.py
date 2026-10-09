"""Pydantic request/response contracts for the accounts service. Not a
cross-system docs/contracts/*.schema.json entry (yet) - this service has no
other backend consumer in Phase 1, only the frontend calls it directly."""

import uuid
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class SignupRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=200)
    # Must be true: the person confirms the risk disclosure shown at signup.
    # Defaults to false (not true) so a client that forgets to send it is
    # refused rather than silently recorded as having agreed.
    accept_risk_disclosure: bool = False


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


Market = Literal["NSE", "MCX", "CRYPTO"]


class SegmentDefault(BaseModel):
    instrument: Literal["future", "option"] = "future"
    option_strategy: Literal["naked", "spread"] = "naked"


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    name: str
    created_at: datetime
    is_admin: bool
    risk_acknowledged_at: Optional[datetime] = None
    risk_acknowledged_version: Optional[str] = None
    experience: Literal["guided", "pro"] = "guided"
    onboarded_at: Optional[datetime] = None
    markets: list[Market] = ["NSE", "MCX", "CRYPTO"]
    # What the manual trade ticket (web frontend) pre-selects on a fresh instrument, so a person
    # who always trades options (say) does not re-click past Future every time. default_instrument
    # only chooses between the two visible top-level chips (Future vs Option); which option style
    # (naked vs spread) is a second, independent preference - a future-only trader has no use for
    # it, and someone who always wants a spread should not have to also declare "option" twice.
    default_instrument: Literal["future", "option"] = "future"
    default_option_strategy: Literal["naked", "spread"] = "naked"
    # The same choice per market; a market without an entry uses the two above.
    segment_defaults: dict[Market, "SegmentDefault"] = {}


class PreferencesUpdate(BaseModel):
    """PUT /auth/me/preferences - a partial update: only what is present changes. `onboarded`
    true records that the first-run flow is finished (or skipped) if it was not already; false
    clears it so the flow can be replayed."""

    experience: Optional[Literal["guided", "pro"]] = None
    onboarded: Optional[bool] = None
    # At least one; duplicates are dropped and the order is kept.
    markets: Optional[list[Market]] = Field(default=None, min_length=1)
    default_instrument: Optional[Literal["future", "option"]] = None
    default_option_strategy: Optional[Literal["naked", "spread"]] = None
    # Only the markets present change; the others keep what they had.
    segment_defaults: Optional[dict[Market, SegmentDefault]] = None


# All optional - PUT /credentials is a partial update, e.g. setting only
# Dhan without touching a previously-saved Delta key/secret (or vice
# versa). An explicit empty string clears that field; an omitted field
# leaves the stored value untouched - see app/api/routes/credentials.py.
class CredentialsUpdate(BaseModel):
    dhan_client_id: Optional[str] = None
    dhan_access_token: Optional[str] = None
    delta_api_key: Optional[str] = None
    delta_api_secret: Optional[str] = None
    openrouter_api_key: Optional[str] = None


# Deliberately never carries decrypted secrets - only presence flags and a
# masked identifier, so the frontend can show "Dhan connected" without this
# service ever handing a plaintext token back over the wire after the
# initial PUT.
class CredentialsOut(BaseModel):
    has_dhan: bool
    has_delta: bool
    has_openrouter: bool
    dhan_client_id_masked: Optional[str] = None
