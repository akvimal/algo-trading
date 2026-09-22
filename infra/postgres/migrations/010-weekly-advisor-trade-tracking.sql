-- Weekly Advisor trade lifecycle tracking (2026-09-22) - live leg LTP +
-- auto-detection of expiry, see app/scheduler.py's
-- _refresh_weekly_advisor_leg_prices/_expire_weekly_advisor_trades.
--
-- expiry_date: the trade's actual expiry, persisted directly rather than
-- only the derived days_to_expiry_at_entry day-count - needed to gate the
-- expiry-detection job on a real date, not taken_at + a stored offset.
-- prices_updated_at: when `legs` (JSONB, see the column that already
-- exists) was last refreshed with each leg's current_price - a sibling
-- field on each leg entry, not a new column, since legs is already the
-- per-leg array. status widens from ('open','closed') to add 'expired':
-- a trade whose expiry_date has passed is flagged for review rather than
-- silently auto-closed with a guessed P&L - see that job's own docstring
-- for why (this module already refuses to guess at numbers it isn't sure
-- of, e.g. compute_performance_summary excluding a closed trade with no
-- realized_pnl rather than assuming 0).
ALTER TABLE signal_generation.weekly_advisor_trades ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE signal_generation.weekly_advisor_trades ADD COLUMN IF NOT EXISTS prices_updated_at TIMESTAMPTZ;

ALTER TABLE signal_generation.weekly_advisor_trades DROP CONSTRAINT IF EXISTS weekly_advisor_trades_status_check;
ALTER TABLE signal_generation.weekly_advisor_trades ADD CONSTRAINT weekly_advisor_trades_status_check CHECK (status IN ('open', 'expired', 'closed'));
