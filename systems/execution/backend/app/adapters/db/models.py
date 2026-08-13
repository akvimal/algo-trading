"""SQLAlchemy ORM models mirroring infra/postgres/init/02-execution.sql.

Table DDL lives in that init script, not here. If you add a column,
update both places.
"""

import uuid

from sqlalchemy import Boolean, Column, ForeignKey, Numeric, SmallInteger, Text, Time, func
from sqlalchemy.dialects.postgresql import TIMESTAMP, UUID
from sqlalchemy.orm import declarative_base

from app.config import settings

Base = declarative_base()
SCHEMA = settings.database_schema


class Settings(Base):
    __tablename__ = "settings"
    __table_args__ = {"schema": SCHEMA}

    id = Column(SmallInteger, primary_key=True, default=1)
    timezone = Column(Text, nullable=False)
    # CRYPTO only, nullable - see ExecutionSettings.usdinr_rate in app/domain/models.py.
    usdinr_rate = Column(Numeric, nullable=True)
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = {"schema": SCHEMA}

    segment = Column(Text, primary_key=True)  # 'NSE' | 'MCX' | 'CRYPTO' - one row per segment
    starting_balance = Column(Numeric, nullable=False)
    current_balance = Column(Numeric, nullable=False)  # debited/credited by realized P&L on close
    capital_per_trade = Column(Numeric, nullable=False)
    risk_per_trade_pct = Column(Numeric, nullable=False)
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class OptionPositionGroup(Base):
    """One row per multi-leg option order (Phase 4d of the options
    trading module - see docs/architecture.md) - owns the COMBINED SL/
    target/status/P&L a spread's legs share. Each leg itself is a
    Position row below, linked back here via Position.option_group_id."""

    __tablename__ = "option_position_groups"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    signal_id = Column(UUID(as_uuid=True), nullable=False, unique=True)
    strategy_id = Column(UUID(as_uuid=True), nullable=False)
    underlying_symbol = Column(Text, nullable=False)
    exchange = Column(Text, nullable=False)
    segment = Column(Text, nullable=False)
    strategy_type = Column(Text, nullable=False)
    action = Column(Text, nullable=False)
    horizon = Column(Text, nullable=False)
    quantity = Column(Numeric)
    net_debit = Column(Numeric)
    combined_stop_loss_price = Column(Numeric)
    combined_target_price = Column(Numeric)
    sl_scope = Column(Text, nullable=False, default="combined")
    status = Column(Text, nullable=False, default="OPEN")
    rejection_reason = Column(Text)
    exit_reason = Column(Text)
    exit_time = Column(TIMESTAMP(timezone=True))
    pnl = Column(Numeric)
    square_off_time = Column(Time)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class Position(Base):
    __tablename__ = "positions"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    signal_id = Column(UUID(as_uuid=True), nullable=False)
    strategy_id = Column(UUID(as_uuid=True), nullable=False)
    symbol = Column(Text, nullable=False)
    exchange = Column(Text, nullable=False)
    # Which execution.accounts row this position was sized against and
    # (once closed) credited/debited on - copied from the resolved order
    # at open time.
    segment = Column(Text, nullable=False)
    action = Column(Text, nullable=False)
    horizon = Column(Text, nullable=False)
    instrument_type = Column(Text, nullable=False)
    quantity = Column(Numeric)  # nullable - REJECTED positions were never sized
    entry_price = Column(Numeric, nullable=False)
    entry_time = Column(TIMESTAMP(timezone=True), server_default=func.now())
    exit_price = Column(Numeric)
    exit_time = Column(TIMESTAMP(timezone=True))
    pnl = Column(Numeric)
    status = Column(Text, nullable=False, default="OPEN")
    rejection_reason = Column(Text)
    stop_loss_price = Column(Numeric)  # current (may trail) - null if the strategy set no stop-loss method
    initial_stop_loss_price = Column(Numeric)  # audit trail - the stop as computed at open, never changes
    target_price = Column(Numeric)
    trailing_stop_enabled = Column(Boolean, nullable=False, default=False)
    # Copied from the Strategy at open time - the exit-monitor job's
    # trailing logic uses these to recompute a candidate stop without
    # calling signal-generation again.
    stop_loss_method = Column(Text)
    stop_loss_interval = Column(Text)
    stop_loss_percent = Column(Numeric)
    # 'square_off' | 'stop_loss' | 'target' | 'manual' | 'counter_signal', set when status becomes CLOSED
    exit_reason = Column(Text)
    # The square-off time this position's Strategy set (required there) -
    # copied at open time, never changed afterward. NULL only for
    # REJECTED rows that never got this far. See position_manager.open_position.
    square_off_time = Column(Time)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    # Which option_position_groups row this leg belongs to - NULL for
    # every ordinary spot/future position. See docs/architecture.md
    # Phase 4d.
    option_group_id = Column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.option_position_groups.id"))
