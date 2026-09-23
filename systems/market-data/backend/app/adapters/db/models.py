"""SQLAlchemy ORM models mirroring infra/postgres/init/05-market-data.sql.

Table DDL lives in that init script, not here - these models are for
querying/writing via the ORM, not for generating the schema. If you add a
column, update both places.

market-data's first table ever - see app/config.py's own comment on why
this system, otherwise in-memory-cache-only by design, now has one.
"""

import uuid

from sqlalchemy import BigInteger, Boolean, Column, Date, Float, Integer, Numeric, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
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
    # The ATM strike's own call/put buildup classification at this
    # snapshot - see app.domain.sentiment._atm_buildups. Two separate
    # columns, deliberately not merged into one.
    atm_call_buildup = Column(Text)
    atm_put_buildup = Column(Text)
    error = Column(Text)


class PriceAlert(Base):
    """A standalone price alert - a level + direction the scheduler polls
    the LTP against and pushes to Telegram on a crossing. See
    infra/postgres/init/05-market-data.sql and app/domain/price_alerts.py."""

    __tablename__ = "price_alerts"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True))
    exchange = Column(Text, nullable=False)
    symbol = Column(Text, nullable=False)
    target_price = Column(Numeric, nullable=False)
    direction = Column(Text, nullable=False)
    note = Column(Text)
    repeat = Column(Boolean, nullable=False, default=False)
    active = Column(Boolean, nullable=False, default=True)
    last_side = Column(Text)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    last_triggered_at = Column(TIMESTAMP(timezone=True))
    trigger_count = Column(Integer, nullable=False, default=0)


class OiEodSnapshot(Base):
    """One row per (symbol, snapshot_date) - the EOD OI-buildup screener's
    own persisted history, written once per trading day by
    app/scheduler.py's _record_oi_eod_snapshot (see docs/architecture.md's
    OI-by-strike-history idea - this is the per-SYMBOL-total version of
    that idea, not per-strike). Exists specifically because Dhan's option-
    chain API has no historical-OI endpoint at all - this table IS the
    history, built up one EOD snapshot at a time going forward; nothing
    before this feature shipped can ever be backfilled.

    call_oi_change_pct/put_oi_change_pct/price_change_pct/call_buildup/
    put_buildup are all computed against the PREVIOUS row for this same
    symbol (whatever that job found queryable at write time) - see
    app/domain/oi_buildup.py. total_call_oi/total_put_oi/spot_price are
    also what the NEXT day's job diffs against, so this table is its own
    day-over-day reference (unlike DhanProvider's in-memory OI history,
    which resets on every restart)."""

    __tablename__ = "oi_eod_snapshot"
    __table_args__ = (UniqueConstraint("symbol", "snapshot_date"), {"schema": SCHEMA})

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    snapshot_date = Column(Date, nullable=False)
    exchange = Column(Text, nullable=False)
    symbol = Column(Text, nullable=False)
    recorded_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    spot_price = Column(Float)
    total_call_oi = Column(BigInteger, nullable=False)
    total_put_oi = Column(BigInteger, nullable=False)
    pcr = Column(Float)
    call_oi_change_pct = Column(Float)
    put_oi_change_pct = Column(Float)
    price_change_pct = Column(Float)
    call_buildup = Column(Text)
    put_buildup = Column(Text)


class EquityScreenerSnapshot(Base):
    """One row per (symbol, snapshot_date) - the EOD momentum/trend +
    52-week-proximity screener (see app/scheduler.py's
    _record_equity_screener_snapshot + app/domain/equity_screener.py).
    Unlike OiEodSnapshot above, every metric here is recomputed fresh
    each day from a trailing window fetched straight off Dhan's own
    charts/historical endpoint (real multi-year daily bars, no chunking
    needed) - this table only persists the DERIVED read, not raw OHLCV,
    since Dhan itself already holds the history."""

    __tablename__ = "equity_screener_snapshot"
    __table_args__ = (UniqueConstraint("symbol", "snapshot_date"), {"schema": SCHEMA})

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    snapshot_date = Column(Date, nullable=False)
    exchange = Column(Text, nullable=False)
    symbol = Column(Text, nullable=False)
    recorded_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    close = Column(Float, nullable=False)
    pct_change_5d = Column(Float)
    pct_change_20d = Column(Float)
    adx = Column(Float)
    # trending_up/trending_down/ranging/transitional - app/domain/regime.py's
    # own Regime literal.
    regime = Column(Text)
    high_52w = Column(Float)
    low_52w = Column(Float)
    pct_from_52w_high = Column(Float)
    pct_from_52w_low = Column(Float)
    # near_52w_high/near_52w_low or NULL (mid-range/not enough history).
    proximity = Column(Text)


class NewsHistory(Base):
    """One row per underlying per news-cache refresh - the AI digest
    (bias/bias_reason/digest) plus its scored articles (JSONB), so a past
    prediction can later be checked against what price actually did. See
    app/providers/news.py's _persist_digest. Append-only, never updated."""

    __tablename__ = "news_history"
    __table_args__ = {"schema": SCHEMA}

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    recorded_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    underlying = Column(Text, nullable=False)
    bias = Column(Text, nullable=False)
    bias_reason = Column(Text, nullable=False)
    digest = Column(Text, nullable=False)
    articles = Column(JSONB, nullable=False)
