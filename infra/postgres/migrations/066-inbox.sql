-- The in-app inbox: warnings, alerts and to-dos for one person, each unread until opened. Owned by execution; other services post over
-- its internal route. kind 'event' is a one-off (a loss limit hit, an OI shift, a bot entry); kind 'todo' is a live condition that
-- clears itself when it is fixed (trades owing a review), so resolved_at is set instead of the row piling up. dedupe_key makes a
-- repeated warning one row (unique per person while set).
--
-- Safe to re-run. Apply to the dev database first (scripts/migrate.sh apply), then test, then the VPS.

CREATE TABLE IF NOT EXISTS execution.inbox_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('event', 'todo')),
    category      TEXT NOT NULL,
    severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'alert')),
    title         TEXT NOT NULL,
    body          TEXT,
    link          TEXT,
    dedupe_key    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at       TIMESTAMPTZ,
    dismissed_at  TIMESTAMPTZ,
    resolved_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_items_dedupe ON execution.inbox_items (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_items_user_created ON execution.inbox_items (user_id, created_at DESC);
