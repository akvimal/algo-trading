-- One-time migration for an EXISTING execution schema created before
-- manual trades gained a structured setup tag + a confidence rating
-- (2026-09-04, see docs/architecture.md § "Live chart - inline trade
-- panel" and § "Trading Performance"). A fresh install never needs this -
-- infra/postgres/init/02-execution.sql already has the target shape.
-- Run manually against a populated volume:
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/005-trade-journal.sql
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + a dropped-then-recreated CHECK.

BEGIN;

-- --- setup_tag: the reason the trade was taken, chosen from a fixed list
--     in the Live Chart trade panel (SETUP_TAGS in manualOrder.ts) - so
--     Trading Performance can slice win-rate / expectancy by setup type.
--     confidence: a 1-5 self-rating at entry. Both nullable, editable
--     after the fact from the History list (PUT .../tags), NULL for every
--     Strategy-driven row and every pre-migration trade.
ALTER TABLE execution.positions
    ADD COLUMN IF NOT EXISTS setup_tag TEXT;
ALTER TABLE execution.positions
    ADD COLUMN IF NOT EXISTS confidence SMALLINT;
ALTER TABLE execution.positions
    DROP CONSTRAINT IF EXISTS positions_confidence_check;
ALTER TABLE execution.positions
    ADD CONSTRAINT positions_confidence_check CHECK (confidence IS NULL OR confidence BETWEEN 1 AND 5);

ALTER TABLE execution.option_position_groups
    ADD COLUMN IF NOT EXISTS setup_tag TEXT;
ALTER TABLE execution.option_position_groups
    ADD COLUMN IF NOT EXISTS confidence SMALLINT;
ALTER TABLE execution.option_position_groups
    DROP CONSTRAINT IF EXISTS option_position_groups_confidence_check;
ALTER TABLE execution.option_position_groups
    ADD CONSTRAINT option_position_groups_confidence_check CHECK (confidence IS NULL OR confidence BETWEEN 1 AND 5);

COMMIT;
