-- A person's favourite stocks (2026-10-21): a star on any stock in the app, listed on the Scan page's Watchlist tab.
-- Personal, never shared: every read and write is for the caller's own rows, an admin's included. owner is the
-- caller's user id, or the all-zero id when sign-in is not enforced (a single-user dev setup).
-- Safe to re-run. A fresh install never needs this - the same statements are appended to
-- infra/postgres/init/03-signal-generation.sql.
CREATE TABLE IF NOT EXISTS signal_generation.favorites (
    owner      UUID NOT NULL,
    symbol     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, symbol)
);
