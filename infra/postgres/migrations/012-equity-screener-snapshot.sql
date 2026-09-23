-- One-time migration for an EXISTING market_data schema created before
-- the EOD equity screener's snapshot table (2026-09-23 - momentum/trend +
-- 52-week proximity across all NSE equities, see app/scheduler.py's
-- _record_equity_screener_snapshot). A fresh install never needs this -
-- infra/postgres/init/05-market-data.sql already has the target shape
-- built in.
--
-- Run manually against a populated volume:
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/012-equity-screener-snapshot.sql

CREATE TABLE IF NOT EXISTS market_data.equity_screener_snapshot (
    id                 BIGSERIAL PRIMARY KEY,
    snapshot_date      DATE NOT NULL,
    exchange           TEXT NOT NULL,
    symbol             TEXT NOT NULL,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    close              DOUBLE PRECISION NOT NULL,
    pct_change_5d      DOUBLE PRECISION,
    pct_change_20d     DOUBLE PRECISION,
    adx                DOUBLE PRECISION,
    regime             TEXT,
    high_52w           DOUBLE PRECISION,
    low_52w            DOUBLE PRECISION,
    pct_from_52w_high  DOUBLE PRECISION,
    pct_from_52w_low   DOUBLE PRECISION,
    proximity          TEXT,
    UNIQUE (symbol, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_equity_screener_snapshot_symbol_date
    ON market_data.equity_screener_snapshot (symbol, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_equity_screener_snapshot_date
    ON market_data.equity_screener_snapshot (snapshot_date);
