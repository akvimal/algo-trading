-- Default trade instrument per market (2026-10-09): {"NSE": {"instrument": "option", "option_strategy": "naked"}, "CRYPTO": {"instrument": "future"}}.
-- A segment without an entry falls back to the single default_instrument / default_option_strategy (migration 028).
ALTER TABLE accounts.users ADD COLUMN IF NOT EXISTS segment_defaults JSONB NOT NULL DEFAULT '{}'::jsonb;
