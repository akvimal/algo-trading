"""SQLAlchemy ORM models mirroring infra/postgres/init/01-signal-processing.sql.

Table DDL lives in that init script, not here - these models are for
querying/writing via the ORM, not for generating the schema. If you add a
column, update both places.
"""

import uuid

from sqlalchemy import BigInteger, Column, ForeignKey, Numeric, Text, func
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import declarative_base

from app.config import settings

Base = declarative_base()
SCHEMA = settings.database_schema


class RawSignalPayload(Base):
    __tablename__ = "raw_signal_payloads"
    __table_args__ = {"schema": SCHEMA}

    id = Column(BigInteger, primary_key=True)
    provider = Column(Text, nullable=False)
    raw_payload = Column(JSONB, nullable=False)
    received_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class Signal(Base):
    __tablename__ = "signals"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    strategy_id = Column(UUID(as_uuid=True), nullable=False)
    symbol = Column(Text, nullable=False)
    exchange = Column(Text, nullable=False)
    action = Column(Text, nullable=False)
    price = Column(Numeric, nullable=False)
    source = Column(Text, nullable=False)
    source_meta = Column(JSONB)
    signal_ts = Column(TIMESTAMP(timezone=True), nullable=False)
    received_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class ResolvedOrder(Base):
    __tablename__ = "resolved_orders"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    signal_id = Column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.signals.id"), nullable=False)
    strategy_id = Column(UUID(as_uuid=True), nullable=False)
    symbol = Column(Text, nullable=False)
    exchange = Column(Text, nullable=False)
    action = Column(Text, nullable=False)
    horizon = Column(Text)
    instrument_type = Column(Text)
    strategy = Column(JSONB)
    price = Column(Numeric, nullable=False)
    status = Column(Text, nullable=False, default="pending")
    rejection_reason = Column(Text)
    resolved_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
