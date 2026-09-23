-- One-time migration for an EXISTING market_data schema created before
-- the OI-buildup screener's EOD snapshot table (2026-09-23 - see
-- docs/architecture.md's OI-by-strike-history idea / app/scheduler.py's
-- _record_oi_eod_snapshot). A fresh install never needs this -
-- infra/postgres/init/05-market-data.sql already has the target shape
-- built in.
--
-- Run manually against a populated volume:
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/011-oi-eod-snapshot.sql

CREATE TABLE IF NOT EXISTS market_data.oi_eod_snapshot (
    id                 BIGSERIAL PRIMARY KEY,
    snapshot_date      DATE NOT NULL,
    exchange           TEXT NOT NULL,
    symbol             TEXT NOT NULL,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    spot_price         DOUBLE PRECISION,
    total_call_oi      BIGINT NOT NULL,
    total_put_oi       BIGINT NOT NULL,
    pcr                DOUBLE PRECISION,
    call_oi_change_pct DOUBLE PRECISION,
    put_oi_change_pct  DOUBLE PRECISION,
    price_change_pct   DOUBLE PRECISION,
    call_buildup       TEXT,
    put_buildup        TEXT,
    UNIQUE (symbol, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_oi_eod_snapshot_symbol_date
    ON market_data.oi_eod_snapshot (symbol, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_oi_eod_snapshot_date
    ON market_data.oi_eod_snapshot (snapshot_date);
