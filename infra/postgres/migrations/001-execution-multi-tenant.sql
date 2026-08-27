-- One-time migration for an EXISTING execution schema (created before
-- Phase 2 of the manual-trading SaaS - see docs/architecture.md). A fresh
-- install never needs this; infra/postgres/init/02-execution.sql already
-- has the target shape built in. Run manually against a populated volume:
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/001-execution-multi-tenant.sql
--
-- Not idempotent-by-IF-NOT-EXISTS the way 02-execution.sql's own inline
-- ALTERs are (a PK/constraint rename can't cleanly re-run) - safe to run
-- ONCE against a volume at this exact pre-Phase-2 shape. Re-running it
-- against an already-migrated volume will error on the first statement
-- (column already exists) rather than silently corrupting anything.
--
-- SEED_USER_ID below is the operator's own accounts.users.id (created
-- during Phase 1's live verification, trader@example.com) - every
-- pre-existing MANUAL row (strategy_id IS NULL) is attributed to this
-- user, matching "your own usage becomes the first account". Automated
-- Strategy-driven rows (strategy_id IS NOT NULL, if any exist) are left
-- at user_id=NULL - the legacy platform-wide convention that flow still
-- uses post-migration. Replace this UUID if running against a different
-- volume/user.

BEGIN;

-- --- settings: SMALLINT id=1 singleton -> UUID id, nullable user_id ----
ALTER TABLE execution.settings DROP CONSTRAINT settings_single_row;
ALTER TABLE execution.settings DROP CONSTRAINT settings_pkey;
ALTER TABLE execution.settings DROP COLUMN id;
ALTER TABLE execution.settings ADD COLUMN id UUID PRIMARY KEY DEFAULT gen_random_uuid();
ALTER TABLE execution.settings ADD COLUMN user_id UUID;
-- The one existing row becomes the seed user's own settings (preserves
-- whatever usdinr_rate/timezone they'd already configured).
UPDATE execution.settings SET user_id = 'e6f0a26b-c1ff-48f4-b12a-1c1405c51ce1' WHERE user_id IS NULL;
ALTER TABLE execution.settings ADD CONSTRAINT uq_settings_user_id UNIQUE NULLS NOT DISTINCT (user_id);
-- Fresh platform-wide row for the automated flow, same default the
-- original singleton always had.
INSERT INTO execution.settings (user_id, timezone) VALUES (NULL, 'Asia/Kolkata')
    ON CONFLICT ON CONSTRAINT uq_settings_user_id DO NOTHING;

-- --- accounts: segment-alone PK -> surrogate id, nullable user_id ------
ALTER TABLE execution.positions DROP CONSTRAINT positions_segment_fkey;
ALTER TABLE execution.option_position_groups DROP CONSTRAINT option_position_groups_segment_fkey;
ALTER TABLE execution.accounts DROP CONSTRAINT accounts_pkey;
ALTER TABLE execution.accounts ADD COLUMN id UUID DEFAULT gen_random_uuid();
ALTER TABLE execution.accounts ADD COLUMN user_id UUID;
ALTER TABLE execution.accounts ALTER COLUMN id SET NOT NULL;
ALTER TABLE execution.accounts ADD PRIMARY KEY (id);
-- The 3 existing (NSE/MCX/CRYPTO) rows become the seed user's own
-- accounts (preserves any capital_per_trade/risk_per_trade_pct/
-- square_off_time customization already made this session).
UPDATE execution.accounts SET user_id = 'e6f0a26b-c1ff-48f4-b12a-1c1405c51ce1' WHERE user_id IS NULL;
ALTER TABLE execution.accounts ADD CONSTRAINT uq_accounts_user_segment UNIQUE NULLS NOT DISTINCT (user_id, segment);
-- Fresh platform-wide rows for the automated flow, same defaults the
-- original seed INSERT always used.
INSERT INTO execution.accounts (user_id, segment, starting_balance, current_balance, capital_per_trade, risk_per_trade_pct, square_off_time)
VALUES
    (NULL, 'NSE', 200000, 200000, 50000, 1.0, '15:00:00'),
    (NULL, 'MCX', 200000, 200000, 50000, 1.0, '22:00:00'),
    (NULL, 'CRYPTO', 200000, 200000, 50000, 1.0, NULL)
ON CONFLICT ON CONSTRAINT uq_accounts_user_segment DO NOTHING;
-- No FK re-added on positions/option_position_groups.segment - accounts.
-- segment alone stopped being unique once user_id was added (see
-- infra/postgres/init/02-execution.sql's own comment on this column).

-- --- positions / option_position_groups: nullable user_id --------------
ALTER TABLE execution.positions ADD COLUMN user_id UUID;
ALTER TABLE execution.option_position_groups ADD COLUMN user_id UUID;
UPDATE execution.positions SET user_id = 'e6f0a26b-c1ff-48f4-b12a-1c1405c51ce1' WHERE strategy_id IS NULL;
UPDATE execution.option_position_groups SET user_id = 'e6f0a26b-c1ff-48f4-b12a-1c1405c51ce1' WHERE strategy_id IS NULL;

-- --- checklist_items: nullable user_id (NULL = platform template) ------
ALTER TABLE execution.checklist_items ADD COLUMN user_id UUID;
-- Existing rows stay user_id=NULL - they already ARE the platform
-- template (see that column's own comment in 02-execution.sql); the seed
-- user's own editable copy is cloned from them lazily on first
-- GET /checklist-items, same as any other new user.

-- --- daily_checklist_log: NOT NULL user_id, PK gains it -----------------
ALTER TABLE execution.daily_checklist_log ADD COLUMN user_id UUID;
UPDATE execution.daily_checklist_log SET user_id = 'e6f0a26b-c1ff-48f4-b12a-1c1405c51ce1' WHERE user_id IS NULL;
ALTER TABLE execution.daily_checklist_log ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE execution.daily_checklist_log DROP CONSTRAINT daily_checklist_log_pkey;
ALTER TABLE execution.daily_checklist_log ADD PRIMARY KEY (user_id, log_date, segment);

-- --- trading_sessions: NOT NULL user_id ---------------------------------
ALTER TABLE execution.trading_sessions ADD COLUMN user_id UUID;
UPDATE execution.trading_sessions SET user_id = 'e6f0a26b-c1ff-48f4-b12a-1c1405c51ce1' WHERE user_id IS NULL;
ALTER TABLE execution.trading_sessions ALTER COLUMN user_id SET NOT NULL;

COMMIT;
