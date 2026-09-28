-- Groundwork for a custom, expression-based equity screener (2026-09-28,
-- Phase 1 of docs/redesign-rollout-plan.md's screener work - the UI and the
-- actual expression parser/evaluator come later; this is just the data
-- foundation both will need). Run manually against a populated volume
-- (BEFORE deploying market-data code that reads these): scripts/migrate.sh apply
--
-- Two additions:
--   1. equity_screener_snapshot gains is_fno / index_memberships - cheap,
--      already-available tags (DhanProvider.list_fno_stock_underlyings,
--      app/providers/nse_indices.py's synced constituent lists) so the
--      screener can filter "F&O stocks only" / "in Nifty 100" etc.
--      alongside a typed condition, without a second lookup per query.
--   2. A new equity_daily_bar table: a rolling raw-OHLCV cache, refreshed
--      from the SAME Dhan candles the snapshot job already fetches (no
--      extra provider calls) - see app/adapters/db/models.py's
--      EquityDailyBar for why raw bars are kept here rather than only more
--      derived columns: an arbitrary user-typed expression can name any
--      EMA period or lookback window, so there is no fixed set of
--      precomputed columns that would cover every expression someone might
--      type. Pruned to a rolling window by the scheduler job, not kept
--      forever.
--
-- Safe to re-run. A fresh install never needs this - the same statements
-- are appended to infra/postgres/init/05-market-data.sql.

ALTER TABLE market_data.equity_screener_snapshot
    ADD COLUMN IF NOT EXISTS is_fno BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS index_memberships TEXT;

CREATE TABLE IF NOT EXISTS market_data.equity_daily_bar (
    id       BIGSERIAL PRIMARY KEY,
    symbol   TEXT NOT NULL,
    exchange TEXT NOT NULL,
    bar_date DATE NOT NULL,
    open     DOUBLE PRECISION NOT NULL,
    high     DOUBLE PRECISION NOT NULL,
    low      DOUBLE PRECISION NOT NULL,
    close    DOUBLE PRECISION NOT NULL,
    volume   DOUBLE PRECISION NOT NULL,
    UNIQUE (symbol, bar_date)
);
CREATE INDEX IF NOT EXISTS idx_equity_daily_bar_symbol_date
    ON market_data.equity_daily_bar (symbol, bar_date DESC);
