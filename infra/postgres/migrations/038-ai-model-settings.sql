-- Which OpenRouter model each AI task uses (2026-10-06), chosen at runtime from the web app (More -> AI models) instead
-- of an .env edit and a restart. One row per task ('news', 'premarket', 'ai_read') holding its override, plus an
-- optional row 'default' that every task without its own row falls back to; no row at all means the task uses its
-- .env model. Platform-wide, admin-only. Read through app/domain/ai_models.py.
--
-- Safe to re-run:
--   scripts/migrate.sh apply

CREATE TABLE IF NOT EXISTS market_data.ai_model_settings (
    task        TEXT PRIMARY KEY,
    model       TEXT NOT NULL CHECK (btrim(model) <> ''),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  UUID
);
