-- Runs automatically on first container start (docker-entrypoint-initdb.d).
-- Each system gets its own schema so systems never share tables.

-- market-data's first-ever table - it was in-memory-cache-only by design
-- otherwise (instrument master, option-chain cache, live feeds - see its
-- README/CLAUDE.md). Added specifically for sentiment_history below; if
-- that ever gets removed, drop this whole file and the schema with it.
CREATE SCHEMA IF NOT EXISTS market_data;

-- One row per (exchange, symbol) per scheduled sentiment poll (see
-- app/scheduler.py's _record_sentiment_history) - the shell header's
-- sentiment badges' own OI-based bullish/bearish read, plus the
-- underlying's spot price at that same moment, so a past read can later
-- be checked against what price actually did afterward. Append-only,
-- never updated - a BIGSERIAL id is enough, nothing references a row by
-- id. Kept indefinitely for now (no retention job) - same as
-- signal_processing.raw_signal_payloads.
CREATE TABLE IF NOT EXISTS market_data.sentiment_history (
    id           BIGSERIAL PRIMARY KEY,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    exchange     TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    direction    TEXT NOT NULL,
    strength     TEXT,
    score_5m     DOUBLE PRECISION,
    score_15m    DOUBLE PRECISION,
    spot_price   DOUBLE PRECISION,
    -- The ATM strike's own call/put buildup classification at this
    -- snapshot (long_buildup/short_buildup/short_covering/long_unwinding
    -- or NULL) - see app.domain.sentiment._atm_buildups. Two separate
    -- columns, deliberately not merged into one - a rising call OI and a
    -- rising put OI mean different things.
    atm_call_buildup TEXT,
    atm_put_buildup  TEXT,
    error        TEXT
);

-- Every read of this table so far is "one symbol's history, newest or
-- oldest first" (see options.py's GET /options/sentiment-history) - this
-- covers that access path directly instead of a full-table scan.
CREATE INDEX IF NOT EXISTS idx_sentiment_history_symbol_time
    ON market_data.sentiment_history (symbol, recorded_at DESC);

-- Standalone price alerts (2026-09-04) - a user adds a level + a
-- direction on any tradeable symbol; app/scheduler.py's
-- _check_price_alerts polls the LTP every minute and, on a crossing,
-- pushes a Telegram message (app/domain/notify.py) then either
-- deactivates the alert (one-shot) or re-arms it (repeat=true). Independent
-- of the Live Chart's browser-only drawing-line alerts. user_id is
-- nullable (an alert added without a logged-in caller belongs to nobody
-- in particular - it still fires, to the one configured Telegram chat).
CREATE TABLE IF NOT EXISTS market_data.price_alerts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID,
    exchange          TEXT NOT NULL,
    symbol            TEXT NOT NULL,
    target_price      NUMERIC NOT NULL CHECK (target_price > 0),
    -- 'above' / 'below' fire once the LTP is on that side of target_price;
    -- 'cross' fires on either crossing (needs last_side to know which way).
    direction         TEXT NOT NULL CHECK (direction IN ('above', 'below', 'cross')),
    note              TEXT,
    repeat            BOOLEAN NOT NULL DEFAULT false,
    active            BOOLEAN NOT NULL DEFAULT true,
    -- 'above' / 'below' / NULL - which side the LTP was on at the last
    -- check, so a crossing (not just "currently past") is what fires.
    last_side         TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_triggered_at TIMESTAMPTZ,
    trigger_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_price_alerts_active
    ON market_data.price_alerts (active) WHERE active;

-- One row per underlying per news-cache refresh (see app/providers/news.py's
-- _refresh_crypto_bucket/_refresh_search_underlying) - the AI trend-relevance
-- digest (bias/bias_reason/digest) plus the scored articles it was built
-- from, so a past prediction can later be checked against what price
-- actually did (same "append-only, checked against reality later" purpose
-- as sentiment_history above). `articles` is the same shape GET /news
-- returns for `articles`, stored as JSONB rather than a child table since
-- it's never queried below the whole-row granularity.
CREATE TABLE IF NOT EXISTS market_data.news_history (
    id          BIGSERIAL PRIMARY KEY,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    underlying  TEXT NOT NULL,
    bias        TEXT NOT NULL,
    bias_reason TEXT NOT NULL,
    digest      TEXT NOT NULL,
    articles    JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_news_history_underlying_time
    ON market_data.news_history (underlying, recorded_at DESC);

-- One row per (symbol, snapshot_date) - the EOD OI-buildup screener's own
-- persisted history (see app/scheduler.py's _record_oi_eod_snapshot +
-- app/domain/oi_buildup.py). Dhan's option-chain API has no historical-OI
-- endpoint at all - this table IS the history, one EOD snapshot per NSE
-- F&O stock per trading day, built up going forward only (nothing before
-- this feature shipped can be backfilled). call_oi_change_pct/
-- put_oi_change_pct/price_change_pct/call_buildup/put_buildup are all
-- computed against the PREVIOUS row for that same symbol at write time -
-- this table is its own day-over-day reference, unlike DhanProvider's
-- in-memory OI history (resets on every backend restart). Kept
-- indefinitely (no retention job), same as sentiment_history/news_history
-- above.
CREATE TABLE IF NOT EXISTS market_data.oi_eod_snapshot (
    id                 BIGSERIAL PRIMARY KEY,
    snapshot_date      DATE NOT NULL,
    exchange           TEXT NOT NULL,
    symbol             TEXT NOT NULL,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    spot_price         DOUBLE PRECISION,
    total_call_oi      BIGINT NOT NULL,
    total_put_oi       BIGINT NOT NULL,
    pcr                DOUBLE PRECISION,
    call_oi_change_pct DOUBLE PRECISION,
    put_oi_change_pct  DOUBLE PRECISION,
    price_change_pct   DOUBLE PRECISION,
    -- long_buildup/short_buildup/short_covering/long_unwinding or NULL -
    -- see app/domain/oi_summary.py's _classify_buildup for the mapping.
    -- Two separate columns, deliberately not merged into one - same
    -- reasoning as sentiment_history's atm_call_buildup/atm_put_buildup.
    call_buildup       TEXT,
    put_buildup        TEXT,
    UNIQUE (symbol, snapshot_date)
);

-- GET /oi-buildup's two access patterns: "every symbol's latest date"
-- (idx on snapshot_date alone, via the UNIQUE constraint's own implicit
-- btree covering symbol+date already handles symbol-scoped lookups) and
-- "one symbol's last N days for its sparkline".
CREATE INDEX IF NOT EXISTS idx_oi_eod_snapshot_symbol_date
    ON market_data.oi_eod_snapshot (symbol, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_oi_eod_snapshot_date
    ON market_data.oi_eod_snapshot (snapshot_date);

-- One row per (symbol, snapshot_date) - the EOD momentum/trend +
-- 52-week-proximity equity screener (see app/scheduler.py's
-- _record_equity_screener_snapshot + app/domain/equity_screener.py).
-- Unlike oi_eod_snapshot above, every metric here is recomputed fresh
-- each day from a trailing window fetched straight off Dhan's own
-- charts/historical endpoint (real multi-year daily bars, one request
-- per symbol, no chunking needed) - only the DERIVED read is persisted
-- here, not raw OHLCV, since Dhan itself already holds that history.
-- Covers ALL NSE-listed equities (~2000), not just the F&O subset
-- oi_eod_snapshot is scoped to.
CREATE TABLE IF NOT EXISTS market_data.equity_screener_snapshot (
    id                 BIGSERIAL PRIMARY KEY,
    snapshot_date      DATE NOT NULL,
    exchange           TEXT NOT NULL,
    symbol             TEXT NOT NULL,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    close              DOUBLE PRECISION NOT NULL,
    pct_change_5d      DOUBLE PRECISION,
    pct_change_20d     DOUBLE PRECISION,
    adx                DOUBLE PRECISION,
    -- trending_up/trending_down/ranging/transitional - see
    -- app/domain/regime.py's Regime literal (the same read backing the
    -- Live Chart's own regime badge).
    regime             TEXT,
    high_52w           DOUBLE PRECISION,
    low_52w            DOUBLE PRECISION,
    pct_from_52w_high  DOUBLE PRECISION,
    pct_from_52w_low   DOUBLE PRECISION,
    -- near_52w_high/near_52w_low or NULL (mid-range, or not enough
    -- history yet - see MIN_BARS_FOR_52W_PROXIMITY).
    proximity          TEXT,
    UNIQUE (symbol, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_equity_screener_snapshot_symbol_date
    ON market_data.equity_screener_snapshot (symbol, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_equity_screener_snapshot_date
    ON market_data.equity_screener_snapshot (snapshot_date);
