-- Discipline v2, step 3 (docs/discipline-v2-spec.md): what the system's own risk sizing would have bought, recorded when a
-- MANUAL trade opens, so the score can tell a trade taken at the system size from one the person sized up (greed) or down
-- (fear). Same unit as quantity. NULL when it could not be worked out (a spot/future order with no stop, a strategy-driven
-- trade) and for every trade opened before this - the score leaves those out of the size check rather than guessing.
--
-- Safe to re-run. Run manually against a populated volume (BEFORE deploying execution code that uses it; test DB
-- first):
--   scripts/migrate.sh apply

ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS system_quantity NUMERIC;
ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS system_quantity NUMERIC;
