-- What happened to each stock the "major OI shift" alert named (app/domain/oi_alert_outcomes.py, recorded and settled by app/scheduler.py's
-- _record_oi_swing_shadow): one row per (stock, night) the alert picked, with the direction it called and the close-to-close move over the next
-- 1, 2 and 3 daily bars (signed so that positive means the call was right), and the same move averaged over every stock that night (the market),
-- so the alert is judged against doing nothing clever. Nothing reads this to send or trade anything.
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

CREATE TABLE IF NOT EXISTS market_data.oi_alert_outcomes (
    id             BIGSERIAL PRIMARY KEY,
    snapshot_date  DATE NOT NULL,
    symbol         TEXT NOT NULL,
    direction      TEXT NOT NULL CHECK (direction IN ('bullish', 'bearish')),
    score          DOUBLE PRECISION,
    source         TEXT,
    reasons        JSONB,
    ref_close      DOUBLE PRECISION,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- signed % moves (positive = the call was right), NULL until that many bars exist
    ret_1d         DOUBLE PRECISION,
    ret_2d         DOUBLE PRECISION,
    ret_3d         DOUBLE PRECISION,
    -- the same move for the average stock that night, signed the same way, for comparison
    mkt_1d         DOUBLE PRECISION,
    mkt_2d         DOUBLE PRECISION,
    mkt_3d         DOUBLE PRECISION,
    resolved_at    TIMESTAMPTZ,
    UNIQUE (symbol, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_oi_alert_outcomes_open ON market_data.oi_alert_outcomes (snapshot_date) WHERE resolved_at IS NULL;
