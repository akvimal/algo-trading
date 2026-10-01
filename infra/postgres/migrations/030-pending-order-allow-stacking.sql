-- Whether a waiting (limit) order may open ANOTHER position on an instrument the person already holds
-- (2026-10-01). By default it may not: when its price is hit and an open position (or option group) on
-- the same underlying exists, the order is cancelled with a reason instead of stacking a second trade -
-- found when a second waiting order, placed two seconds after the first had filled, fired four minutes
-- later while the first was still open, and one move stopped out both. Manual trades are independent of
-- the signal-conflict policies (those govern Strategy signals only), so nothing else prevented it.
--
-- Existing rows get false, i.e. the new, safer behaviour. Safe to re-run.
--
-- Run manually against a populated volume (BEFORE deploying execution code that reads/writes it;
-- test DB first):
--   scripts/migrate.sh apply

ALTER TABLE execution.pending_orders ADD COLUMN IF NOT EXISTS allow_stacking BOOLEAN NOT NULL DEFAULT false;
