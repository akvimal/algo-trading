-- Zones and levels a person has drawn on a chart, watched by the server so a touch reaches their own Telegram chat even with every tab closed
-- (2026-10-06, app/domain/zone_watch.py):
--  * zone_watches: one row per armed zone (a price band) or level (lo = hi) per user and instrument. The browser holds the drawings; it
--    sends the armed ones here, and this table is what the server checks. `interval` is the chart's candle size when it was armed: the call
--    "the zone held / broke" is made on the close of that candle. `role` (support or resistance) is worked out from which side the price was on
--    when the server first saw it. last_state is the price's side at the previous check (above / inside / below).
--  * zone_events: what happened to a zone - a touch, and how the candle that touched it closed (held / broke / closed inside). Kept after a
--    zone is removed (no foreign key), because the end-of-day recap and the delivery history read them. dedupe_key makes each event happen once.
--
-- Safe to re-run:
--   scripts/migrate.sh apply

CREATE TABLE IF NOT EXISTS market_data.zone_watches (
    id               UUID PRIMARY KEY,
    user_id          UUID NOT NULL,
    exchange         TEXT NOT NULL,
    symbol           TEXT NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('zone', 'line')),
    lo               NUMERIC NOT NULL,
    hi               NUMERIC NOT NULL,
    interval         TEXT NOT NULL DEFAULT '15min',
    role             TEXT,
    last_state       TEXT,
    last_checked_at  TIMESTAMPTZ,
    last_bar_checked TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, exchange, symbol, kind, lo, hi)
);
CREATE INDEX IF NOT EXISTS idx_zone_watches_symbol ON market_data.zone_watches (exchange, symbol);

CREATE TABLE IF NOT EXISTS market_data.zone_events (
    id           BIGSERIAL PRIMARY KEY,
    watch_id     UUID,
    user_id      UUID NOT NULL,
    exchange     TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    kind         TEXT NOT NULL,
    lo           NUMERIC NOT NULL,
    hi           NUMERIC NOT NULL,
    role         TEXT,
    event        TEXT NOT NULL CHECK (event IN ('touch', 'held', 'broke', 'inside')),
    at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    bar_time     TIMESTAMPTZ,
    approach     TEXT,
    extreme      NUMERIC,
    close        NUMERIC,
    dedupe_key   TEXT NOT NULL,
    UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_zone_events_user_day ON market_data.zone_events (user_id, at DESC);
