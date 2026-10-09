-- Price alerts that are only "fired" when delivered, and that go to their OWNER's own Telegram chat (2026-10-06).
--  * price_alerts.delivery_failures / last_error: a crossing whose message could not be sent no longer uses up a one-shot alert;
--    it is retried each pass, the failures are counted and the reason kept (app/domain/price_alerts.py).
--  * alert_channels: each user's own Telegram chat id. The bot is the platform's, the chat is the user's, so one person's alerts
--    no longer land in the operator's chat.
--
-- Safe to re-run:
--   scripts/migrate.sh apply

ALTER TABLE market_data.price_alerts ADD COLUMN IF NOT EXISTS delivery_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE market_data.price_alerts ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE TABLE IF NOT EXISTS market_data.alert_channels (
    user_id           UUID PRIMARY KEY,
    telegram_chat_id  TEXT NOT NULL CHECK (telegram_chat_id ~ '^-?[0-9]{3,20}$'),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
