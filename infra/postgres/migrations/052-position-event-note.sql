-- Trade journal timeline: an optional free-text reason on a stop-loss / target move, written by the person who moved it
-- (PUT /positions/{id}/stop-loss and /target accept an optional `note`). NULL for every earlier row and for auto-trail moves.
--
-- Safe to re-run:
--   scripts/migrate.sh apply

ALTER TABLE execution.position_events ADD COLUMN IF NOT EXISTS note TEXT;
