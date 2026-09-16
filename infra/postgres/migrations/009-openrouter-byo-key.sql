-- BYO OpenRouter key (2026-09-16) - see infra/postgres/init/04-accounts.sql's
-- own comment on accounts.broker_credentials for the full rationale.
ALTER TABLE accounts.broker_credentials ADD COLUMN IF NOT EXISTS openrouter_api_key_encrypted TEXT;
