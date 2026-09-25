-- Per-user ownership for signal-engine's core tables (2026-09-25, Phase 0 of
-- docs/redesign-rollout-plan.md): rules, watchlists and indicators gain a
-- nullable created_by (strategies already had one since 2026-08-30). NULL
-- means platform / legacy - such rows are visible only to admins once
-- REQUIRE_AUTH is on. Saved backtests inherit their rule's owner, so they
-- need no column. Safe to re-run. A fresh install never needs this - the
-- same statements are appended to infra/postgres/init/03-signal-generation.sql.
--
-- Run manually against a populated volume (apply BEFORE deploying code that
-- reads the new columns, and on the test DB first):
--   docker compose exec -T postgres psql -U algotrading -d algotrading --     < infra/postgres/migrations/014-signal-engine-ownership.sql

ALTER TABLE signal_generation.rules ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE signal_generation.watchlists ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE signal_generation.indicators ADD COLUMN IF NOT EXISTS created_by UUID;

CREATE INDEX IF NOT EXISTS idx_rules_created_by ON signal_generation.rules (created_by);
CREATE INDEX IF NOT EXISTS idx_watchlists_created_by ON signal_generation.watchlists (created_by);
CREATE INDEX IF NOT EXISTS idx_indicators_created_by ON signal_generation.indicators (created_by);
CREATE INDEX IF NOT EXISTS idx_strategies_created_by ON signal_generation.strategies (created_by);
