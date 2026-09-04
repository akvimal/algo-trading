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
