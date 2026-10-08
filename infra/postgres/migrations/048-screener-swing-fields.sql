-- Descriptive fields on the equity screener snapshot, for the Screener page's universe, liquidity and relative-strength filters (2026-10-08,
-- app/domain/equity_screener.py's swing_fields): 20-day average traded value in Rs crore, the 3-month return, the 12-1 month momentum score, a 3-period RSI,
-- the distance from the 20-day EMA, ATR as a % of the close, and today's volume against its 20-day average. All NULL until the next nightly run fills them
-- in (a symbol with too few bars keeps them NULL), and none of it is a signal: back-tests of short-hold setups on these ideas found no reliable edge.
--
-- Safe to re-run:
--   scripts/migrate.sh apply

ALTER TABLE market_data.equity_screener_snapshot
    ADD COLUMN IF NOT EXISTS avg_turnover_cr DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS ret_3m_pct      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS mom_12_1_pct    DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS rsi3            DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS dist_ema20_pct  DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS atr_pct         DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS vol_ratio       DOUBLE PRECISION;
