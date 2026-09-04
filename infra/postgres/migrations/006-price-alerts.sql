-- One-time migration for an EXISTING market_data schema created before
-- standalone price alerts (2026-09-04, see docs/architecture.md
-- § "Price alerts + Telegram"). A fresh install never needs this -
-- infra/postgres/init/05-market-data.sql already has it.
-- Run manually against a populated volume:
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/006-price-alerts.sql

BEGIN;

CREATE TABLE IF NOT EXISTS market_data.price_alerts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID,
    exchange          TEXT NOT NULL,
    symbol            TEXT NOT NULL,
    target_price      NUMERIC NOT NULL CHECK (target_price > 0),
    direction         TEXT NOT NULL CHECK (direction IN ('above', 'below', 'cross')),
    note              TEXT,
    repeat            BOOLEAN NOT NULL DEFAULT false,
    active            BOOLEAN NOT NULL DEFAULT true,
    last_side         TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_triggered_at TIMESTAMPTZ,
    trigger_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_price_alerts_active
    ON market_data.price_alerts (active) WHERE active;

COMMIT;
