-- Owner of a dedicated per-strategy account (2026-09-25, Phase 0 of
-- docs/redesign-rollout-plan.md). Until now GET/POST/DELETE /accounts/strategy*
-- needed no login at all, and nothing tied a row to a person, so anyone could
-- create (and thereby re-size) a dedicated account for another user's strategy.
-- owner_user_id is the strategy's creator, taken from signal-engine when the
-- row is created. NULL = platform/legacy: visible to admins (and to the named
-- live-trading user) only.
--
-- One-time backfill: existing rows take the owner of the strategy they belong
-- to. This reads signal_generation.strategies ONCE, here, as a data fix; no
-- application code reads across schemas. Rows whose strategy is gone or has no
-- created_by stay NULL. Safe to re-run (the ADD is IF NOT EXISTS and the
-- backfill only touches rows still NULL). A fresh install never needs this -
-- the same ALTER is appended to infra/postgres/init/02-execution.sql (an empty
-- table has nothing to backfill).
--
-- Run manually against a populated volume (BEFORE deploying execution code
-- that reads the column; test DB first):
--   scripts/migrate.sh apply     (or)
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/018-strategy-account-owner.sql

ALTER TABLE execution.strategy_accounts ADD COLUMN IF NOT EXISTS owner_user_id UUID;
CREATE INDEX IF NOT EXISTS idx_strategy_accounts_owner_user_id ON execution.strategy_accounts (owner_user_id);

UPDATE execution.strategy_accounts sa
   SET owner_user_id = s.created_by
  FROM signal_generation.strategies s
 WHERE s.id = sa.strategy_id
   AND sa.owner_user_id IS NULL
   AND s.created_by IS NOT NULL;
