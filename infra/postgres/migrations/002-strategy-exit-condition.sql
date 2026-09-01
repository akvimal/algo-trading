-- One-time migration for EXISTING signal_generation + execution schemas
-- created before Strategy.exit_condition (2026-09-01, see
-- docs/architecture.md's Rules module section). A fresh install never
-- needs this - infra/postgres/init/{02-execution,03-signal-generation}.sql
-- already have the target shape built in. Run manually against a populated
-- volume:
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/002-strategy-exit-condition.sql
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the exit_reason CHECK is
-- dropped-then-recreated. Safe to re-run.

BEGIN;

-- --- signal_generation.strategies: the new exit_condition JSONB --------
ALTER TABLE signal_generation.strategies
    ADD COLUMN IF NOT EXISTS exit_condition JSONB;

-- --- execution.positions: same column, copied from the resolved order
--     at open time, plus 'exit_condition' as a valid exit_reason --------
ALTER TABLE execution.positions
    ADD COLUMN IF NOT EXISTS exit_condition JSONB;

ALTER TABLE execution.positions
    DROP CONSTRAINT IF EXISTS positions_exit_reason_check;
ALTER TABLE execution.positions
    ADD CONSTRAINT positions_exit_reason_check
    CHECK (exit_reason IN ('square_off', 'stop_loss', 'target', 'exit_condition', 'manual', 'counter_signal', 'liquidation'));

COMMIT;
