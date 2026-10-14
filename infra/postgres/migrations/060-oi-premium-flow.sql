-- What happened to the option's own PRICE alongside its open interest, for the nightly OI snapshot. Open interest up has a buyer and a seller; the
-- option's premium says which one pushed: premium up = buying, premium down = writing. Until now the buildup labels used the underlying's price as a
-- stand-in. These columns hold the measured version, from the day this is deployed (nothing earlier can be backfilled: Dhan has no history of chains).
--
--   call_premium_change_pct / put_premium_change_pct : the near-the-money legs' premium change since the previous close, weighted by open interest
--   call_activity / put_activity : buying, writing, writers_covering or unwinding (NULL when the premium or the OI change is unknown or flat)
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

ALTER TABLE market_data.oi_eod_snapshot ADD COLUMN IF NOT EXISTS call_premium_change_pct DOUBLE PRECISION;
ALTER TABLE market_data.oi_eod_snapshot ADD COLUMN IF NOT EXISTS put_premium_change_pct  DOUBLE PRECISION;
ALTER TABLE market_data.oi_eod_snapshot ADD COLUMN IF NOT EXISTS call_activity           TEXT;
ALTER TABLE market_data.oi_eod_snapshot ADD COLUMN IF NOT EXISTS put_activity            TEXT;
