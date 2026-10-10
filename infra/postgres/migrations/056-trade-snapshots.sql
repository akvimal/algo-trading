-- Chart snapshots kept with a trade, as a record of the plan and of how it was managed.
-- execution.trade_images already held a picture per position or option spread; it now also says WHAT the picture is and what the trade looked like
-- when it was taken:
--   kind          'entry'  the plan at the moment of entry (the chart with its drawings and indicators and the planned entry, stop and target),
--                 'update' a picture taken later, after the chart, the stop or the target was changed,
--                 'upload' a picture the person added by hand (every row that existed before this).
--   caption       the person's own words about it (optional).
--   entry_price, stop_price, target_price   the levels in force when it was taken (an option spread's are levels of the underlying).
-- A waiting (limit) order carries its plan picture until it fills (pending_orders.plan_snapshot), and the picture is attached to the position then.
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

ALTER TABLE execution.trade_images ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'upload';
ALTER TABLE execution.trade_images DROP CONSTRAINT IF EXISTS trade_images_kind_check;
ALTER TABLE execution.trade_images ADD CONSTRAINT trade_images_kind_check CHECK (kind IN ('upload', 'entry', 'update'));
ALTER TABLE execution.trade_images ADD COLUMN IF NOT EXISTS caption TEXT;
ALTER TABLE execution.trade_images ADD COLUMN IF NOT EXISTS entry_price NUMERIC;
ALTER TABLE execution.trade_images ADD COLUMN IF NOT EXISTS stop_price NUMERIC;
ALTER TABLE execution.trade_images ADD COLUMN IF NOT EXISTS target_price NUMERIC;

ALTER TABLE execution.pending_orders ADD COLUMN IF NOT EXISTS plan_snapshot BYTEA;
