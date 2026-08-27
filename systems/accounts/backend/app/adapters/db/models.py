"""SQLAlchemy ORM models mirroring infra/postgres/init/04-accounts.sql.

Table DDL lives in that init script, not here - these models are for
querying/writing via the ORM, not for generating the schema. If you add a
column, update both places.
"""

import uuid

from sqlalchemy import Boolean, Column, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import TIMESTAMP, UUID
from sqlalchemy.orm import declarative_base

from app.config import settings

Base = declarative_base()
SCHEMA = settings.database_schema


class User(Base):
    __tablename__ = "users"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(Text, unique=True, nullable=False)
    password_hash = Column(Text, nullable=False)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    is_admin = Column(Boolean, nullable=False, server_default="false")


class BrokerCredentials(Base):
    """One row per user, created lazily on first PUT /credentials - not
    seeded at signup (a fresh signup has none yet, see CredentialsOut's
    has_dhan/has_delta flags). The four secret columns are Fernet
    ciphertext (app/domain/security.py's encrypt_secret/decrypt_secret),
    never plaintext at rest and never returned by any route."""

    __tablename__ = "broker_credentials"
    __table_args__ = {"schema": SCHEMA}

    user_id = Column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.users.id", ondelete="CASCADE"), primary_key=True)
    dhan_client_id = Column(Text)
    dhan_access_token_encrypted = Column(Text)
    delta_api_key_encrypted = Column(Text)
    delta_api_secret_encrypted = Column(Text)
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())
