-- Open interest by strike, every five minutes through the NSE session, for NIFTY and BANKNIFTY (nearest expiry, the strikes around the money).
-- Dhan has no history of intraday OI, so this table IS the history: it is what an OI-based intraday strategy can be tested against, built up going
-- forward only. One row per (snapshot, strike). Pruned by the recorder after 90 days.
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

CREATE TABLE IF NOT EXISTS market_data.oi_strike_snapshot (
    id           BIGSERIAL PRIMARY KEY,
    recorded_at  TIMESTAMPTZ NOT NULL,
    exchange     TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    expiry       TEXT NOT NULL,
    spot_price   DOUBLE PRECISION NOT NULL,
    strike       DOUBLE PRECISION NOT NULL,
    ce_oi        BIGINT,
    pe_oi        BIGINT,
    ce_prev_oi   BIGINT,
    pe_prev_oi   BIGINT,
    ce_ltp       DOUBLE PRECISION,
    pe_ltp       DOUBLE PRECISION,
    ce_iv        DOUBLE PRECISION,
    pe_iv        DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_oi_strike_snapshot_symbol_time ON market_data.oi_strike_snapshot (symbol, recorded_at DESC);
