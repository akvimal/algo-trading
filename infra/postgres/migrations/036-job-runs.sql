-- A log of every background-job run in market-data (2026-10-02): the nightly OI buildup and equity screener
-- snapshots, the instrument sync, the Dhan token renewal and the five-minute sentiment recorder. One row per run,
-- written when the run STARTS (status 'running', with a done/total counter that moves as it goes) and closed when it
-- ends, so "is it running now, how far along, when did it last finish and how did it end" can all be read from here.
-- A run still 'running' when the service starts again was cut off by that restart; startup marks it 'interrupted'.
-- Old rows are pruned per job (app/domain/job_tracker.py), so this stays small.
--
-- Safe to re-run. Run manually against a populated volume (BEFORE deploying the market-data code that uses it; test DB
-- first):
--   scripts/migrate.sh apply

CREATE TABLE IF NOT EXISTS market_data.job_runs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id       TEXT NOT NULL,
    label        TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'skipped', 'interrupted')),
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    total        INTEGER,
    done         INTEGER NOT NULL DEFAULT 0,
    tally        JSONB,
    message      TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job_started ON market_data.job_runs (job_id, started_at DESC);
