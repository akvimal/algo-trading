-- Runs automatically on first container start (docker-entrypoint-initdb.d).

CREATE SCHEMA IF NOT EXISTS execution;

-- Single-row config, editable via the frontend (PUT /settings).
-- No square_off_time here - every Strategy is required to set its own
-- (signal_generation.strategies.square_off_time, passed through
-- resolved-order), no platform-wide default. Each position stores the
-- time its Strategy gave it (positions.square_off_time below); a
-- periodic job closes each position once local time passes ITS OWN
-- stored value.
-- capital_per_trade/risk_per_trade_pct used to live here but moved onto
-- execution.accounts (one per segment) below - see docs/architecture.md
-- § 'Why paper-trading accounts are per-segment, not per-strategy'.
-- duplicate_signal_policy used to live here too (platform-wide,
-- direction-blind) but moved onto signal_generation.strategies
-- (duplicate_signal_policy/counter_signal_policy, per-strategy and
-- direction-aware) - see position_manager._resolve_signal_conflicts.
CREATE TABLE IF NOT EXISTS execution.settings (
    id                      SMALLINT PRIMARY KEY DEFAULT 1,
    timezone                TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT settings_single_row CHECK (id = 1)
);

INSERT INTO execution.settings (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING;

-- One paper-trading account per segment (NSE/MCX/CRYPTO) - segment as the
-- primary key structurally enforces "one account per segment" rather than
-- just a unique index. Multiple strategies in the same segment share the
-- same account. current_balance is debited/credited by realized P&L on
-- every close path (square-off/stop-loss/target/manual) - no capital is
-- locked while a position is OPEN, unrealized P&L stays computed-only.
-- capital_per_trade/risk_per_trade_pct: same sizing meaning the old
-- execution.settings columns had, now per-account - every position's
-- value is capped at floor(min(capital_per_trade, current_balance) /
-- entry_price) shares; risk_amount = that same effective capital *
-- risk_per_trade_pct / 100 for stop-loss-sized positions. See
-- position_manager.open_position.
CREATE TABLE IF NOT EXISTS execution.accounts (
    segment             TEXT PRIMARY KEY CHECK (segment IN ('NSE', 'MCX', 'CRYPTO')),
    starting_balance    NUMERIC NOT NULL CHECK (starting_balance > 0),
    current_balance     NUMERIC NOT NULL,
    capital_per_trade   NUMERIC NOT NULL CHECK (capital_per_trade > 0),
    risk_per_trade_pct  NUMERIC NOT NULL CHECK (risk_per_trade_pct > 0 AND risk_per_trade_pct <= 100),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO execution.accounts (segment, starting_balance, current_balance, capital_per_trade, risk_per_trade_pct)
VALUES
    ('NSE', 200000, 200000, 50000, 1.0),
    ('MCX', 200000, 200000, 50000, 1.0),
    ('CRYPTO', 200000, 200000, 50000, 1.0)
ON CONFLICT (segment) DO NOTHING;

-- One row per paper position, one row per resolved signal regardless of
-- outcome (OPEN/CLOSED/REJECTED) - horizon/instrument_type are carried
-- through from the resolved order for visibility, not re-derived here.
-- quantity is nullable: a REJECTED row was never sized (computed from
-- capital_per_trade / entry_price only once a position is actually opened).
CREATE TABLE IF NOT EXISTS execution.positions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id        UUID NOT NULL,
    strategy_id      UUID NOT NULL,
    symbol           TEXT NOT NULL,
    exchange         TEXT NOT NULL,
    -- Which execution.accounts row this position was sized against and
    -- (once closed) credited/debited on - copied from the resolved order
    -- at open time, same pattern as stop_loss_method etc. below.
    segment          TEXT NOT NULL REFERENCES execution.accounts (segment),
    action           TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
    horizon          TEXT NOT NULL,
    instrument_type  TEXT NOT NULL,
    quantity         NUMERIC,
    entry_price      NUMERIC NOT NULL,
    entry_time       TIMESTAMPTZ NOT NULL DEFAULT now(),
    exit_price       NUMERIC,
    exit_time        TIMESTAMPTZ,
    pnl              NUMERIC,
    status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'REJECTED')),
    rejection_reason TEXT,
    -- stop_loss_price: current stop, may trail upward/downward (BUY/SELL)
    -- over the position's life - null if its Strategy set no stop-loss
    -- method. initial_stop_loss_price: the stop as computed at open,
    -- an audit trail that never changes even if stop_loss_price trails.
    -- target_price: independent flat %-from-entry take-profit, no
    -- trailing variant. exit_reason: why a CLOSED position closed -
    -- 'counter_signal' is set by _resolve_signal_conflicts when an
    -- opposite-direction signal closes this position ahead of its own
    -- SL/target/square-off (counter_signal_policy='close_and_flip' on
    -- the Strategy that produced the new signal).
    stop_loss_price        NUMERIC,
    initial_stop_loss_price NUMERIC,
    target_price            NUMERIC,
    trailing_stop_enabled   BOOLEAN NOT NULL DEFAULT false,
    -- Copied from the Strategy at open time (not re-fetched later -
    -- execution never calls signal-generation directly) so the
    -- exit-monitor job's trailing logic knows HOW to recompute a
    -- candidate stop without needing the strategy again.
    stop_loss_method        TEXT CHECK (stop_loss_method IN ('previous_candle', 'percent')),
    stop_loss_interval      TEXT CHECK (stop_loss_interval IN ('1min', '5min', '15min', '25min', '60min')),
    stop_loss_percent       NUMERIC,
    exit_reason             TEXT CHECK (exit_reason IN ('square_off', 'stop_loss', 'target', 'manual', 'counter_signal')),
    -- The square-off time this position's Strategy set (required there) -
    -- copied at open time, never changed afterward. NULL only for
    -- REJECTED rows that never got this far. See position_manager.open_position.
    square_off_time  TIME,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per multi-leg option order (Phase 4d of the options trading
-- module - see docs/architecture.md), owning the COMBINED SL/target/
-- status/P&L a spread's legs share - a bull_call_spread/bear_put_spread
-- always has exactly 2 legs today (signal-processing's fixed templates,
-- Phase 4b), each stored as its own execution.positions row (below,
-- linked via option_group_id) rather than duplicating combined fields
-- onto both leg rows.
CREATE TABLE IF NOT EXISTS execution.option_position_groups (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id                UUID NOT NULL UNIQUE,
    strategy_id              UUID NOT NULL,
    underlying_symbol        TEXT NOT NULL,  -- the resolved order's own symbol (e.g. "NIFTY") - NOT either leg's own symbol
    exchange                 TEXT NOT NULL,
    segment                  TEXT NOT NULL REFERENCES execution.accounts (segment),
    strategy_type            TEXT NOT NULL,  -- e.g. "bull_call_spread" - order.strategy['type']
    action                   TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),  -- the original signal direction, not either leg's own action
    horizon                  TEXT NOT NULL,
    quantity                 NUMERIC,  -- lots*lot_size, same units as positions.quantity - NULL if REJECTED
    net_debit                NUMERIC,  -- combined entry premium (long leg - short leg), per unit
    combined_stop_loss_price NUMERIC,
    combined_target_price    NUMERIC,
    status                   TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'REJECTED')),
    rejection_reason         TEXT,
    exit_reason              TEXT CHECK (exit_reason IN ('square_off', 'combined_stop_loss', 'combined_target', 'manual', 'counter_signal')),
    exit_time                TIMESTAMPTZ,
    pnl                      NUMERIC,
    square_off_time          TIME,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which option_position_groups row this leg belongs to - NULL for every
-- ordinary spot/future position (unchanged from before this column
-- existed).
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS option_group_id UUID REFERENCES execution.option_position_groups (id);

-- Idempotency used to be enforced by a UNIQUE index here, back when every
-- resolved signal produced exactly one position row. A multi-leg option
-- order now legitimately produces 2 rows sharing the SAME signal_id (both
-- legs of one spread) - the 1-row-per-signal invariant no longer holds
-- platform-wide, so this can no longer be a unique index. Idempotency
-- enforcement for OPTIONS moves to option_position_groups.signal_id
-- UNIQUE above; spot/future singles are unaffected in practice (still
-- exactly 1 row per signal_id), just no longer backstopped by a DB
-- constraint - open_position()'s existing query-before-insert check was
-- always the real enforcement mechanism (the single-threaded orders
-- consumer never processes two messages concurrently).
DROP INDEX IF EXISTS execution.uq_positions_signal_id;
CREATE INDEX IF NOT EXISTS idx_positions_signal_id ON execution.positions (signal_id);

CREATE INDEX IF NOT EXISTS idx_positions_status ON execution.positions (status);
CREATE INDEX IF NOT EXISTS idx_positions_symbol_entry ON execution.positions (symbol, entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_positions_option_group_id ON execution.positions (option_group_id);
CREATE INDEX IF NOT EXISTS idx_option_position_groups_status ON execution.option_position_groups (status);
