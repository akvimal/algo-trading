-- The intraday credit-spread bot (paper only): per-user switch and limits, and a log of every decision it makes (entered or skipped, and why),
-- so the rule can be reviewed and tested before anything is trusted. Off by default: nothing changes for anyone until they switch it on.
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

CREATE TABLE IF NOT EXISTS execution.spread_bot_settings (
    user_id       UUID PRIMARY KEY,
    enabled       BOOLEAN NOT NULL DEFAULT false,
    -- Max loss of one spread as a % of the NSE paper account's balance.
    risk_pct      NUMERIC NOT NULL DEFAULT 1 CHECK (risk_pct > 0 AND risk_pct <= 5),
    symbols       TEXT NOT NULL DEFAULT 'NIFTY,BANKNIFTY',
    entry_from    TIME NOT NULL DEFAULT '09:45',
    entry_to      TIME NOT NULL DEFAULT '13:30',
    -- How many of the four reads (trend, OI, structure, pre-market) must lean the same way, with none leaning the other way.
    min_votes     SMALLINT NOT NULL DEFAULT 3 CHECK (min_votes BETWEEN 2 AND 4),
    width_strikes SMALLINT NOT NULL DEFAULT 2 CHECK (width_strikes BETWEEN 1 AND 10),
    max_trades_per_day SMALLINT NOT NULL DEFAULT 2 CHECK (max_trades_per_day BETWEEN 1 AND 10),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS execution.spread_bot_decisions (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL,
    symbol      TEXT NOT NULL,
    decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    outcome     TEXT NOT NULL CHECK (outcome IN ('entered', 'skipped', 'failed')),
    reason      TEXT NOT NULL,
    -- The four reads (+1 bullish, -1 bearish, 0 none) and the numbers behind the strikes it picked.
    votes       JSONB,
    detail      JSONB,
    group_id    UUID
);
CREATE INDEX IF NOT EXISTS idx_spread_bot_decisions_user_time ON execution.spread_bot_decisions (user_id, decided_at DESC);
