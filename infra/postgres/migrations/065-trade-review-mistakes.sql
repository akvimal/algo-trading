-- Post-trade review: what went wrong, by cause. mistake_tags is the list of specific mistakes the person confirmed (slugs from
-- app/domain/trade_review.py), root_cause is the EARLIEST level that failed (study, then plan, then execution) or 'clean' when the
-- person says nothing went wrong; NULL = not reviewed yet. entry_context snapshots what the ticket showed at order time (regime, trend,
-- ADX) so "against the trend" can be judged on what was known then. Manual trades only; auto-traded and strategy fills leave these NULL.
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS root_cause TEXT;
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS mistake_tags JSONB;
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS entry_context JSONB;
ALTER TABLE execution.positions DROP CONSTRAINT IF EXISTS positions_root_cause_check;
ALTER TABLE execution.positions ADD CONSTRAINT positions_root_cause_check CHECK (root_cause IN ('study', 'plan', 'execution', 'clean'));

ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS root_cause TEXT;
ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS mistake_tags JSONB;
ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS entry_context JSONB;
ALTER TABLE execution.option_position_groups DROP CONSTRAINT IF EXISTS option_position_groups_root_cause_check;
ALTER TABLE execution.option_position_groups ADD CONSTRAINT option_position_groups_root_cause_check CHECK (root_cause IN ('study', 'plan', 'execution', 'clean'));
