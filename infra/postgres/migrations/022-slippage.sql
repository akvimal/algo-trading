-- Slippage on paper fills (2026-09-25, Phase 1 of docs/redesign-rollout-plan.md):
-- a per-account cost of N basis points on the turnover of each market-type leg,
-- netted into P&L on close (app/domain/slippage.py). A cost, not a repriced fill.
--
--   accounts.slippage_bps   basis points. Existing accounts get 0 (off) so their
--                           P&L does not silently change; the default is then
--                           flipped to 5 for every account created from now on
--                           (an ASSUMPTION, editable per account; same pattern as
--                           require_stop_loss and apply_charges).
--   positions / option_position_groups.slippage_cost   what was netted, in the
--                           position's own currency; NULL = none applied.
-- Safe to re-run. A fresh install never needs this - the same statements are
-- appended to infra/postgres/init/02-execution.sql.
--
-- Run manually against a populated volume (BEFORE deploying execution code that
-- reads the columns; test DB first):
--   scripts/migrate.sh apply

ALTER TABLE execution.accounts ADD COLUMN IF NOT EXISTS slippage_bps NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE execution.accounts ALTER COLUMN slippage_bps SET DEFAULT 5;
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS slippage_cost NUMERIC;
ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS slippage_cost NUMERIC;
