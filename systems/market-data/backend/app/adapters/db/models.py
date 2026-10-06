"""SQLAlchemy ORM models mirroring infra/postgres/init/05-market-data.sql.

Table DDL lives in that init script, not here - these models are for
querying/writing via the ORM, not for generating the schema. If you add a
column, update both places.

market-data's first table ever - see app/config.py's own comment on why
this system, otherwise in-memory-cache-only by design, now has one.
"""

import uuid

from sqlalchemy import BigInteger, Boolean, Column, Date, Float, Integer, Numeric, SmallInteger, Text, UniqueConstraint, func
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
    # Consecutive failed attempts to deliver a crossing, and why the last one failed. See app/domain/price_alerts.py.
    delivery_failures = Column(Integer, nullable=False, default=0)
    last_error = Column(Text)


class AlertChannel(Base):
    """A user's own Telegram chat id for their price alerts (the bot is the platform's). See migration 042."""

    __tablename__ = "alert_channels"
    __table_args__ = {"schema": SCHEMA}

    user_id = Column(UUID(as_uuid=True), primary_key=True)
    telegram_chat_id = Column(Text, nullable=False)
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)


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
    # Cheap, already-available lookups tagged once per symbol per run (see
    # app/scheduler.py) - the base filters the custom screener needs
    # alongside a typed expression: "F&O stocks only", "in Nifty 100", etc.
    # index_memberships is comma-joined ("NIFTY50,NIFTY100,NIFTY500") rather
    # than an array column - one extra split() on read beats an array type
    # this ORM otherwise has no other use for.
    is_fno = Column(Boolean, nullable=False, server_default="false")
    index_memberships = Column(Text)


class EquityDailyBar(Base):
    """One row per (symbol, bar_date) - a rolling raw-OHLCV cache, refreshed
    alongside EquityScreenerSnapshot above from the SAME already-fetched
    Dhan candles (see app/scheduler.py's _record_equity_screener_snapshot) -
    no extra provider calls. Unlike that table, this persists the raw bars
    themselves, not a derived read: the (upcoming) custom equity screener
    evaluates an arbitrary user-typed expression ("ema(5,1d) crosses_below
    ema(20,1d)", "weekly close < min(low, 20w)") that can name any period or
    window, so there is no fixed set of derived columns that would cover
    every expression someone might type - the expression evaluator computes
    directly from these bars (via app/domain/indicators.py) instead. Pruned
    to a rolling window (see the scheduler job) rather than kept forever -
    the 52-week/20-week lookbacks the screener cares about never need more
    than about a year of daily bars."""

    __tablename__ = "equity_daily_bar"
    __table_args__ = (UniqueConstraint("symbol", "bar_date"), {"schema": SCHEMA})

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    symbol = Column(Text, nullable=False)
    exchange = Column(Text, nullable=False)
    bar_date = Column(Date, nullable=False)
    open = Column(Float, nullable=False)
    high = Column(Float, nullable=False)
    low = Column(Float, nullable=False)
    close = Column(Float, nullable=False)
    volume = Column(Float, nullable=False)


class CustomScreen(Base):
    """A saved custom equity screen - a typed condition (app/domain/
    screener_expr.py) plus a label and optional base-universe filters, owned
    by exactly one user (require_user_id, never anonymous - decided with
    the user: per-user, not shared platform-wide, unlike PriceAlert above).
    See app/api/routes/custom_screens.py. is_fno NULL / index_membership
    NULL / min_price NULL / max_price NULL each mean "no filter on this" -
    distinct from false/empty, which would wrongly exclude every stock."""

    __tablename__ = "custom_screens"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), nullable=False)
    label = Column(Text, nullable=False)
    expression = Column(Text, nullable=False)
    is_fno = Column(Boolean)
    index_membership = Column(Text)
    min_price = Column(Float)
    max_price = Column(Float)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


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


class JobRun(Base):
    """One run of a background job (the nightly snapshots, instrument sync, token renewal, sentiment recorder): opened as
    'running' with a moving done/total, closed with how it ended. Written by app/domain/job_tracker.py's DbStore with plain
    SQL; this mirror is for the read side (GET /jobs). See migration 036 and infra/postgres/init/05-market-data.sql."""

    __tablename__ = "job_runs"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id = Column(Text, nullable=False)
    label = Column(Text, nullable=False)
    status = Column(Text, nullable=False)
    started_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    finished_at = Column(TIMESTAMP(timezone=True))
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    total = Column(Integer)
    done = Column(Integer, nullable=False, default=0)
    tally = Column(JSONB)
    message = Column(Text)


class PremarketReport(Base):
    """The morning pre-market bias report, one row per IST day (a refresh replaces that day's row). `inputs` are the
    fetched overnight figures, `rules` the deterministic score, `ai` the model's own call (NULL when it did not run -
    see `ai_error`). See app/domain/premarket_report.py, migration 037 and infra/postgres/init/05-market-data.sql."""

    __tablename__ = "premarket_reports"
    __table_args__ = {"schema": SCHEMA}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    day = Column(Date, nullable=False, unique=True)
    generated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    bias = Column(Text, nullable=False)
    agree = Column(Boolean)
    model = Column(Text)
    ai_error = Column(Text)
    inputs = Column(JSONB, nullable=False)
    rules = Column(JSONB, nullable=False)
    ai = Column(JSONB)
    macro = Column(JSONB)  # India's domestic macro backdrop, see app/providers/macro.py


class AiModelSetting(Base):
    """The OpenRouter model chosen for one AI task, or for every task without its own ('default'). See
    app/domain/ai_models.py, migration 038 and infra/postgres/init/05-market-data.sql."""

    __tablename__ = "ai_model_settings"
    __table_args__ = {"schema": SCHEMA}

    task = Column(Text, primary_key=True)
    model = Column(Text, nullable=False)
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    updated_by = Column(UUID(as_uuid=True))


class RbiSummary(Base):
    """The AI summary of one RBI speech / release, kept so each item is read once. See app/domain/rbi_reader.py,
    migration 040 and infra/postgres/init/05-market-data.sql."""

    __tablename__ = "rbi_summaries"
    __table_args__ = {"schema": SCHEMA}

    url = Column(Text, primary_key=True)
    kind = Column(Text, nullable=False)
    title = Column(Text, nullable=False)
    published = Column(TIMESTAMP(timezone=True))
    stance = Column(Text, nullable=False)
    summary = Column(Text, nullable=False)
    rates = Column(Text)
    model = Column(Text)
    read_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    text_hash = Column(Text, index=True)  # same text under another url reuses the summary


class RbiReadAttempt(Base):
    """A failed attempt to read an RBI item, so it backs off and eventually stops being retried. See app/domain/rbi_reader.py."""

    __tablename__ = "rbi_read_attempts"
    __table_args__ = {"schema": SCHEMA}

    url = Column(Text, primary_key=True)
    attempts = Column(Integer, nullable=False, default=0)
    last_attempt_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    last_error = Column(Text)


class NewsArticleScore(Base):
    """What the model made of one news article for one instrument, so it is judged once. `relevant` False = the model dropped it
    as irrelevant (remembered so it is not re-sent). See app/domain/news_scores.py."""

    __tablename__ = "news_article_scores"
    __table_args__ = {"schema": SCHEMA}

    underlying = Column(Text, primary_key=True)
    url = Column(Text, primary_key=True)
    relevant = Column(Boolean, nullable=False)
    relevance_score = Column(Integer)
    why = Column(Text)
    scored_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)


class IdeasDestination(Base):
    """The one chat/channel ideas are posted to (a one-row table: id is always 1). See migration 043 and app/domain/ideas.py."""

    __tablename__ = "ideas_destination"
    __table_args__ = {"schema": SCHEMA}

    id = Column(SmallInteger, primary_key=True, default=1)
    telegram_chat_id = Column(Text, nullable=False)
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    updated_by = Column(UUID(as_uuid=True))


class PublishedIdea(Base):
    """A note that was published as an idea: which Telegram messages, where, exactly what was sent, and when it went out / was
    taken down. See migration 043 and app/domain/ideas.py."""

    __tablename__ = "published_ideas"
    __table_args__ = {"schema": SCHEMA}

    note_id = Column(UUID(as_uuid=True), primary_key=True)
    published_by = Column(UUID(as_uuid=True), nullable=False)
    chat_id = Column(Text, nullable=False)
    message_ids = Column(JSONB, nullable=False)
    text = Column(Text, nullable=False)
    has_image = Column(Boolean, nullable=False, default=False)
    published_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    unpublished_at = Column(TIMESTAMP(timezone=True))


class NotificationSubscription(Base):
    """A category of Telegram notification a user has switched on, with their settings. See migration 044 and app/domain/notifications.py."""

    __tablename__ = "notification_subscriptions"
    __table_args__ = {"schema": SCHEMA}

    user_id = Column(UUID(as_uuid=True), primary_key=True)
    category = Column(Text, primary_key=True)
    enabled = Column(Boolean, nullable=False, default=False)
    params = Column(JSONB, nullable=False, default=dict)
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)


class NotificationLog(Base):
    """One notification to one person, identified by (user, category, dedupe key) so it is sent once; `sent_at` stays NULL while it is
    still being retried. See migration 044 and app/domain/notifications.py."""

    __tablename__ = "notification_log"
    __table_args__ = {"schema": SCHEMA}

    user_id = Column(UUID(as_uuid=True), primary_key=True)
    category = Column(Text, primary_key=True)
    dedupe_key = Column(Text, primary_key=True)
    text = Column(Text, nullable=False)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    sent_at = Column(TIMESTAMP(timezone=True))
    attempts = Column(Integer, nullable=False, default=0)
    last_attempt_at = Column(TIMESTAMP(timezone=True))
    last_error = Column(Text)



class ZoneWatch(Base):
    """A zone (price band) or level a person armed on a chart, watched by the server. See migration 046 and app/domain/zone_watch.py."""

    __tablename__ = "zone_watches"
    __table_args__ = (UniqueConstraint("user_id", "exchange", "symbol", "kind", "lo", "hi"), {"schema": SCHEMA})

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), nullable=False)
    exchange = Column(Text, nullable=False)
    symbol = Column(Text, nullable=False)
    kind = Column(Text, nullable=False)
    lo = Column(Numeric, nullable=False)
    hi = Column(Numeric, nullable=False)
    interval = Column(Text, nullable=False, default="15min")
    role = Column(Text)
    last_state = Column(Text)
    last_checked_at = Column(TIMESTAMP(timezone=True))
    last_bar_checked = Column(TIMESTAMP(timezone=True))
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class ZoneEvent(Base):
    """What happened to a zone: a touch, and how the candle that touched it closed. Kept after the zone is removed. See migration 046."""

    __tablename__ = "zone_events"
    __table_args__ = (UniqueConstraint("user_id", "dedupe_key"), {"schema": SCHEMA})

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    watch_id = Column(UUID(as_uuid=True))
    user_id = Column(UUID(as_uuid=True), nullable=False)
    exchange = Column(Text, nullable=False)
    symbol = Column(Text, nullable=False)
    kind = Column(Text, nullable=False)
    lo = Column(Numeric, nullable=False)
    hi = Column(Numeric, nullable=False)
    role = Column(Text)
    event = Column(Text, nullable=False)
    at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    bar_time = Column(TIMESTAMP(timezone=True))
    approach = Column(Text)
    extreme = Column(Numeric)
    close = Column(Numeric)
    dedupe_key = Column(Text, nullable=False)
