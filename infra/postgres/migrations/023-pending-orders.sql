-- Server-side pending (limit) orders (2026-09-25, Phase 1 of
-- docs/redesign-rollout-plan.md). Until now an armed limit order lived only in the
-- browser (LiveChartPage watched the underlying's price in a timer and fired the
-- order on the first crossing), so it died with the tab and never worked on a
-- phone. This stores it, and a scheduler job (app/domain/pending_orders.py)
-- watches it. PAPER ONLY: a background trigger has no user token, so it cannot
-- place a real order.
--
-- trigger_price is a level of the UNDERLYING's own price (also for option
-- orders: legs are resolved at whatever premium is live when it fires).
-- started_above records which side the underlying was on when the order was
-- armed; the order fires on the first crossing from that side. A row ends in
-- exactly one of: triggered (an order was opened), rejected (the order was
-- placed but execution refused it: see status_reason), failed (it could not be
-- placed at all), cancelled, expired. position_id / option_group_id say what it
-- became (no FK: a soft link that survives deleting the trade).
-- At most ONE pending order per (user, segment, symbol), like the browser panel.
-- Safe to re-run. A fresh install never needs this - the same statements are
-- appended to infra/postgres/init/02-execution.sql.
--
-- Run manually against a populated volume (BEFORE deploying execution code that
-- reads the table; test DB first):
--   scripts/migrate.sh apply

CREATE TABLE IF NOT EXISTS execution.pending_orders (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL,
    segment          TEXT NOT NULL CHECK (segment IN ('NSE', 'MCX', 'CRYPTO')),
    symbol           TEXT NOT NULL,
    action           TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
    strategy         TEXT NOT NULL CHECK (strategy IN ('future', 'naked', 'spread')),
    moneyness        TEXT CHECK (moneyness IN ('ITM2', 'ITM1', 'ATM', 'OTM1', 'OTM2')),
    trigger_price    NUMERIC NOT NULL CHECK (trigger_price > 0),
    started_above    BOOLEAN NOT NULL,
    stop_loss_price  NUMERIC CHECK (stop_loss_price > 0),
    target_price     NUMERIC CHECK (target_price > 0),
    quantity         NUMERIC CHECK (quantity > 0),
    trend_followed   BOOLEAN NOT NULL DEFAULT false,
    risk_managed     BOOLEAN NOT NULL DEFAULT false,
    setup_tag        TEXT,
    confidence       SMALLINT CHECK (confidence BETWEEN 1 AND 5),
    entry_interval   TEXT,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'triggered', 'rejected', 'failed', 'cancelled', 'expired')),
    status_reason    TEXT,
    expires_at       TIMESTAMPTZ NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    triggered_at     TIMESTAMPTZ,
    last_price       NUMERIC,
    last_checked_at  TIMESTAMPTZ,
    position_id      UUID,
    option_group_id  UUID
);
CREATE INDEX IF NOT EXISTS idx_pending_orders_status ON execution.pending_orders (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_orders_user ON execution.pending_orders (user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_orders_one_live_per_symbol
    ON execution.pending_orders (user_id, segment, symbol) WHERE status = 'pending';
