-- Per-account "require a stop-loss on every manual order" switch (2026-09-25,
-- Phase 0 of docs/redesign-rollout-plan.md). Existing accounts are added with
-- the switch OFF, so nothing changes for them until it is turned on; the
-- column default is then flipped to ON so every account created from now on
-- (a new SaaS user's rows are created lazily by position_manager.load_account)
-- starts protected. Applies to spot/future manual orders only - option
-- groups take their stop AFTER entry (PUT /option-groups/{id}/stop-loss), so
-- there is nothing to check at entry. Safe to re-run (the ADD is IF NOT
-- EXISTS; re-setting the default is a no-op and never touches existing rows).
-- A fresh install never needs this - the same statements are appended to
-- infra/postgres/init/02-execution.sql.
--
-- Run manually against a populated volume (BEFORE deploying execution code
-- that reads the column; test DB first):
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/016-require-stop-loss.sql

ALTER TABLE execution.accounts ADD COLUMN IF NOT EXISTS require_stop_loss BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE execution.accounts ALTER COLUMN require_stop_loss SET DEFAULT true;
