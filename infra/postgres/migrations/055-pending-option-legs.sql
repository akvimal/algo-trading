-- A waiting (limit) option order now remembers WHICH legs it was armed for, instead of re-picking them when it fires:
--   primary_strike / second_strike / expiry / spread_width   exactly what the Scan option ticket showed (an explicit strike per leg and the
--                    expiry it came from take precedence over the moneyness, as they do for a market order);
--   notes            the person's reason for the trade, kept on the position or spread it opens.
-- Existing orders have none of these (they keep resolving by moneyness, as before).
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

ALTER TABLE execution.pending_orders ADD COLUMN IF NOT EXISTS primary_strike NUMERIC;
ALTER TABLE execution.pending_orders ADD COLUMN IF NOT EXISTS second_strike NUMERIC;
ALTER TABLE execution.pending_orders ADD COLUMN IF NOT EXISTS expiry TEXT;
ALTER TABLE execution.pending_orders ADD COLUMN IF NOT EXISTS spread_width SMALLINT;
ALTER TABLE execution.pending_orders ADD COLUMN IF NOT EXISTS notes TEXT;
