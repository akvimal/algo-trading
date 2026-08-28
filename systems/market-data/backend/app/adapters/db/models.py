"""SQLAlchemy ORM models mirroring infra/postgres/init/05-market-data.sql.

Table DDL lives in that init script, not here - these models are for
querying/writing via the ORM, not for generating the schema. If you add a
column, update both places.

market-data's first table ever - see app/config.py's own comment on why
this system, otherwise in-memory-cache-only by design, now has one.
"""

from sqlalchemy import BigInteger, Column, Float, Text, func
from sqlalchemy.dialects.postgresql import TIMESTAMP
from sqlalchemy.orm import declarative_base

from app.config import settings

Base = declarative_base()
SCHEMA = settings.database_schema


class SentimentHistory(Base):
    """One row per (exchange, symbol) per scheduled sentiment poll (see
    app/scheduler.py's _record_sentiment_history) - an append-only log,
    never updated or deleted, so a BIGSERIAL id is enough (no UUID needed,
    nothing else references a row by id)."""

    __tablename__ = "sentiment_history"
    __table_args__ = {"schema": SCHEMA}

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    recorded_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    exchange = Column(Text, nullable=False)
    symbol = Column(Text, nullable=False)
    direction = Column(Text, nullable=False)
    strength = Column(Text)
    score_5m = Column(Float)
    score_15m = Column(Float)
    spot_price = Column(Float)
    error = Column(Text)
