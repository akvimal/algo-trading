-- One-time migration for the Discipline-score redesign (2026-09-09, see
-- docs/architecture.md § "Discipline score"). A fresh install never needs
-- this - infra/postgres/init/02-execution.sql already has the target shape.
-- Run manually against a populated volume:
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/008-discipline-plan.sql
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + dropped-then-recreated CHECK.
--
-- - entry_setup_tag / entry_confidence: an IMMUTABLE snapshot of the
--   structured journal AS IT WAS at order time (setup_tag/confidence
--   themselves stay editable via PUT .../tags - that's the "after" review).
--   The discipline score needs both to reward declaring a plan BEFORE and
--   confirming it AFTER. NULL for every Strategy-driven row and every
--   pre-migration trade.
-- - auto_traded: this fill came from the Intraday SuperTrend auto-trader
--   (AutoTradePanel), not a discretionary decision - the discipline score
--   excludes these entirely.

BEGIN;

ALTER TABLE execution.positions
    ADD COLUMN IF NOT EXISTS entry_setup_tag TEXT;
ALTER TABLE execution.positions
    ADD COLUMN IF NOT EXISTS entry_confidence SMALLINT;
ALTER TABLE execution.positions
    DROP CONSTRAINT IF EXISTS positions_entry_confidence_check;
ALTER TABLE execution.positions
    ADD CONSTRAINT positions_entry_confidence_check CHECK (entry_confidence IS NULL OR entry_confidence BETWEEN 1 AND 5);
ALTER TABLE execution.positions
    ADD COLUMN IF NOT EXISTS auto_traded BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE execution.option_position_groups
    ADD COLUMN IF NOT EXISTS entry_setup_tag TEXT;
ALTER TABLE execution.option_position_groups
    ADD COLUMN IF NOT EXISTS entry_confidence SMALLINT;
ALTER TABLE execution.option_position_groups
    DROP CONSTRAINT IF EXISTS option_position_groups_entry_confidence_check;
ALTER TABLE execution.option_position_groups
    ADD CONSTRAINT option_position_groups_entry_confidence_check CHECK (entry_confidence IS NULL OR entry_confidence BETWEEN 1 AND 5);
ALTER TABLE execution.option_position_groups
    ADD COLUMN IF NOT EXISTS auto_traded BOOLEAN NOT NULL DEFAULT false;

COMMIT;
