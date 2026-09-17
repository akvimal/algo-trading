"""SQLAlchemy ORM model mirroring infra/postgres/init/03-signal-generation.sql."""

import uuid

from sqlalchemy import Boolean, Column, Date, ForeignKey, Integer, LargeBinary, Numeric, Text, func
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import declarative_base

from app.config import settings

Base = declarative_base()
SCHEMA = settings.generation_database_schema


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


class Watchlist(Base):
    """A named, reusable, user-managed group of symbols - referenced by name
    from Rule.underlying when underlying_type='watchlist'. See
    app/domain/rule.py and infra/postgres/init/03-signal-generation.sql for
    the full design."""

    __tablename__ = "watchlists"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(Text, nullable=False, unique=True)
    symbols = Column(Text, nullable=False)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class Strategy(Base):
    __tablename__ = "strategies"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(Text, nullable=False)
    source_type = Column(Text, nullable=False)
    # Provider's own name for the thing that fires this strategy's signals
    # (e.g. the Chartink scan's title) - purely descriptive, external
    # strategies only. See infra/postgres/init/03-signal-generation.sql.
    source_rule_name = Column(Text, nullable=True)
    exchange = Column(Text, nullable=False)
    horizon = Column(Text, nullable=False)
    instrument_type = Column(Text, nullable=False)
    # Which Rule (above) decides when this strategy's signals fire - see
    # app/domain/rule.py. in_house only - NULL for external strategies.
    rule_id = Column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.rules.id"), nullable=True)
    # Whoever was logged in (systems/accounts) when this Strategy was
    # created - no FK, cross-system (accounts owns its own users table, see
    # the systems/* self-containment rule). NULL for one created with no
    # bearer token at all. See StrategyOut's own comment for how this flows
    # through to execution.
    created_by = Column(UUID(as_uuid=True), nullable=True)
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
    # Optional independent exit trigger (a single Condition, reused from
    # MultiConditionRuleConfig's own Term/Condition shape) - see
    # validate_exit_condition in app/domain/generation/models.py and
    # infra/postgres/init/03-signal-generation.sql. none_as_null=True, same
    # reasoning as stop_loss_indicator_params above.
    exit_condition = Column(JSONB(none_as_null=True))
    # instrument_type='option' only - 'spread' or 'naked', see OptionPositionStyle in app/domain/models.py.
    option_position_style = Column(Text, nullable=False, default="spread")
    # instrument_type='option' only - primary leg's strike, see OptionStrikeMoneyness in app/domain/models.py.
    option_strike_moneyness = Column(Text, nullable=False, default="ATM")
    # instrument_type='option' only - combined vs per-leg SL/target, see OptionSlScope in app/domain/models.py.
    option_sl_scope = Column(Text, nullable=False, default="combined")
    # Every instrument_type, nullable - see fixed_lots in app/domain/models.py.
    fixed_lots = Column(Integer, nullable=True)
    # horizon='positional'+instrument_type='spot'+segment='NSE' only - see
    # use_margin in app/domain/models.py.
    use_margin = Column(Boolean, nullable=False, default=False)
    # instrument_type in ('future', 'option') only - see ContractDayFilter in app/domain/models.py.
    contract_day_filter = Column(Text, nullable=False, default="any")
    segment = Column(Text, nullable=False, default="NSE")  # NSE/MCX/CRYPTO
    # Optional per-strategy signal-acceptance window(s) - see
    # infra/postgres/init/03-signal-generation.sql for the full comment.
    # Always a real (possibly empty) JSON array, never NULL - no
    # none_as_null concern here unlike stop_loss_indicator_params above,
    # since this column is never assigned a bare None.
    active_windows = Column(JSONB, nullable=False, default=list)
    # Optional day-of-week filter - see app/domain/models.py's Weekday/
    # active_weekdays comment. Same always-a-real-array convention as
    # active_windows above.
    active_weekdays = Column(JSONB, nullable=False, default=list)
    # Passed through unchanged on resolved-order to execution - see
    # DuplicateSignalPolicy/CounterSignalPolicy in app/domain/models.py.
    duplicate_signal_policy = Column(Text, nullable=False, default="skip")
    counter_signal_policy = Column(Text, nullable=False, default="close_and_flip")
    # rule_config.type='crossover' only - see infra/postgres/init/03-signal-generation.sql's full comment.
    seed_on_activation = Column(Boolean, nullable=False, default=False)
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
    # Retry-on-transient-resolution-failure state - see
    # infra/postgres/init/03-signal-generation.sql's full comment.
    pending_signal_id = Column(UUID(as_uuid=True))
    pending_signal_prior_ts = Column(TIMESTAMP(timezone=True))


class SavedBacktest(Base):
    """A saved snapshot (request + result, frozen at save time) of a
    POST /rules/{id}/backtest run - see infra/postgres/init/
    03-signal-generation.sql for why this stores the result too, not just
    the request."""

    __tablename__ = "saved_backtests"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_id = Column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.rules.id"), nullable=False)
    name = Column(Text, nullable=False)
    from_date = Column(Date, nullable=False)
    to_date = Column(Date, nullable=False)
    request = Column(JSONB, nullable=False)
    result = Column(JSONB, nullable=False)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class WeeklyAdvisorRecommendation(Base):
    """A saved, point-in-time snapshot of one symbol's weekly_advisor
    recommendation - see infra/postgres/init/03-signal-generation.sql for
    why this freezes the result rather than replaying the request later."""

    __tablename__ = "weekly_advisor_recommendations"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    symbol = Column(Text, nullable=False)
    as_of = Column(Date, nullable=False)
    action = Column(Text, nullable=False)
    payload = Column(JSONB, nullable=False)
    saved_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    # Decision log - see infra/postgres/init/03-signal-generation.sql's own
    # comment. One decision per recommendation, overwritten on re-decide.
    decision = Column(Text)
    confidence = Column(Integer)
    decision_comments = Column(Text)
    decided_at = Column(TIMESTAMP(timezone=True))


class WeeklyAdvisorTrade(Base):
    """A manual trade-journal entry against one saved recommendation - see
    infra/postgres/init/03-signal-generation.sql for why this is a manual
    log rather than a real execution-opened position (every weekly_advisor
    strategy is net-short-premium, which execution can't price/size yet)."""

    __tablename__ = "weekly_advisor_trades"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    recommendation_id = Column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.weekly_advisor_recommendations.id"), nullable=False)
    status = Column(Text, nullable=False, default="open")
    quantity = Column(Numeric)
    entry_credit = Column(Numeric)
    entry_notes = Column(Text)
    taken_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    exit_debit = Column(Numeric)
    realized_pnl = Column(Numeric)
    exit_notes = Column(Text)
    closed_at = Column(TIMESTAMP(timezone=True))
    # Manually-entered trade economics - see infra/postgres/init/
    # 03-signal-generation.sql's own comment on why these are typed in,
    # not computed. days_to_expiry_at_entry is the one derived field here.
    funds_needed = Column(Numeric)
    margin_needed = Column(Numeric)
    pop = Column(Numeric)
    max_profit = Column(Numeric)
    max_loss = Column(Numeric)
    days_to_expiry_at_entry = Column(Integer)
    # What the user actually did, captured at mark-as-taken time - may
    # differ from the recommendation's own regime.bias/strategy.action.
    # See infra/postgres/init/03-signal-generation.sql's own comment.
    actual_bias = Column(Text)
    actual_strategy = Column(Text)
    # Per-leg entry data (list of {option_type, strike, side, quantity,
    # entry_price}) + close-out targets - editable after creation (see the
    # /entry route) so provisional numbers logged off-session can be
    # overwritten with real fill prices once the legs actually trigger.
    # See infra/postgres/init/03-signal-generation.sql's own comment.
    legs = Column(JSONB)
    target_pct_of_max_profit = Column(Numeric)
    stop_loss_pct_of_max_loss = Column(Numeric)


class WeeklyAdvisorFundamentals(Base):
    """Cached screener.in screenshot + AI-extracted fundamentals read for
    one symbol - see infra/postgres/init/03-signal-generation.sql for the
    TTL/caching reasoning. Read and written directly by
    app/domain/weekly_advisor/screener_fetch.py via its own SessionLocal
    (not Depends(get_db)) - it's an internal pipeline dependency called
    from inside run_symbol(), not a route handler, same self-contained-
    session pattern as market-data's news.py."""

    __tablename__ = "weekly_advisor_fundamentals"
    __table_args__ = {"schema": SCHEMA}

    symbol = Column(Text, primary_key=True)
    screenshot = Column(LargeBinary, nullable=False)
    fetched_at = Column(TIMESTAMP(timezone=True), nullable=False, server_default=func.now())
    bias = Column(Text)
    confidence = Column(Numeric)
    summary = Column(Text)
    pros = Column(JSONB)
    cons = Column(JSONB)
    reasons = Column(JSONB)
    ai_model = Column(Text)
    analyzed_at = Column(TIMESTAMP(timezone=True))
