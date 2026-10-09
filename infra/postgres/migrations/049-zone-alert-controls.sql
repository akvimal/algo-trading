-- Controls over the Telegram messages a zone sends (2026-10-09, app/domain/zone_watch.py):
--  * zone_watches.alerts: per zone - 'all' (the touch, then how the candle closed: held or broke), 'close' (only that verdict, no touch
--    ping) or 'off'. A zone you only want in the recap can be silenced without deleting the drawing.
--  * alert_channels.zone_alerts: the same choice for every zone of that person; the quieter of the two wins.
--  * zone_events.notified: whether the event was actually sent. Events are always recorded (the recap and the Latest list read them), but a
--    message is held back when it is switched off, when a candle merely closed inside the zone, or when the same kind of event was
--    already sent for that zone in the last 30 minutes (a 1-minute chart used to send a message per candle).
--
-- Safe to re-run:
--   scripts/migrate.sh apply

ALTER TABLE market_data.zone_watches ADD COLUMN IF NOT EXISTS alerts TEXT NOT NULL DEFAULT 'all' CHECK (alerts IN ('all', 'close', 'off'));
ALTER TABLE market_data.alert_channels ADD COLUMN IF NOT EXISTS zone_alerts TEXT NOT NULL DEFAULT 'all' CHECK (zone_alerts IN ('all', 'close', 'off'));
ALTER TABLE market_data.zone_events ADD COLUMN IF NOT EXISTS notified BOOLEAN NOT NULL DEFAULT TRUE;
