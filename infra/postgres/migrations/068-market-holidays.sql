-- Exchange holidays an admin maintains from the web app. They are layered over the built-in list in
-- systems/market-data/backend/app/data/india_calendar.json: a row here wins over the file for the same date, and a row whose
-- nse status is 'open' removes a holiday the file lists. nse: closed | special | open. mcx: closed | morning_closed | special | open.
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

CREATE TABLE IF NOT EXISTS market_data.market_holidays (
    holiday_date  DATE PRIMARY KEY,
    name          TEXT NOT NULL,
    nse           TEXT NOT NULL DEFAULT 'closed' CHECK (nse IN ('closed', 'special', 'open')),
    mcx           TEXT NOT NULL DEFAULT 'closed' CHECK (mcx IN ('closed', 'morning_closed', 'special', 'open')),
    detail        TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
