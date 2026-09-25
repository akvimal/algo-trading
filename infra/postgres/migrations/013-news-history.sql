-- One-time migration for an EXISTING market_data schema created before
-- market_data.news_history was added to infra/postgres/init/05-market-data.sql
-- (that table never had its own migration file, so any Postgres volume
-- initialised earlier - e.g. the VPS - is missing it and every news refresh
-- logs 'relation "market_data.news_history" does not exist' from
-- app/providers/news.py's _persist_digest). A fresh install never needs this -
-- the init script already has the target shape built in.
--
-- Run manually against a populated volume:
--   docker compose exec -T postgres psql -U algotrading -d algotrading \
--     < infra/postgres/migrations/013-news-history.sql

CREATE TABLE IF NOT EXISTS market_data.news_history (
    id          BIGSERIAL PRIMARY KEY,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    underlying  TEXT NOT NULL,
    bias        TEXT NOT NULL,
    bias_reason TEXT NOT NULL,
    digest      TEXT NOT NULL,
    articles    JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_news_history_underlying_time
    ON market_data.news_history (underlying, recorded_at DESC);
