-- First-run onboarding state (2026-09-26, Phase 2 of docs/redesign-rollout-plan.md): the
-- experience the person chose ('guided' adds hints and a first-week checklist, 'pro' is
-- denser) and when they finished (or skipped) the first-run flow. Stored on the user, not in
-- the browser, so it follows them across devices.
--
-- Accounts that already exist predate the flow and are marked as onboarded, so nobody is
-- pushed through a first-run screen on their next login. That backfill runs ONLY the moment
-- the column is added, never on a re-run (which would wrongly mark a real new user as done).
-- A fresh install needs no backfill: the same columns are appended to
-- infra/postgres/init/04-accounts.sql.
--
-- Run manually against a populated volume (BEFORE deploying accounts code that reads the
-- columns; test DB first):
--   scripts/migrate.sh apply

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'accounts' AND table_name = 'users' AND column_name = 'onboarded_at'
    ) THEN
        ALTER TABLE accounts.users ADD COLUMN onboarded_at TIMESTAMPTZ;
        UPDATE accounts.users SET onboarded_at = COALESCE(created_at, now());
    END IF;
END $$;

ALTER TABLE accounts.users ADD COLUMN IF NOT EXISTS experience TEXT NOT NULL DEFAULT 'guided';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_experience_check') THEN
        ALTER TABLE accounts.users ADD CONSTRAINT users_experience_check CHECK (experience IN ('guided', 'pro'));
    END IF;
END $$;
