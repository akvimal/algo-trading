-- The spread bot's daily loss limit: it stops looking for entries for the rest of the day once its own closed trades that day have lost this
-- share of the NSE paper balance. Defaults to 2% (twice the per-trade risk) for everyone, including existing rows.
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

ALTER TABLE execution.spread_bot_settings
    ADD COLUMN IF NOT EXISTS daily_loss_pct NUMERIC NOT NULL DEFAULT 2 CHECK (daily_loss_pct > 0 AND daily_loss_pct <= 20);
