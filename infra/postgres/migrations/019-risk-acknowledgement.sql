-- Risk acknowledgement recorded at signup (2026-09-25, Phase 0 of
-- docs/redesign-rollout-plan.md): when a person confirmed the risk disclosure,
-- and which version of its wording. Both NULL for accounts created before this
-- existed (they were never asked; nothing is enforced retroactively). Safe to
-- re-run. A fresh install never needs this - the same statements are appended
-- to infra/postgres/init/04-accounts.sql.
--
-- Run manually against a populated volume (BEFORE deploying accounts code that
-- reads the columns; test DB first):
--   scripts/migrate.sh apply

ALTER TABLE accounts.users ADD COLUMN IF NOT EXISTS risk_acknowledged_at TIMESTAMPTZ;
ALTER TABLE accounts.users ADD COLUMN IF NOT EXISTS risk_acknowledged_version TEXT;
