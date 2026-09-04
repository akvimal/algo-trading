-- One-time migration for an EXISTING execution schema created before the
-- Live Chart trade panel's history rows gained a free-text journal note
-- (2026-09-04, see docs/architecture.md § "Live chart - inline trade
-- panel"). A fresh install never needs this -
-- infra/postgres/init/02-execution.sql already has the target shape.
-- Run manually against a populated volume:
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/004-trade-notes.sql
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.

BEGIN;

-- --- A free-text comment a user can attach to (and later edit on) any
--     manual trade, from the Live Chart panel's History list, to review
--     the trade later. Distinct from review_notes (the one-time gated
--     "Complete review" writeup): notes is a plain journal field with no
--     gate, editable any number of times, on OPEN or CLOSED rows.
ALTER TABLE execution.positions
    ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE execution.option_position_groups
    ADD COLUMN IF NOT EXISTS notes TEXT;

COMMIT;
