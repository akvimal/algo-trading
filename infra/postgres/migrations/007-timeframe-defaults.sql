-- One-time migration for an EXISTING execution schema created before
-- per-segment default execution timeframes + per-trade timeframe
-- journaling (2026-09-05, see docs/architecture.md § "Timeframe
-- consistency"). A fresh install never needs this - infra/postgres/
-- init/02-execution.sql already has the target shape.
-- Run manually against a populated volume:
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/007-timeframe-defaults.sql
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + a dropped-then-recreated CHECK.

BEGIN;

-- --- execution.accounts: the user's own declared execution timeframe per
--     segment (default_interval) + its auto-suggested-but-editable higher
--     pairing (default_higher_interval) - a personal preference, not a
--     server-enforced rule (see position_manager.py - nothing sizing- or
--     order-related reads these). Both NULL until the user opts in via
--     "Your account" (execution's AccountsPage). Same literal set the
--     Live Chart's own interval switcher offers (LiveChartPanel.tsx's
--     INTERVAL_DEFS).
ALTER TABLE execution.accounts
    ADD COLUMN IF NOT EXISTS default_interval TEXT;
ALTER TABLE execution.accounts
    ADD COLUMN IF NOT EXISTS default_higher_interval TEXT;
ALTER TABLE execution.accounts
    DROP CONSTRAINT IF EXISTS accounts_default_interval_check;
ALTER TABLE execution.accounts
    ADD CONSTRAINT accounts_default_interval_check
    CHECK (default_interval IS NULL OR default_interval IN ('1min', '3min', '5min', '15min', '30min', '60min'));
ALTER TABLE execution.accounts
    DROP CONSTRAINT IF EXISTS accounts_default_higher_interval_check;
ALTER TABLE execution.accounts
    ADD CONSTRAINT accounts_default_higher_interval_check
    CHECK (default_higher_interval IS NULL OR default_higher_interval IN ('1min', '3min', '5min', '15min', '30min', '60min'));

-- --- entry_interval: the chart interval a manual trade was actually
--     placed on (a pure journal label, never read by any sizing/order
--     logic - same "just a caller-resolved value" pattern order_type
--     already uses) - lets the Discipline score's "Timeframe consistency"
--     component compare it against the account's own declared default
--     above. NULL for every Strategy-driven row and every pre-migration
--     trade.
ALTER TABLE execution.positions
    ADD COLUMN IF NOT EXISTS entry_interval TEXT;

ALTER TABLE execution.option_position_groups
    ADD COLUMN IF NOT EXISTS entry_interval TEXT;

COMMIT;
