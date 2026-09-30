-- What the web frontend's manual trade ticket pre-selects on a fresh instrument (2026-09-29):
-- default_instrument chooses between the two top-level chips (Future vs Option); default_option_strategy
-- is a second, independent choice of naked vs spread once "option" is picked - see UserOut's own
-- comment in app/domain/models.py for why these are separate. Existing users default to
-- future/naked, the ticket's own current hardcoded defaults, so nobody's ticket changes shape
-- until they actually set a preference. Safe to re-run. A fresh install gets the same columns
-- from infra/postgres/init/04-accounts.sql.
--
-- Run manually against a populated volume (BEFORE deploying accounts code that reads it; test DB first):
--   scripts/migrate.sh apply

ALTER TABLE accounts.users ADD COLUMN IF NOT EXISTS default_instrument TEXT NOT NULL DEFAULT 'future';
ALTER TABLE accounts.users ADD COLUMN IF NOT EXISTS default_option_strategy TEXT NOT NULL DEFAULT 'naked';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_default_instrument_check') THEN
        ALTER TABLE accounts.users ADD CONSTRAINT users_default_instrument_check CHECK (default_instrument IN ('future', 'option'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_default_option_strategy_check') THEN
        ALTER TABLE accounts.users ADD CONSTRAINT users_default_option_strategy_check CHECK (default_option_strategy IN ('naked', 'spread'));
    END IF;
END $$;
