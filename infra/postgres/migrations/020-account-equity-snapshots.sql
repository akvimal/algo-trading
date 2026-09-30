-- Balance and equity history for paper accounts (2026-09-25, Phase 1 of
-- docs/redesign-rollout-plan.md). Until now an account only held its CURRENT
-- balance, so there was no equity curve, no drawdown, and nothing a
-- graduation gate could trust. One row per account per day (in
-- EQUITY_HISTORY_TIMEZONE, Asia/Kolkata), updated in place through the day, so
-- the last write is the day's close:
--   balance        realized balance (current_balance, fees included)
--   unrealized_pnl mark-to-market of open positions at the time of the write
--   equity         balance + unrealized_pnl
-- Rows are SPARSE: a day with nothing open and no balance change writes no row
-- (consumers forward-fill). is_reset_point marks a reset / re-baseline so
-- statistics can measure from the latest one only (a reset starts a new
-- curve, it never hides the old one). Only accounts with a user_id are
-- recorded. Safe to re-run. A fresh install never needs this - the same
-- statements are appended to infra/postgres/init/02-execution.sql.
--
-- Run manually against a populated volume (BEFORE deploying execution code
-- that reads the table; test DB first):
--   scripts/migrate.sh apply

CREATE TABLE IF NOT EXISTS execution.account_equity_snapshots (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id        UUID NOT NULL REFERENCES execution.accounts (id) ON DELETE CASCADE,
    user_id           UUID,
    segment           TEXT NOT NULL,
    snapshot_date     DATE NOT NULL,
    starting_balance  NUMERIC NOT NULL,
    balance           NUMERIC NOT NULL,
    unrealized_pnl    NUMERIC NOT NULL DEFAULT 0,
    equity            NUMERIC NOT NULL,
    open_positions    INTEGER NOT NULL DEFAULT 0,
    is_reset_point    BOOLEAN NOT NULL DEFAULT false,
    taken_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_account_equity_snapshots_day UNIQUE (account_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_account_equity_snapshots_user_segment
    ON execution.account_equity_snapshots (user_id, segment, snapshot_date);
