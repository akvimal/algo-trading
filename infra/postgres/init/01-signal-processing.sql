-- Runs automatically on first container start (docker-entrypoint-initdb.d).
-- Each system gets its own schema so systems never share tables.

CREATE SCHEMA IF NOT EXISTS signal_processing;

-- Raw provider payloads, archived by signal-processing's own webhook
-- intake routes before normalization.
-- Kept indefinitely so a provider format change can be debugged/replayed
-- against real historical payloads.
CREATE TABLE IF NOT EXISTS signal_processing.raw_signal_payloads (
    id           BIGSERIAL PRIMARY KEY,
    provider     TEXT NOT NULL,
    raw_payload  JSONB NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per canonical signal (post-normalization, post-fan-out).
CREATE TABLE IF NOT EXISTS signal_processing.signals (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    strategy_id  UUID NOT NULL,
    symbol       TEXT NOT NULL,
    exchange     TEXT NOT NULL CHECK (exchange IN ('NSE', 'MCX', 'CRYPTO')),
    action       TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
    price        NUMERIC NOT NULL,
    source       TEXT NOT NULL,
    source_meta  JSONB,
    signal_ts    TIMESTAMPTZ NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signals_symbol_received
    ON signal_processing.signals (symbol, received_at DESC);

-- One row per resolved order, published to Redis for execution to consume.
-- horizon/instrument_type are nullable: when resolution fails (unknown/
-- non-live strategy, signal-generation unreachable) there is no
-- resolution output to store, only the rejection_reason. No quantity
-- column - position sizing is execution's job (capital_per_trade), not
-- decided here.
CREATE TABLE IF NOT EXISTS signal_processing.resolved_orders (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id        UUID NOT NULL REFERENCES signal_processing.signals (id),
    strategy_id      UUID NOT NULL,
    symbol           TEXT NOT NULL,
    exchange         TEXT NOT NULL CHECK (exchange IN ('NSE', 'MCX', 'CRYPTO')),
    action           TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
    horizon          TEXT CHECK (horizon IN ('intraday', 'swing', 'positional')),
    instrument_type  TEXT CHECK (instrument_type IN ('spot', 'future', 'option')),
    strategy         JSONB,
    price            NUMERIC NOT NULL,
    -- 'queued': the fast-path placeholder create_signal_from_ingest inserts
    -- immediately, before resolve() has run at all (horizon/instrument_type/
    -- rejection_reason still NULL) - see app/domain/intake/core.py's
    -- create_signal_from_ingest/resolve_and_finalize_signal split. The
    -- background consumer (app/consumers/signal_resolution_consumer.py)
    -- transitions this SAME row to 'pending'/'rejected' shortly after.
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('queued', 'pending', 'sent', 'rejected')),
    rejection_reason TEXT,
    resolved_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resolved_orders_resolved_at
    ON signal_processing.resolved_orders (resolved_at DESC);
