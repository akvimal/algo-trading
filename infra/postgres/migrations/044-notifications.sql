-- Telegram notifications a person subscribes to (2026-10-06): the pre-market bias, the strong OI buildup digest, and operator alerts.
--  * notification_subscriptions: which categories each user has switched on, with their settings (for example the OI digest's top N).
--    Every category starts off.
--  * notification_log: one row per (user, category, dedupe key) - the pre-market message per day, the OI digest per trading day, an
--    operator alert per distinct problem - so an item is sent once, with how many attempts it took and why the last one failed, which
--    also drives the retry of failed sends and the person's delivery history (app/domain/notifications.py).
--
-- Safe to re-run:
--   scripts/migrate.sh apply

CREATE TABLE IF NOT EXISTS market_data.notification_subscriptions (
    user_id     UUID NOT NULL,
    category    TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT false,
    params      JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS market_data.notification_log (
    user_id          UUID NOT NULL,
    category         TEXT NOT NULL,
    dedupe_key       TEXT NOT NULL,
    text             TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at          TIMESTAMPTZ,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_attempt_at  TIMESTAMPTZ,
    last_error       TEXT,
    PRIMARY KEY (user_id, category, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_notification_log_pending ON market_data.notification_log (created_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_log_user ON market_data.notification_log (user_id, created_at DESC);
