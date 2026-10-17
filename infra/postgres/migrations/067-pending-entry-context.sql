-- A waiting (limit) order now carries the order-time read with it, so the trade it becomes keeps it.
-- execution.pending_orders.entry_context holds what the ticket knew when the order was placed: the system's read of the market (regime, trend, ADX) and
-- the person's own read when they changed it (person_read, overridden). Until now only an immediate market order sent it, so every limit order, every
-- option order placed while the market was shut and every positional spot order reached the post-trade review with no record of the study behind it.
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

ALTER TABLE execution.pending_orders ADD COLUMN IF NOT EXISTS entry_context JSONB;
