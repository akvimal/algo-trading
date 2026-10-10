-- Positional Limit entries: a waiting (limit) order can now open a multi-day SPOT hold on the user's positional book.
--   horizon         'intraday' (every existing order) or 'positional'.
--   strategy        gains 'spot': the instrument a positional order opens (the old 'future' value also covers intraday spot).
--   source_note_id  the plan note this order was armed from (Trade this plan), so the note can show where its trade stands.
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

ALTER TABLE execution.pending_orders ADD COLUMN IF NOT EXISTS horizon TEXT NOT NULL DEFAULT 'intraday';
ALTER TABLE execution.pending_orders DROP CONSTRAINT IF EXISTS pending_orders_horizon_check;
ALTER TABLE execution.pending_orders ADD CONSTRAINT pending_orders_horizon_check CHECK (horizon IN ('intraday', 'positional'));

ALTER TABLE execution.pending_orders DROP CONSTRAINT IF EXISTS pending_orders_strategy_check;
ALTER TABLE execution.pending_orders ADD CONSTRAINT pending_orders_strategy_check CHECK (strategy IN ('future', 'naked', 'spread', 'spot'));

ALTER TABLE execution.pending_orders ADD COLUMN IF NOT EXISTS source_note_id UUID;

-- One waiting order per symbol PER BOOK: a swing order and a day order on the same symbol are independent.
DROP INDEX IF EXISTS execution.uq_pending_orders_one_live_per_symbol;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_orders_one_live_per_symbol
    ON execution.pending_orders (user_id, segment, symbol, horizon) WHERE status = 'pending';
