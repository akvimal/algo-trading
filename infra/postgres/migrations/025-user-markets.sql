-- The markets a person chose to practise on at first-run setup (2026-09-26): a subset of
-- NSE / MCX / CRYPTO. Every account row still exists for all three (they are created lazily
-- with defaults), so without this the app cannot tell a market the person picked from one they
-- never asked about, and a new user who chose only stocks would see the default balances of the
-- other two added to their total. Existing users keep all three. Safe to re-run. A fresh install
-- gets the same column from infra/postgres/init/04-accounts.sql.
--
-- Run manually against a populated volume (BEFORE deploying accounts code that reads it; test DB first):
--   scripts/migrate.sh apply

ALTER TABLE accounts.users ADD COLUMN IF NOT EXISTS markets TEXT[] NOT NULL DEFAULT ARRAY['NSE', 'MCX', 'CRYPTO'];
