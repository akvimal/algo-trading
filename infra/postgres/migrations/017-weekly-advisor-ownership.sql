-- Per-user ownership for the Weekly Advisor (2026-09-25, Phase 0 of
-- docs/redesign-rollout-plan.md): saved recommendations gain a nullable
-- created_by. Trades hang off a recommendation (ON DELETE CASCADE) and
-- inherit its owner, so they need no column; weekly_advisor_fundamentals is a
-- shared per-symbol cache and stays global on purpose. NULL means platform /
-- legacy: such rows are visible only to admins once REQUIRE_AUTH is on. Safe
-- to re-run. A fresh install never needs this - the same statements are
-- appended to infra/postgres/init/03-signal-generation.sql.
--
-- Run manually against a populated volume (BEFORE deploying code that reads
-- the column; test DB first):
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/017-weekly-advisor-ownership.sql

ALTER TABLE signal_generation.weekly_advisor_recommendations ADD COLUMN IF NOT EXISTS created_by UUID;
CREATE INDEX IF NOT EXISTS idx_weekly_advisor_recommendations_created_by
    ON signal_generation.weekly_advisor_recommendations (created_by);
