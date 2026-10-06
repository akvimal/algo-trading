-- Publishing notes as ideas to a Telegram channel/group through a separate bot (2026-10-06), operator only.
--  * ideas_destination: the single chat/channel ideas are posted to (a one-row table).
--  * published_ideas: one row per note that has been published: which messages, where, exactly what text was sent, and when it was
--    published / unpublished. A note is published at most once at a time (app/domain/ideas.py).
--
-- Safe to re-run:
--   scripts/migrate.sh apply

CREATE TABLE IF NOT EXISTS market_data.ideas_destination (
    id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    telegram_chat_id  TEXT NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by        UUID
);

CREATE TABLE IF NOT EXISTS market_data.published_ideas (
    note_id         UUID PRIMARY KEY,
    published_by    UUID NOT NULL,
    chat_id         TEXT NOT NULL,
    message_ids     JSONB NOT NULL,
    text            TEXT NOT NULL,
    has_image       BOOLEAN NOT NULL DEFAULT false,
    published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    unpublished_at  TIMESTAMPTZ
);
