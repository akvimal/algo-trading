"""SQLAlchemy ORM model mirroring infra/postgres/init/03-signal-generation.sql."""

import uuid

from sqlalchemy import Boolean, Column, Numeric, Text, Time, func
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import declarative_base

from app.config import settings

Base = declarative_base()
SCHEMA = settings.database_schema


class Strategy(Base):
    __tablename__ = "strategies"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(Text, nullable=False)
    source_type = Column(Text, nullable=False)
    exchange = Column(Text, nullable=False)
    horizon = Column(Text, nullable=False)
    instrument_type = Column(Text, nullable=False)
    interval = Column(Text)
    stop_loss_method = Column(Text)
    stop_loss_interval = Column(Text)
    stop_loss_percent = Column(Numeric)
    target_percent = Column(Numeric)
    trailing_stop_enabled = Column(Boolean, nullable=False, default=False)
    # instrument_type='option' only - 'spread' or 'naked', see OptionPositionStyle in app/domain/models.py.
    option_position_style = Column(Text, nullable=False, default="spread")
    # instrument_type='option' only - primary leg's strike, see OptionStrikeMoneyness in app/domain/models.py.
    option_strike_moneyness = Column(Text, nullable=False, default="ATM")
    # instrument_type='option' only - combined vs per-leg SL/target, see OptionSlScope in app/domain/models.py.
    option_sl_scope = Column(Text, nullable=False, default="combined")
    segment = Column(Text, nullable=False, default="NSE")  # NSE/MCX/CRYPTO - drives the square_off_time default
    square_off_time = Column(Time)  # required for horizon='intraday' only - null for swing/positional
    # in_house only - see validate_in_house_fields. underlying: the
    # logical symbol to watch (e.g. "GOLDM", "NIFTY"). rule_config: which
    # Indicator (see below) this strategy uses and how to decide from it
    # - a typed JSON blob (CrossoverRuleConfig today) so a new rule type
    # is new code, not a schema migration.
    underlying = Column(Text)
    # 'symbol' (default, unchanged behavior) or 'universe' - see
    # UnderlyingType/validate_underlying_type_fields in app/domain/models.py.
    underlying_type = Column(Text, nullable=False, default="symbol")
    # none_as_null=True: a Python None must become SQL NULL here, not the
    # JSON literal 'null' (SQLAlchemy's JSON/JSONB default) - the
    # in_house_fields_consistent CHECK below tests "rule_config IS NULL",
    # which a JSON null does not satisfy.
    rule_config = Column(JSONB(none_as_null=True))
    regime_filter_enabled = Column(Boolean, nullable=False, default=False)
    regime_filter_checks = Column(
        JSONB, nullable=False, default=lambda: ["structure", "efficiency_ratio", "adx", "dmi_direction", "ema_slope"]
    )
    # Optional per-strategy signal-acceptance window - see
    # infra/postgres/init/03-signal-generation.sql for the full comment.
    active_from_time = Column(Time)
    active_to_time = Column(Time)
    # Passed through unchanged on resolved-order to execution - see
    # DuplicateSignalPolicy/CounterSignalPolicy in app/domain/models.py.
    duplicate_signal_policy = Column(Text, nullable=False, default="add_position")
    counter_signal_policy = Column(Text, nullable=False, default="skip")
    status = Column(Text, nullable=False, default="draft")
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class Indicator(Base):
    """A reusable indicator definition (e.g. "RSI 14") - any number of
    Strategy rows can reference one via rule_config's indicator_id. See
    docs/architecture.md § indicators decoupled from Strategy."""

    __tablename__ = "indicators"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(Text, nullable=False)
    type = Column(Text, nullable=False)  # 'rsi' today
    params = Column(JSONB, nullable=False)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class EngineRun(Base):
    """Runtime bookkeeping for the in-house engine's periodic tick - see
    infra/postgres/init/03-signal-generation.sql. Keyed by (strategy_id,
    symbol), not just strategy_id - a universe-scoped strategy checks many
    symbols independently each tick and needs its own dedupe state per
    constituent, not one shared state for the whole strategy."""

    __tablename__ = "engine_runs"
    __table_args__ = {"schema": SCHEMA}

    strategy_id = Column(UUID(as_uuid=True), primary_key=True)
    symbol = Column(Text, primary_key=True)
    last_signal_candle_ts = Column(TIMESTAMP(timezone=True))
    last_checked_at = Column(TIMESTAMP(timezone=True))
