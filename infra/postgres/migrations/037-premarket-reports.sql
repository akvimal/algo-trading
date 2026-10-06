-- The morning pre-market bias report (2026-10-06): one row per IST day holding the overnight inputs (US close, crude,
-- USDINR, US/India 10Y yields, Indian ADRs, GIFT Nifty), the rule-based score, and the AI model's own call on them
-- (`ai` is NULL, with `ai_error` saying why, when the model did not run). A manual refresh replaces that day's row.
-- Written by market-data's 08:45 IST job and read by GET /premarket. See app/domain/premarket_report.py.
--
-- Safe to re-run:
--   scripts/migrate.sh apply

CREATE TABLE IF NOT EXISTS market_data.premarket_reports (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    day          DATE NOT NULL UNIQUE,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    bias         TEXT NOT NULL CHECK (bias IN ('bullish', 'bearish', 'neutral')),
    agree        BOOLEAN,
    model        TEXT,
    ai_error     TEXT,
    inputs       JSONB NOT NULL,
    rules        JSONB NOT NULL,
    ai           JSONB
);
