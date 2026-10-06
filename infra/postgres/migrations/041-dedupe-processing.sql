-- Process each piece of news once (2026-10-06).
--  * rbi_summaries.text_hash: a hash of an RBI item's text, so the same text published under a second url reuses the stored summary.
--  * rbi_read_attempts: failed attempts to read an RBI item, so a broken page or failing model backs off and eventually stops
--    instead of being retried every morning (app/domain/rbi_reader.py).
--  * news_article_scores: what the model made of each article for each instrument, so the news digest sends it only articles it
--    has not judged yet (app/domain/news_scores.py).
--
-- Safe to re-run:
--   scripts/migrate.sh apply

ALTER TABLE market_data.rbi_summaries ADD COLUMN IF NOT EXISTS text_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_rbi_summaries_text_hash ON market_data.rbi_summaries (text_hash);

CREATE TABLE IF NOT EXISTS market_data.rbi_read_attempts (
    url              TEXT PRIMARY KEY,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error       TEXT
);

CREATE TABLE IF NOT EXISTS market_data.news_article_scores (
    underlying       TEXT NOT NULL,
    url              TEXT NOT NULL,
    relevant         BOOLEAN NOT NULL,
    relevance_score  INTEGER,
    why              TEXT,
    scored_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (underlying, url)
);
CREATE INDEX IF NOT EXISTS idx_news_article_scores_scored_at ON market_data.news_article_scores (scored_at);
