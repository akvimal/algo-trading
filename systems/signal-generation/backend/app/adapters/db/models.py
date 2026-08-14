"""SQLAlchemy ORM model mirroring infra/postgres/init/03-signal-generation.sql."""

import uuid

from sqlalchemy import Boolean, Column, ForeignKey, Integer, Numeric, Text, func
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import declarative_base

from app.config import settings

Base = declarative_base()
SCHEMA = settings.database_schema


class Rule(Base):
    """A saved, reusable definition of *when a signal should fire* - see
    app/domain/rule.py. One Rule can back many Strategy rows below (via
    Strategy.rule_id)."""

    __tablename__ = "rules"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(Text, nullable=False)
    description = Column(Text)
    segment = Column(Text, nullable=False, default="NSE")
    underlying = Column(Text, nullable=False)
    underlying_type = Column(Text, nullable=False, default="symbol")
    interval = Column(Text, nullable=False)
    rule_config = Column(JSONB(none_as_null=True), nullable=False)
    regime_indicator_ids = Column(JSONB, nullable=False, default=list)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class Strategy(Base):
    __tablename__ = "strategies"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(Text, nullable=False)
    source_type = Column(Text, nullable=False)
    exchange = Column(Text, nullable=False)
    horizon = Column(Text, nullable=False)
    instrument_type = Column(Text, nullable=False)
    # Which Rule (above) decides when this strategy's signals fire - see
    # app/domain/rule.py. in_house only - NULL for external strategies.
    rule_id = Column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.rules.id"), nullable=True)
    stop_loss_method = Column(Text)
    stop_loss_interval = Column(Text)
    stop_loss_percent = Column(Numeric)
    stop_loss_indicator_type = Column(Text)
    # none_as_null=True - without it, a Python None serializes as the JSON
    # 'null' literal, not SQL NULL, which fails the stop_loss_fields_consistent
    # CHECK constraint's "IS NULL" branches (see rule_config above, same fix).
    stop_loss_indicator_params = Column(JSONB(none_as_null=True))
    target_percent = Column(Numeric)
    trailing_stop_enabled = Column(Boolean, nullable=False, default=False)
    # instrument_type='option' only - 'spread' or 'naked', see OptionPositionStyle in app/domain/models.py.
    option_position_style = Column(Text, nullable=False, default="spread")
    # instrument_type='option' only - primary leg's strike, see OptionStrikeMoneyness in app/domain/models.py.
    option_strike_moneyness = Column(Text, nullable=False, default="ATM")
    # instrument_type='option' only - combined vs per-leg SL/target, see OptionSlScope in app/domain/models.py.
    option_sl_scope = Column(Text, nullable=False, default="combined")
    # instrument_type='option' only, nullable - see option_fixed_lots in app/domain/models.py.
    option_fixed_lots = Column(Integer, nullable=True)
    # instrument_type in ('future', 'option') only - see ContractDayFilter in app/domain/models.py.
    contract_day_filter = Column(Text, nullable=False, default="any")
    segment = Column(Text, nullable=False, default="NSE")  # NSE/MCX/CRYPTO
    # Optional per-strategy signal-acceptance window(s) - see
    # infra/postgres/init/03-signal-generation.sql for the full comment.
    # Always a real (possibly empty) JSON array, never NULL - no
    # none_as_null concern here unlike stop_loss_indicator_params above,
    # since this column is never assigned a bare None.
    active_windows = Column(JSONB, nullable=False, default=list)
    # Passed through unchanged on resolved-order to execution - see
    # DuplicateSignalPolicy/CounterSignalPolicy in app/domain/models.py.
    duplicate_signal_policy = Column(Text, nullable=False, default="skip")
    counter_signal_policy = Column(Text, nullable=False, default="close_and_flip")
    status = Column(Text, nullable=False, default="draft")
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class Indicator(Base):
    """A reusable indicator definition (e.g. "RSI 14") - any number of
    Rule rows can reference one via rule_config's indicator_id. See
    docs/architecture.md § indicators decoupled from Rule."""

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
    symbol), not rule_id - two Strategies sharing the same Rule each need
    their own independent dedupe state, and a universe-scoped rule checks
    many symbols independently each tick and needs its own dedupe state
    per constituent too."""

    __tablename__ = "engine_runs"
    __table_args__ = {"schema": SCHEMA}

    strategy_id = Column(UUID(as_uuid=True), primary_key=True)
    symbol = Column(Text, primary_key=True)
    last_signal_candle_ts = Column(TIMESTAMP(timezone=True))
    last_checked_at = Column(TIMESTAMP(timezone=True))
