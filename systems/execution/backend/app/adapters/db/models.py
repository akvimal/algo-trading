"""SQLAlchemy ORM models mirroring infra/postgres/init/02-execution.sql.

Table DDL lives in that init script, not here. If you add a column,
update both places.
"""

import uuid

from sqlalchemy import Boolean, Column, Date, ForeignKey, Integer, LargeBinary, Numeric, Text, Time, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, TIMESTAMP, UUID
from sqlalchemy.orm import declarative_base

from app.config import settings

Base = declarative_base()
SCHEMA = settings.database_schema


class Settings(Base):
    """NULL user_id = the legacy platform-wide row (automated Strategy-
    driven flow); non-NULL = one SaaS user's own settings - see
    infra/postgres/init/02-execution.sql's own comment on this table."""

    __tablename__ = "settings"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), nullable=True)
    timezone = Column(Text, nullable=False)
    # CRYPTO only, nullable - see ExecutionSettings.usdinr_rate in app/domain/models.py.
    usdinr_rate = Column(Numeric, nullable=True)
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class Account(Base):
    """NULL user_id = the legacy platform-wide account for this segment
    (automated Strategy-driven flow); non-NULL = one SaaS user's own
    account - see infra/postgres/init/02-execution.sql's own comment."""

    __tablename__ = "accounts"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), nullable=True)
    segment = Column(Text, nullable=False)  # 'NSE' | 'MCX' | 'CRYPTO'
    starting_balance = Column(Numeric, nullable=False)
    current_balance = Column(Numeric, nullable=False)  # debited/credited by realized P&L on close
    capital_per_trade = Column(Numeric, nullable=False)
    risk_per_trade_pct = Column(Numeric, nullable=False)
    # Manual tab only (ManualTab.tsx's computeRR) - minimum reward:risk a
    # manual order's Limit(or LTP)/Target/SL Limit must clear before the
    # Add/Update button will place/update it. Not read by the automated
    # Strategy-resolved order path at all.
    min_reward_risk_ratio = Column(Numeric, nullable=False, default=4)
    # Manual tab only (ManualTab.tsx) - spot/future rows only (options
    # have no comparable premium-vs-spot risk figure, same reasoning
    # min_reward_risk_ratio's own RR calc already excludes them for). When
    # true and a flat stop-loss + entry price are both known, the Lot
    # field auto-computes from risk_per_trade_pct/capital_per_trade (same
    # formula position_manager.compute_risk_based_quantity uses
    # server-side) and locks to that value - the computed count is then
    # sent as an explicit quantity at order time, same as a manually
    # typed one, so this needs no new server-side enforcement of its own.
    enforce_risk_based_lots = Column(Boolean, nullable=False, default=False)
    # CRYPTO and NSE (MTF positional spot) only, harmlessly unused for MCX -
    # see app/domain/models.py's AccountOut.leverage.
    leverage = Column(Numeric, nullable=False, default=1)
    # NSE MTF only - see infra/postgres/init/02-execution.sql's own comment.
    mtf_annual_interest_rate_pct = Column(Numeric, nullable=True)
    # NULL means never force-closed (CRYPTO's default) - see app/domain/models.py's AccountOut.square_off_time.
    square_off_time = Column(Time, nullable=True)
    # Live-broker-adapter P0 (see docs/architecture.md) - one of TWO gates
    # (alongside LIVE_TRADING_KILL_SWITCH, app/config.py) that must both
    # pass before any real order reaches Dhan for this account.
    live_trading_enabled = Column(Boolean, nullable=False, default=False)
    max_order_value = Column(Numeric, nullable=True)
    max_daily_loss = Column(Numeric, nullable=True)
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class StrategyAccount(Base):
    """Optional per-strategy override of Account's capital pool - see
    infra/postgres/init/02-execution.sql's own comment on this table for
    the full reasoning. No leverage/square_off_time columns (those stay
    segment-only, always read from Account regardless)."""

    __tablename__ = "strategy_accounts"
    __table_args__ = {"schema": SCHEMA}

    strategy_id = Column(UUID(as_uuid=True), primary_key=True)  # no FK - see table comment
    segment = Column(Text, nullable=False)
    starting_balance = Column(Numeric, nullable=False)
    current_balance = Column(Numeric, nullable=False)
    capital_per_trade = Column(Numeric, nullable=False)
    risk_per_trade_pct = Column(Numeric, nullable=False)
    # Live-broker-adapter P3 item 14 - see infra/postgres/init/
    # 02-execution.sql's own comment on this column.
    live_trading_user_id = Column(UUID(as_uuid=True), nullable=True)
    live_trading_enabled = Column(Boolean, nullable=False, default=False)
    max_order_value = Column(Numeric, nullable=True)
    max_daily_loss = Column(Numeric, nullable=True)
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class ChecklistItem(Base):
    """One row per pre-trade discipline checklist item (Manual tab only) -
    see infra/postgres/init/02-execution.sql's own comment on this table
    for the full design, including why it's edited in place rather than
    referenced by id from Position/OptionPositionGroup.plan_checklist."""

    __tablename__ = "checklist_items"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # NULL = the platform default template; non-NULL = one user's own
    # editable copy - see infra/postgres/init/02-execution.sql's own
    # comment on this table.
    user_id = Column(UUID(as_uuid=True), nullable=True)
    label = Column(Text, nullable=False)
    # 'plan' (pre-trade, gates ManualTab.tsx's own Add button), 'review'
    # (post-trade, self-assessed in the review banner - not required to
    # all be checked), or 'day' (once per calendar day per segment, via
    # GET/PUT /daily-checklist - see execution.daily_checklist_log). See
    # infra/postgres/init/02-execution.sql's own comment on this table.
    phase = Column(Text, nullable=False, default="plan")
    # Empty list (default) = applies to every segment - see that column's
    # own comment on execution.checklist_items.
    segments = Column(ARRAY(Text), nullable=False, default=list)
    sort_order = Column(Integer, nullable=False, default=0)
    active = Column(Boolean, nullable=False, default=True)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class DailyChecklistLog(Base):
    """One row per (calendar day, segment) submission of the 'day'-phase
    checklist - see infra/postgres/init/02-execution.sql's own comment on
    this table for the full design."""

    __tablename__ = "daily_checklist_log"
    __table_args__ = {"schema": SCHEMA}

    user_id = Column(UUID(as_uuid=True), primary_key=True)
    log_date = Column(Date, primary_key=True)
    segment = Column(Text, primary_key=True)
    answers = Column(JSONB(none_as_null=True), nullable=False)
    # One free-text observation for the whole (day, segment) submission,
    # not per item - see infra/postgres/init/02-execution.sql's own
    # comment on this table.
    notes = Column(Text)
    submitted_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class TradingSession(Base):
    """One row per check-in/check-out INSTANCE (not per day - a
    (log_date, segment) can have several, e.g. checked in, broke for
    lunch, checked in again) - see infra/postgres/init/02-execution.sql's
    own comment on this table for the full design. Deliberately separate
    from DailyChecklistLog above (a different concept) rather than two
    more columns there - that table's `answers` is NOT NULL (a checklist
    snapshot only exists once actually submitted), but a session can
    start with no checklist submission at all.
    `checked_out_at` NULL means this is the currently OPEN session for
    its (log_date, segment) - check_in_trading_session refuses to open a
    second one while one's already open, and check_out_trading_session
    always targets this one row."""

    __tablename__ = "trading_sessions"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), nullable=False)
    log_date = Column(Date, nullable=False)
    segment = Column(Text, nullable=False)
    checked_in_at = Column(TIMESTAMP(timezone=True), nullable=False)
    checked_out_at = Column(TIMESTAMP(timezone=True))


class TradeImage(Base):
    """A screenshot/chart snapshot attached to a closed manual trade for
    future review - see infra/postgres/init/02-execution.sql's own
    comment on this table for the full design, including why exactly one
    of position_id/option_group_id is set and why bytea over a filesystem
    path."""

    __tablename__ = "trade_images"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    position_id = Column(UUID(as_uuid=True), nullable=True)
    option_group_id = Column(UUID(as_uuid=True), nullable=True)
    content_type = Column(Text, nullable=False)
    image_data = Column(LargeBinary, nullable=False)
    uploaded_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class OptionPositionGroup(Base):
    """One row per multi-leg option order (Phase 4d of the options
    trading module - see docs/architecture.md) - owns the COMBINED SL/
    target/status/P&L a spread's legs share. Each leg itself is a
    Position row below, linked back here via Position.option_group_id."""

    __tablename__ = "option_position_groups"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # NULL = the automated Strategy-driven flow; non-NULL = a SaaS user's
    # own manual option order - see infra/postgres/init/02-execution.sql's
    # own comment on positions.user_id (identical convention).
    user_id = Column(UUID(as_uuid=True), nullable=True)
    signal_id = Column(UUID(as_uuid=True), nullable=False, unique=True)
    # NULL = manually opened (Manual tab, no auto-provisioned Strategy as
    # of 2026-08-14) - same nullability/meaning as Position.strategy_id.
    strategy_id = Column(UUID(as_uuid=True), nullable=True)
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
    # Underlying's own LTP at open (best-effort, may be NULL) and an
    # optional stop expressed on THAT price instead of the combined
    # premium - independent of sl_scope, checked separately in
    # _evaluate_option_group_exits. See infra/postgres/init/02-execution.sql.
    entry_spot_price = Column(Numeric)
    spot_stop_loss_price = Column(Numeric)
    # Trailing/auto-compute bookkeeping for spot_stop_loss_price - see
    # infra/postgres/init/02-execution.sql's own comment on this column
    # group for why it's separate from combined_stop_loss_price/sl_scope
    # above.
    spot_stop_loss_trailing_enabled = Column(Boolean, nullable=False, default=False)
    spot_stop_loss_indicator_type = Column(Text)
    spot_stop_loss_indicator_params = Column(JSONB(none_as_null=True))
    spot_stop_loss_interval = Column(Text)
    stop_loss_future_symbol = Column(Text)
    stop_loss_future_exchange = Column(Text)
    # Delta Exchange trading-fee simulation (app/domain/delta_fees.py) -
    # CRYPTO only, combined across both legs. See infra/postgres/init/
    # 02-execution.sql's own comment on this column group.
    open_fee = Column(Numeric)
    close_fee = Column(Numeric)
    status = Column(Text, nullable=False, default="OPEN")
    rejection_reason = Column(Text)
    exit_reason = Column(Text)
    exit_time = Column(TIMESTAMP(timezone=True))
    pnl = Column(Numeric)
    square_off_time = Column(Time)
    # Trade discipline checklist (Manual tab only) - see infra/postgres/
    # init/02-execution.sql's own comment on these 4 columns.
    plan_checklist = Column(JSONB(none_as_null=True))
    reviewed_at = Column(TIMESTAMP(timezone=True))
    review_violation = Column(Boolean)
    review_notes = Column(Text)
    review_checklist = Column(JSONB(none_as_null=True))
    # 'market' | 'limit' - see infra/postgres/init/02-execution.sql's own
    # comment on this column. NULL for every Strategy-driven group.
    order_type = Column(Text)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class Position(Base):
    __tablename__ = "positions"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # NULL = the automated Strategy-driven flow; non-NULL = a SaaS user's
    # own manually-placed trade (always paired with strategy_id IS NULL) -
    # see infra/postgres/init/02-execution.sql's own comment.
    user_id = Column(UUID(as_uuid=True), nullable=True)
    signal_id = Column(UUID(as_uuid=True), nullable=False)
    # Nullable: NULL means manually opened (Manual tab), bypassing
    # signal-generation/signal-processing entirely.
    strategy_id = Column(UUID(as_uuid=True), nullable=True)
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
    # Live-broker-adapter P1 - see infra/postgres/init/02-execution.sql's
    # own comment on this column.
    is_live_broker_order = Column(Boolean, nullable=False, default=False)
    # Live-broker-adapter P3 item 14 - see infra/postgres/init/
    # 02-execution.sql's own comment on this column.
    live_trading_user_id = Column(UUID(as_uuid=True), nullable=True)
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
    stop_loss_indicator_type = Column(Text)
    # none_as_null=True - a bare None otherwise serializes as the JSON 'null'
    # literal, not SQL NULL (see signal-generation's identical Strategy
    # column - a real bug there, fixed 2026-08-14, since its own
    # stop_loss_fields_consistent CHECK does "IS NULL" comparisons; no such
    # constraint here, but kept consistent).
    stop_loss_indicator_params = Column(JSONB(none_as_null=True))
    # stop_loss_method='breakeven' only - has the stop already snapped to
    # entry_price and frozen there? Never explicitly set at open time (a
    # brand-new position is always False) - default=False client-side is
    # enough, see position_manager.py's _evaluate_exits.
    breakeven_triggered = Column(Boolean, nullable=False, default=False)
    # 'square_off' | 'stop_loss' | 'target' | 'manual' | 'counter_signal', set when status becomes CLOSED
    exit_reason = Column(Text)
    # The square-off time this position's Strategy set (required there) -
    # copied at open time, never changed afterward. NULL only for
    # REJECTED rows that never got this far. See position_manager.open_position.
    square_off_time = Column(Time)
    # Delta Exchange fee/liquidation simulation (app/domain/delta_fees.py) -
    # CRYPTO + instrument_type='future' only, NULL otherwise. See
    # infra/postgres/init/02-execution.sql's own comment on this column group.
    open_fee = Column(Numeric)
    close_fee = Column(Numeric)
    # Also reused (not CRYPTO-only) for an NSE MTF positional spot position's
    # own capital posted - see infra/postgres/init/02-execution.sql.
    margin_posted = Column(Numeric)
    liquidation_price = Column(Numeric)
    # NSE MTF only - see infra/postgres/init/02-execution.sql's own comment.
    mtf_interest_rate_pct = Column(Numeric)
    interest_charged = Column(Numeric)
    # Trade discipline checklist (Manual tab only) - see infra/postgres/
    # init/02-execution.sql's own comment on these 4 columns. NULL for
    # every Strategy-driven (non-manual) position and for every leg of a
    # manual OPTION order - the checklist/review gate lives on the option
    # GROUP row instead (OptionPositionGroup.plan_checklist etc. above),
    # not on each individual leg Position.
    plan_checklist = Column(JSONB(none_as_null=True))
    reviewed_at = Column(TIMESTAMP(timezone=True))
    review_violation = Column(Boolean)
    review_notes = Column(Text)
    review_checklist = Column(JSONB(none_as_null=True))
    # 'market' | 'limit' - see infra/postgres/init/02-execution.sql's own
    # comment on this column. NULL for every Strategy-driven position and
    # every individual option leg, same scoping as plan_checklist above.
    order_type = Column(Text)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    # Which option_position_groups row this leg belongs to - NULL for
    # every ordinary spot/future position. See docs/architecture.md
    # Phase 4d.
    option_group_id = Column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.option_position_groups.id"))


class PositionPnlSnapshot(Base):
    """Unrealized-P&L time series for one Position, recorded every
    exit-monitor tick while it's OPEN - see infra/postgres/init/
    02-execution.sql's own comment on this table for the full design."""

    __tablename__ = "position_pnl_snapshots"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    position_id = Column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.positions.id", ondelete="CASCADE"), nullable=False)
    cmp = Column(Numeric, nullable=False)
    unrealized_pnl = Column(Numeric, nullable=False)
    recorded_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class OptionGroupPnlSnapshot(Base):
    """Combined-premium unrealized-P&L time series for one
    OptionPositionGroup - the group-level counterpart to
    PositionPnlSnapshot above."""

    __tablename__ = "option_group_pnl_snapshots"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    option_group_id = Column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.option_position_groups.id", ondelete="CASCADE"), nullable=False)
    combined_price = Column(Numeric, nullable=False)
    unrealized_pnl = Column(Numeric, nullable=False)
    recorded_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class BrokerOrder(Base):
    """One real order attempt (entry, exit, or a resting stop-loss) sent to
    Dhan - see infra/postgres/init/02-execution.sql's own comment on this
    table for the full submit-then-crash idempotency design (live-broker-
    adapter plan P0 item 3). No FK ondelete behavior needed on position_id/
    option_group_id beyond the plain REFERENCES the SQL already declares -
    this schema never models deletes (same convention trade_images above
    already follows)."""

    __tablename__ = "broker_orders"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), nullable=True)
    position_id = Column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.positions.id"), nullable=True)
    option_group_id = Column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.option_position_groups.id"), nullable=True)
    purpose = Column(Text, nullable=False)  # 'entry' | 'exit' | 'stop_loss'
    client_order_id = Column(Text, nullable=False, unique=True)
    broker_order_id = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="submitting")  # 'submitting'|'pending'|'traded'|'rejected'|'cancelled'|'failed'
    exchange = Column(Text, nullable=False)  # 'NSE' | 'MCX'
    symbol = Column(Text, nullable=False)
    segment = Column(Text, nullable=False)  # 'NSE' | 'MCX'
    action = Column(Text, nullable=False)  # 'BUY' | 'SELL'
    quantity = Column(Integer, nullable=False)
    order_type = Column(Text, nullable=False)  # 'MARKET'|'LIMIT'|'STOP_LOSS'|'STOP_LOSS_MARKET'
    product_type = Column(Text, nullable=False)  # 'CNC'|'INTRADAY'|'MARGIN'|'MTF'
    price = Column(Numeric, nullable=True)
    trigger_price = Column(Numeric, nullable=True)
    filled_quantity = Column(Integer, nullable=False, default=0)
    average_fill_price = Column(Numeric, nullable=True)
    raw_response = Column(JSONB(none_as_null=True))
    failure_reason = Column(Text, nullable=True)
    requested_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
