-- One-time migration for an EXISTING execution schema created before the
-- Live Chart trade panel gained configurable order types + risk-managed
-- placement (2026-09-04, see docs/architecture.md § "Live chart - inline
-- trade panel"). A fresh install never needs this -
-- infra/postgres/init/02-execution.sql already has the target shape.
-- Run manually against a populated volume:
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/003-manual-risk-managed.sql
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the option-group exit_reason
-- CHECK is dropped-then-recreated. Safe to re-run.

BEGIN;

-- --- execution.positions: which discipline modes were active when a
--     Live-Chart-panel manual order was placed. NULL = not a panel order
--     / unknown (every Strategy-driven position, every pre-migration row).
ALTER TABLE execution.positions
    ADD COLUMN IF NOT EXISTS trend_followed BOOLEAN;
ALTER TABLE execution.positions
    ADD COLUMN IF NOT EXISTS risk_managed BOOLEAN;

-- --- execution.option_position_groups: same two flags, plus a
--     server-enforced spot take-profit (sibling of spot_stop_loss_price,
--     checked in _evaluate_option_group_exits).
ALTER TABLE execution.option_position_groups
    ADD COLUMN IF NOT EXISTS trend_followed BOOLEAN;
ALTER TABLE execution.option_position_groups
    ADD COLUMN IF NOT EXISTS risk_managed BOOLEAN;
ALTER TABLE execution.option_position_groups
    ADD COLUMN IF NOT EXISTS spot_target_price NUMERIC;

ALTER TABLE execution.option_position_groups
    DROP CONSTRAINT IF EXISTS option_position_groups_exit_reason_check;
ALTER TABLE execution.option_position_groups
    ADD CONSTRAINT option_position_groups_exit_reason_check
    CHECK (exit_reason IN ('square_off', 'combined_stop_loss', 'combined_target', 'individual_stop_loss', 'individual_target', 'spot_stop_loss', 'spot_target', 'manual', 'counter_signal'));

COMMIT;
