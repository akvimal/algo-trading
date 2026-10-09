-- AI summaries of the RBI speeches and policy releases linked from the pre-market report (2026-10-06). Each item is read ONCE:
-- its full text is fetched, a model summarises it, and the summary is kept here under the item's url so later reports reuse it.
-- `stance` is hawkish/dovish/neutral only when the text itself signals a policy direction, else 'not about policy'.
-- See app/domain/rbi_reader.py.
--
-- Safe to re-run:
--   scripts/migrate.sh apply

CREATE TABLE IF NOT EXISTS market_data.rbi_summaries (
    url         TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    published   TIMESTAMPTZ,
    stance      TEXT NOT NULL CHECK (stance IN ('hawkish', 'dovish', 'neutral', 'not about policy')),
    summary     TEXT NOT NULL,
    rates       TEXT,
    model       TEXT,
    read_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
