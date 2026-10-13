-- A market order placed while the market is closed now WAITS for the open and then opens at the latest prices (cancellable meanwhile):
--   fire_when_open              the order has no price trigger; the watcher places it on the first pass after the market opens;
--   combined_stop_loss_price /
--   combined_target_price       the spread's own premium stop/target (a % of max loss/profit), attached right after it opens;
--   strategy                    now also allows 'credit_spread' (bull put / bear call spread).
-- Existing orders are unchanged (fire_when_open false, no combined levels).
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

ALTER TABLE execution.pending_orders ADD COLUMN IF NOT EXISTS fire_when_open BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE execution.pending_orders ADD COLUMN IF NOT EXISTS combined_stop_loss_price NUMERIC;
ALTER TABLE execution.pending_orders ADD COLUMN IF NOT EXISTS combined_target_price NUMERIC;
ALTER TABLE execution.pending_orders DROP CONSTRAINT IF EXISTS pending_orders_strategy_check;
ALTER TABLE execution.pending_orders ADD CONSTRAINT pending_orders_strategy_check CHECK (strategy IN ('future', 'naked', 'spread', 'credit_spread', 'spot'));
