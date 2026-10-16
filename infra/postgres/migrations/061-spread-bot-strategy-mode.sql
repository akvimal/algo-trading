-- The spread bot can now pick its own option strategy: 'credit_spread' (the old behaviour, the default - nothing changes for anyone) or 'auto',
-- where a strong, aligned trend buys the move (a long ATM option, or a debit spread when volatility is high) and anything else sells the credit spread.
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

ALTER TABLE execution.spread_bot_settings
    ADD COLUMN IF NOT EXISTS strategy_mode TEXT NOT NULL DEFAULT 'credit_spread' CHECK (strategy_mode IN ('credit_spread', 'auto'));
