-- Positional book: a second, hard-separate paper balance per user and segment, for multi-day (positional, spot) trades.
-- Until now execution.accounts had ONE row per (user, segment), so swing and intraday trades shared one pool of capital
-- and one equity curve. `book` splits it: every existing row is the 'intraday' book, and a 'positional' row is created
-- lazily the first time a positional trade is placed (app/domain/position_manager.py's load_account).
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

ALTER TABLE execution.accounts ADD COLUMN IF NOT EXISTS book TEXT NOT NULL DEFAULT 'intraday';
ALTER TABLE execution.accounts DROP CONSTRAINT IF EXISTS accounts_book_check;
ALTER TABLE execution.accounts ADD CONSTRAINT accounts_book_check CHECK (book IN ('intraday', 'positional'));

ALTER TABLE execution.accounts DROP CONSTRAINT IF EXISTS uq_accounts_user_segment;
ALTER TABLE execution.accounts DROP CONSTRAINT IF EXISTS uq_accounts_user_segment_book;
ALTER TABLE execution.accounts ADD CONSTRAINT uq_accounts_user_segment_book UNIQUE NULLS NOT DISTINCT (user_id, segment, book);
