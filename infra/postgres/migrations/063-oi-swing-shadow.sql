-- The 1-3 day open-interest swing idea, run as a SHADOW (app/domain/oi_swing_shadow.py, app/scheduler.py's _record_oi_swing_shadow): one row per
-- (stock, night) that has an untested trend-aligned daily zone at price, with the value and pass/fail of every criterion, whether a bot
-- following the rules would have taken it, and (filled in once three more bars exist) what it would have done: entry at the next open, stop on the
-- zone's far edge, target 1.5R, out at the third close. No orders are ever placed from this table.
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

CREATE TABLE IF NOT EXISTS market_data.oi_swing_shadow (
    id             BIGSERIAL PRIMARY KEY,
    snapshot_date  DATE NOT NULL,
    exchange       TEXT NOT NULL DEFAULT 'NSE',
    symbol         TEXT NOT NULL,
    direction      TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
    taken          BOOLEAN NOT NULL,
    skip_reason    TEXT,
    score          DOUBLE PRECISION,
    tier           TEXT,
    criteria       JSONB NOT NULL,
    ref_close      DOUBLE PRECISION NOT NULL,
    stop_price     DOUBLE PRECISION NOT NULL,
    risk_pct       DOUBLE PRECISION,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- the outcome, NULL until it is known
    resolved_at    TIMESTAMPTZ,
    result         TEXT CHECK (result IN ('target', 'stop', 'time', 'invalid')),
    entry_price    DOUBLE PRECISION,
    exit_price     DOUBLE PRECISION,
    exit_day       SMALLINT,
    r_multiple     DOUBLE PRECISION,
    mfe_r          DOUBLE PRECISION,
    mae_r          DOUBLE PRECISION,
    UNIQUE (symbol, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_oi_swing_shadow_date ON market_data.oi_swing_shadow (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_oi_swing_shadow_open ON market_data.oi_swing_shadow (snapshot_date) WHERE result IS NULL;
