-- The thoughts and plans panel under a chart (2026-10-01): free-text notes the person writes while looking at an
-- instrument, each with the market context at that moment and an optional chart snapshot, so their thought process
-- can be studied later and handed to a model. Private to the person (user_id on every query).
--
-- Safe to re-run. Run manually against a populated volume (BEFORE deploying execution code that uses it; test DB
-- first):
--   scripts/migrate.sh apply

CREATE TABLE IF NOT EXISTS execution.study_notes (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL,
    segment          TEXT NOT NULL CHECK (segment IN ('NSE', 'MCX', 'CRYPTO')),
    symbol           TEXT NOT NULL,
    interval         TEXT,
    text             TEXT NOT NULL,
    tag              TEXT CHECK (tag IN ('plan', 'observation', 'mistake', 'review')),
    -- The market as the person saw it when they wrote this: price, regime, structure trend, OI/PCR, the AI read's
    -- bias, whether they held the instrument. What turns a note into something a later study (or a model) can read
    -- against what the market was doing.
    context          JSONB,
    -- Optional link to the trade this note is about.
    position_id      UUID,
    option_group_id  UUID,
    -- A PNG of the chart (composed in the browser). bytea in its own column, like trade_images, and never
    -- selected by the list query.
    snapshot_png     BYTEA,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_study_notes_user_symbol ON execution.study_notes (user_id, segment, symbol, created_at DESC);
