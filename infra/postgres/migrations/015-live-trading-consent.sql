-- Live-trading gate (2026-09-25, Phase 0 of docs/redesign-rollout-plan.md):
-- records WHEN and AGAINST WHICH DISCLOSURE VERSION a person turned real-money
-- order placement on, for both execution.accounts and
-- execution.strategy_accounts. The routes now refuse to enable live trading
-- without consent, set caps and saved broker credentials (see
-- systems/execution/backend/app/domain/live_gate.py). Nullable and additive:
-- accounts that are already live (none in dev at the time of writing) keep
-- working, with no consent on record. Safe to re-run. A fresh install never
-- needs this - the same statements are appended to
-- infra/postgres/init/02-execution.sql.
--
-- Run manually against a populated volume (BEFORE deploying execution code
-- that reads these columns; test DB first):
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/015-live-trading-consent.sql

ALTER TABLE execution.accounts ADD COLUMN IF NOT EXISTS live_trading_consent_at TIMESTAMPTZ;
ALTER TABLE execution.accounts ADD COLUMN IF NOT EXISTS live_trading_consent_version TEXT;
ALTER TABLE execution.strategy_accounts ADD COLUMN IF NOT EXISTS live_trading_consent_at TIMESTAMPTZ;
ALTER TABLE execution.strategy_accounts ADD COLUMN IF NOT EXISTS live_trading_consent_version TEXT;
