-- Indian trading charges on paper P&L (2026-09-25, Phase 1 of
-- docs/redesign-rollout-plan.md): brokerage, STT/CTT, exchange, SEBI, stamp duty
-- and GST for NSE and MCX positions, so paper results are not flattering.
-- See app/domain/india_charges.py (rates are unverified, versioned data).
--
--   accounts.apply_charges   per-account switch. Existing accounts get FALSE so
--                            their P&L does not silently change; the default is
--                            then flipped to TRUE for every account created from
--                            now on (same pattern as require_stop_loss, 016).
--   positions/option groups: charges       total round-trip charges, INR
--                            charges_detail JSONB breakdown + the schedule version
-- Charges are netted into pnl (and so into the balance) when a position closes.
-- Safe to re-run. A fresh install never needs this - the same statements are
-- appended to infra/postgres/init/02-execution.sql.
--
-- Run manually against a populated volume (BEFORE deploying execution code that
-- reads the columns; test DB first):
--   scripts/migrate.sh apply

ALTER TABLE execution.accounts ADD COLUMN IF NOT EXISTS apply_charges BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE execution.accounts ALTER COLUMN apply_charges SET DEFAULT true;
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS charges NUMERIC;
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS charges_detail JSONB;
ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS charges NUMERIC;
ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS charges_detail JSONB;
