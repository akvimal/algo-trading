-- The nightly "F&O stocks at a demand or supply zone" shortlist (2026-10-08, app/domain/zone_scan.py, app/scheduler.py's _record_zone_scan):
--  * zone_scan: one row per (symbol, snapshot_date) for every F&O stock with enough stored daily bars. The daily and weekly structure read
--    (confirmed trend on each), the nearest untested trend-aligned daily zone at or approaching price (kind, edges, inside/approaching, distance in
--    percent and ATR), whether a weekly zone of the same kind is also at price and whether the weekly trend is on the zone's side, the open-interest
--    buildup labels copied from that day's oi_eod_snapshot, whether they agree with the zone, and the resulting tier (A, B or C; NULL when there is
--    no zone at price). Every day is kept, not only the latest: the point of storing it is to look back later at what the tiers did next.
--
-- Safe to re-run:
--   scripts/migrate.sh apply

CREATE TABLE IF NOT EXISTS market_data.zone_scan (
    id                 BIGSERIAL PRIMARY KEY,
    snapshot_date      DATE NOT NULL,
    exchange           TEXT NOT NULL,
    symbol             TEXT NOT NULL,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    close              DOUBLE PRECISION NOT NULL,
    daily_trend        TEXT NOT NULL,
    weekly_trend       TEXT,
    weekly_bars        INTEGER NOT NULL DEFAULT 0,
    zone_kind          TEXT CHECK (zone_kind IN ('demand', 'supply')),
    zone_proximal      DOUBLE PRECISION,
    zone_distal        DOUBLE PRECISION,
    zone_position      TEXT CHECK (zone_position IN ('inside', 'approaching')),
    zone_distance_pct  DOUBLE PRECISION,
    zone_distance_atr  DOUBLE PRECISION,
    weekly_zone        BOOLEAN NOT NULL DEFAULT false,
    weekly_agrees      BOOLEAN NOT NULL DEFAULT false,
    call_buildup       TEXT,
    put_buildup        TEXT,
    oi_agrees          BOOLEAN,
    tier               TEXT CHECK (tier IN ('A', 'B', 'C')),
    UNIQUE (symbol, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_zone_scan_date ON market_data.zone_scan (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_zone_scan_date_tier ON market_data.zone_scan (snapshot_date, tier);
