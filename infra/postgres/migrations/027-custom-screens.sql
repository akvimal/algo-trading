-- Saved custom equity screens (2026-09-28, Phase 2 of the custom screener -
-- see docs/architecture.md and migration 026's own groundwork note). One
-- typed condition (app/domain/screener_expr.py) + a label + optional base-
-- universe filters, owned by exactly one user - decided with the user:
-- per-user, never shared platform-wide. Run manually against a populated
-- volume (BEFORE deploying market-data code that reads this table; test DB
-- first): scripts/migrate.sh apply
--
-- Safe to re-run. A fresh install never needs this - the same statement is
-- appended to infra/postgres/init/05-market-data.sql.

CREATE TABLE IF NOT EXISTS market_data.custom_screens (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL,
    label            TEXT NOT NULL,
    expression       TEXT NOT NULL,
    -- NULL on any of these four = no filter on that dimension, not "false"/"none".
    is_fno           BOOLEAN,
    index_membership TEXT,
    min_price        DOUBLE PRECISION,
    max_price        DOUBLE PRECISION,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_custom_screens_user ON market_data.custom_screens (user_id, created_at DESC);
