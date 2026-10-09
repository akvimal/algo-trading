-- India's domestic macro backdrop on the pre-market report (2026-10-06): the latest CPI / IIP / GDP / repo / CRR / FX reserves
-- prints with their previous values, the real policy rate and the 10Y-over-repo spread, and the RBI's recent policy-related
-- releases and speeches. Stored with the day's report as one JSONB document; NULL on reports written before this existed or
-- when the macro feeds were unreachable. See app/providers/macro.py and app/domain/premarket_report.py.
--
-- Safe to re-run:
--   scripts/migrate.sh apply

ALTER TABLE market_data.premarket_reports ADD COLUMN IF NOT EXISTS macro JSONB;
