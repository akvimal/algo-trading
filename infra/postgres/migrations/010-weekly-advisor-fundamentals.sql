-- One-time migration for an EXISTING signal_generation schema created
-- before Weekly Advisor's fundamentals table (shipped 2026-09-14, commit
-- 9abe1ee - see docs/architecture.md's Weekly Options Advisor module
-- section). A fresh install never needs this -
-- infra/postgres/init/03-signal-generation.sql already has the target
-- shape built in.
--
-- Found missing on the VPS 2026-09-21: every Weekly Advisor recommendation
-- was silently dropping its fundamentals section (GET /weekly-advisor/run
-- degraded gracefully per-symbol per screener_fetch.py's own "never
-- raises" convention, but the actual cause - relation
-- "signal_generation.weekly_advisor_fundamentals" does not exist - only
-- showed up in signal-engine-backend's own logs, not the API response).
-- This table was only ever added to the init script above, never given
-- its own migration file, so an existing (pre-2026-09-14) Postgres volume
-- never picked it up.
--
-- Run manually against a populated volume:
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/010-weekly-advisor-fundamentals.sql

CREATE TABLE IF NOT EXISTS signal_generation.weekly_advisor_fundamentals (
    symbol      TEXT PRIMARY KEY,
    screenshot  BYTEA NOT NULL,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    bias        TEXT CHECK (bias IN ('bullish', 'bearish', 'neutral')),
    confidence  NUMERIC,
    summary     TEXT,
    pros        JSONB,
    cons        JSONB,
    reasons     JSONB,
    ai_model    TEXT,
    analyzed_at TIMESTAMPTZ
);
