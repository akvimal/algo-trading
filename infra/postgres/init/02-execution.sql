-- Runs automatically on first container start (docker-entrypoint-initdb.d).

CREATE SCHEMA IF NOT EXISTS execution;

-- Single-row config, editable via the frontend (PUT /settings).
-- No square_off_time here either - it's per-SEGMENT now
-- (execution.accounts.square_off_time below), not platform-wide and not
-- per-Strategy (Strategy carried its own square_off_time until this was
-- moved - see docs/architecture.md). Each position stores its segment's
-- time at open time (positions.square_off_time below); a periodic job
-- closes each position once local time passes ITS OWN stored value.
-- capital_per_trade/risk_per_trade_pct used to live here but moved onto
-- execution.accounts (one per segment) below - see docs/architecture.md
-- § 'Why paper-trading accounts are per-segment, not per-strategy'.
-- duplicate_signal_policy used to live here too (platform-wide,
-- direction-blind) but moved onto signal_generation.strategies
-- (duplicate_signal_policy/counter_signal_policy, per-strategy and
-- direction-aware) - see position_manager._resolve_signal_conflicts.
-- user_id NULL = the legacy platform-wide settings row, read by the
-- automated Strategy-driven order flow (open_position, the square-off/
-- exit-monitor scheduler jobs) - that flow has no per-user concept at all
-- (signal-generation/signal-processing aren't part of the manual-trading
-- SaaS, see docs/architecture.md's "Manual Trading SaaS" section). A
-- non-NULL user_id is one SaaS user's OWN settings (Manual tab), created
-- lazily the first time they save one via PUT /settings - mirrors
-- execution.accounts' own per-(user, segment) row shape below. Surrogate
-- UUID `id` PK (was a SMALLINT singleton, CHECK(id=1)) since there can now
-- be many rows, one per user plus the one legacy NULL row.
CREATE TABLE IF NOT EXISTS execution.settings (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID,
    timezone                TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    -- CRYPTO only, nullable - manually configured INR-per-USD rate used to
    -- convert capital_per_trade/current_balance into USD-equivalent before
    -- sizing a CRYPTO position. See docs/architecture.md.
    usdinr_rate             NUMERIC CHECK (usdinr_rate > 0),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_settings_user_id UNIQUE NULLS NOT DISTINCT (user_id)
);

INSERT INTO execution.settings (user_id) VALUES (NULL)
    ON CONFLICT ON CONSTRAINT uq_settings_user_id DO NOTHING;

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
-- leverage: CRYPTO only (Delta Exchange India trades perpetual futures on
-- margin) - a margin multiplier applied to effective_capital before sizing,
-- so the same capital affords proportionally more quantity. Defaults to 1
-- (no leverage, current behavior unchanged) and is harmlessly present but
-- unused for NSE/MCX, same "shared table, segment-scoped meaning" pattern
-- as several Strategy option_* fields. See position_manager.open_position.
-- square_off_time: the one segment-wide cutoff - any intraday position
-- (spot/future/option) still OPEN past this local time-of-day gets
-- forcefully closed by the periodic square-off job (position_manager.
-- square_off_due_positions/option_position_manager.square_off_due_option_groups).
-- Used to be a per-Strategy field (required for horizon='intraday',
-- auto-defaulted per segment) - moved here since it's genuinely a
-- market-hours concept, not a per-strategy one. NULL means "never force-
-- closed" - CRYPTO's default, since crypto trades 24/7 and 17:25 was only
-- ever a fixed business-rule guess, not a real market close. Editable via
-- PUT /accounts/{segment}, shown in AccountsPage.tsx. See
-- docs/architecture.md.
-- user_id NULL = the legacy platform-wide account for this segment (read
-- by the automated Strategy-driven flow - see execution.settings' own
-- comment on the identical NULL convention). Non-NULL = one SaaS user's
-- own paper-trading account for this segment (Manual tab), created lazily
-- with sensible defaults the first time they place a manual order or edit
-- their risk settings for that segment. Surrogate UUID `id` PK (was
-- `segment` alone) since there can now be many rows per segment, one per
-- user plus the one legacy NULL row.
CREATE TABLE IF NOT EXISTS execution.accounts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID,
    segment             TEXT NOT NULL CHECK (segment IN ('NSE', 'MCX', 'CRYPTO')),
    starting_balance    NUMERIC NOT NULL CHECK (starting_balance > 0),
    current_balance     NUMERIC NOT NULL,
    capital_per_trade   NUMERIC NOT NULL CHECK (capital_per_trade > 0),
    risk_per_trade_pct  NUMERIC NOT NULL CHECK (risk_per_trade_pct > 0 AND risk_per_trade_pct <= 100),
    -- Manual tab only (ManualTab.tsx's computeRR) - minimum reward:risk a
    -- manual order's Limit(or LTP)/Target/SL Limit must clear before the
    -- Add/Update button will place/update it. Not read by the automated
    -- Strategy-resolved order path at all. Editable via PUT
    -- /accounts/{segment}, managed from signal-generation's own Manual
    -- tab (its "Checklist & Risk Settings" sub-page) as well as
    -- execution's AccountsPage.tsx.
    min_reward_risk_ratio NUMERIC NOT NULL DEFAULT 4 CHECK (min_reward_risk_ratio > 0),
    -- Manual tab only, spot/future rows only - when true and a flat
    -- stop-loss + entry price are both known, ManualTab.tsx auto-computes
    -- the Lot field from risk_per_trade_pct/capital_per_trade (mirrors
    -- position_manager.compute_risk_based_quantity) and locks it there -
    -- the computed count is sent as an explicit quantity at order time,
    -- same as a manually typed one, so no separate server-side
    -- enforcement of this flag exists (or is needed).
    enforce_risk_based_lots BOOLEAN NOT NULL DEFAULT false,
    leverage            NUMERIC NOT NULL DEFAULT 1 CHECK (leverage > 0),
    -- NSE MTF (margin trading facility) only - the manually configured
    -- annualized interest rate charged on the borrowed portion of a
    -- leveraged NSE positional spot position (leverage > 1). NULL by
    -- default, same "not a live feed, operator-entered" convention as
    -- execution.settings.usdinr_rate - a positional NSE order that would
    -- use leverage > 1 is REJECTED rather than opened with unmodeled
    -- interest cost until this is set. See position_manager.open_position/
    -- _net_pnl_with_costs.
    mtf_annual_interest_rate_pct NUMERIC CHECK (mtf_annual_interest_rate_pct >= 0),
    square_off_time     TIME,
    -- Live-broker-adapter P0 (see docs/architecture.md) - one of TWO gates
    -- (alongside execution's own LIVE_TRADING_KILL_SWITCH env var - see
    -- app/config.py) that must BOTH pass before any real order reaches
    -- Dhan for this account. Defaults false: an account never trades real
    -- money until a person explicitly opts it in here. max_order_value/
    -- max_daily_loss are only meaningful once this is true - see
    -- position_manager's submission-gating checks.
    live_trading_enabled BOOLEAN NOT NULL DEFAULT false,
    max_order_value      NUMERIC CHECK (max_order_value > 0),
    max_daily_loss        NUMERIC CHECK (max_daily_loss > 0),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_accounts_user_segment UNIQUE NULLS NOT DISTINCT (user_id, segment)
);

-- Pre-existing volumes created before min_reward_risk_ratio/
-- enforce_risk_based_lots existed - this init script only runs on a
-- fresh volume, so live databases need the columns added explicitly
-- (same pattern this file already uses elsewhere).
ALTER TABLE execution.accounts ADD COLUMN IF NOT EXISTS min_reward_risk_ratio NUMERIC NOT NULL DEFAULT 4 CHECK (min_reward_risk_ratio > 0);
ALTER TABLE execution.accounts ADD COLUMN IF NOT EXISTS enforce_risk_based_lots BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE execution.accounts ADD COLUMN IF NOT EXISTS mtf_annual_interest_rate_pct NUMERIC CHECK (mtf_annual_interest_rate_pct >= 0);

-- Optional, purely additive per-STRATEGY capital pool - a strategy with a
-- row here sizes/tracks P&L against IT instead of its segment's shared
-- execution.accounts row; a strategy with no row here (the default, same
-- as every strategy before this table existed) keeps sharing the segment
-- account exactly as before. strategy_id has no FK (execution can't
-- reference signal_generation.strategies - systems/* are self-contained,
-- same reasoning positions.strategy_id/option_position_groups.strategy_id
-- already have). Deliberately does NOT carry leverage/square_off_time -
-- those stay market-hours/margin-model concepts scoped to the SEGMENT
-- account always, never overridden per-strategy (see execution.accounts'
-- own square_off_time comment) - app/domain/position_manager.py's
-- load_capital_account resolves this table for the money, load_account
-- for those two fields, always separately. See docs/architecture.md
-- § 'Why paper-trading accounts are per-segment, not per-strategy'.
CREATE TABLE IF NOT EXISTS execution.strategy_accounts (
    strategy_id         UUID PRIMARY KEY,
    segment             TEXT NOT NULL CHECK (segment IN ('NSE', 'MCX', 'CRYPTO')),
    starting_balance    NUMERIC NOT NULL CHECK (starting_balance > 0),
    current_balance     NUMERIC NOT NULL,
    capital_per_trade   NUMERIC NOT NULL CHECK (capital_per_trade > 0),
    risk_per_trade_pct  NUMERIC NOT NULL CHECK (risk_per_trade_pct > 0 AND risk_per_trade_pct <= 100),
    -- Live-broker-adapter P3 item 14 (see docs/architecture.md) - the
    -- automated Strategy-driven flow (open_position) has no per-user
    -- concept at all (positions.user_id stays NULL for it, same as
    -- before this existed - see that column's own comment), so there is
    -- no bearer token/tenant to attribute a REAL order to. A strategy
    -- only ever goes live by EXPLICITLY creating this override row (the
    -- shared platform-wide execution.accounts row can never go live - it
    -- structurally has no live_trading_user_id at all) and naming a real
    -- person's own user id here, whose BYO Dhan credentials
    -- (accounts.broker_credentials) then execute every real order this
    -- strategy places - see app/domain/live_broker.py's
    -- submit_entry_order_scheduled/submit_resting_stop_loss_scheduled (no
    -- user bearer token exists for this path either - a Redis consumer,
    -- not an HTTP request - so these go through market-data's internal
    -- shared-secret routes, same as the scheduler jobs). No FK (no
    -- cross-schema FK exists anywhere in this codebase - see
    -- docs/architecture.md's "systems stay self-contained" rule); this is
    -- also cross-SYSTEM (accounts.users), which could never be an FK
    -- regardless.
    live_trading_user_id UUID,
    live_trading_enabled BOOLEAN NOT NULL DEFAULT false,
    max_order_value      NUMERIC CHECK (max_order_value > 0),
    max_daily_loss        NUMERIC CHECK (max_daily_loss > 0),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT strategy_accounts_live_requires_user CHECK (NOT live_trading_enabled OR live_trading_user_id IS NOT NULL)
);

-- The 3 legacy platform-wide accounts (user_id NULL) - unchanged values,
-- still what the automated Strategy-driven flow sizes/credits against.
INSERT INTO execution.accounts (user_id, segment, starting_balance, current_balance, capital_per_trade, risk_per_trade_pct, square_off_time)
VALUES
    (NULL, 'NSE', 200000, 200000, 50000, 1.0, '15:00:00'),
    (NULL, 'MCX', 200000, 200000, 50000, 1.0, '22:00:00'),
    (NULL, 'CRYPTO', 200000, 200000, 50000, 1.0, NULL)
ON CONFLICT ON CONSTRAINT uq_accounts_user_segment DO NOTHING;

-- One row per paper position, one row per resolved signal regardless of
-- outcome (OPEN/CLOSED/REJECTED) - horizon/instrument_type are carried
-- through from the resolved order for visibility, not re-derived here.
-- quantity is nullable: a REJECTED row was never sized (computed from
-- capital_per_trade / entry_price only once a position is actually opened).
CREATE TABLE IF NOT EXISTS execution.positions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL = opened by the automated Strategy-driven flow (same NULL
    -- convention as execution.settings/accounts above - no FK to
    -- accounts.users, systems/* stay self-contained). Non-NULL = a SaaS
    -- user's own manually-placed trade (always paired with strategy_id
    -- IS NULL below, same as before this column existed). See
    -- docs/architecture.md's "Manual Trading SaaS" section.
    user_id          UUID,
    signal_id        UUID NOT NULL,
    -- Nullable: NULL means manually opened (Manual tab), bypassing
    -- signal-generation/signal-processing entirely - no FK exists to
    -- signal_generation.strategies (no cross-schema FK, see
    -- docs/architecture.md), so this is a pure nullability relaxation.
    strategy_id      UUID,
    symbol           TEXT NOT NULL,
    exchange         TEXT NOT NULL,
    -- Which execution.accounts row this position was sized against and
    -- (once closed) credited/debited on - copied from the resolved order
    -- at open time, same pattern as stop_loss_method etc. below. No FK to
    -- accounts (segment) any more - accounts.segment alone stopped being
    -- unique once user_id was added there (multiple rows can share a
    -- segment, one per user); the application already only ever writes a
    -- valid segment value, so this is a plain CHECK instead of a DB-level
    -- FK guarantee.
    segment          TEXT NOT NULL CHECK (segment IN ('NSE', 'MCX', 'CRYPTO')),
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
    -- Live-broker-adapter P1 (see docs/architecture.md) - stamped true at
    -- open time if this position's entry actually cleared through a real
    -- broker_orders row (Dhan TRADED), never re-derived from the
    -- account's own live_trading_enabled (which can change after this
    -- position opened) - a real position must always close through the
    -- same real path it opened through, see app/domain/live_broker.py and
    -- square_off_position's own comment.
    is_live_broker_order BOOLEAN NOT NULL DEFAULT false,
    -- Live-broker-adapter P3 item 14 - the specific person whose BYO Dhan
    -- credentials actually execute this position's real broker orders,
    -- ONLY set when is_live_broker_order is true. Deliberately independent
    -- of user_id above: user_id follows the existing SaaS-tenancy
    -- convention (NULL for every Strategy-driven position, live or not -
    -- see that column's own comment), while this is always the real
    -- credential owner regardless of path - a manual live position sets
    -- both to the same value (the requesting user IS the credential
    -- owner); an automated live position sets user_id=NULL but this to
    -- execution.strategy_accounts.live_trading_user_id. Every scheduled/
    -- internal-route real-order call (trailing Modify Order, reactive
    -- exit, real square-off) reads THIS column, never user_id.
    live_trading_user_id UUID,
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
    stop_loss_method        TEXT CHECK (stop_loss_method IN ('previous_candle', 'percent', 'indicator', 'breakeven')),
    stop_loss_interval      TEXT CHECK (stop_loss_interval IN ('1min', '3min', '5min', '15min', '25min', '30min', '60min')),
    stop_loss_percent       NUMERIC,
    -- stop_loss_method='indicator' only - 'ema'/'supertrend' today. MUST be
    -- widened in lockstep with signal-generation's own identical CHECK
    -- constraint (infra/postgres/init/03-signal-generation.sql) and both
    -- systems' _STOP_LOSS_*_FUNCS/_MODELS registries whenever a new
    -- indicator type is added.
    stop_loss_indicator_type   TEXT CHECK (stop_loss_indicator_type IN ('ema', 'supertrend')),
    stop_loss_indicator_params JSONB,
    -- stop_loss_method='breakeven' only - has this position's stop already
    -- snapped to entry_price and frozen there? False for every other
    -- method (never read or written for them) - see position_manager.py's
    -- _evaluate_exits, added 2026-08-29.
    breakeven_triggered     BOOLEAN NOT NULL DEFAULT false,
    exit_reason             TEXT CHECK (exit_reason IN ('square_off', 'stop_loss', 'target', 'manual', 'counter_signal', 'liquidation')),
    -- This position's segment's own square-off time (execution.accounts.
    -- square_off_time) - copied at open time, never changed afterward.
    -- NULL means never force-closed (e.g. CRYPTO) - not a "not yet
    -- reached this far" marker like it is for REJECTED rows, which also
    -- leave it NULL. See position_manager.open_position.
    square_off_time  TIME,
    -- Delta Exchange fee/liquidation simulation (app/domain/delta_fees.py) -
    -- CRYPTO + instrument_type='future' only, NULL for every other position
    -- (NSE/MCX, or a CRYPTO option, which never carries liquidation risk in
    -- this platform - see that module's own docstring). open_fee/close_fee
    -- are real cash outflows debited from the account at open/close time and
    -- netted into pnl (Rule F); margin_posted/liquidation_price are computed
    -- once at open time from the account's leverage at that moment and never
    -- recomputed later, same "frozen at open" convention square_off_time
    -- above already uses. exit_reason='liquidation' means the exit-monitor
    -- force-closed this position because CMP crossed liquidation_price -
    -- pnl in that case is -(margin_posted) - a liquidation_fee (recorded as
    -- close_fee, replacing the normal close fee entirely), not the raw
    -- price-distance loss.
    open_fee          NUMERIC,
    close_fee         NUMERIC,
    -- Also reused (not CRYPTO-only) for an NSE MTF positional spot position
    -- opened with leverage > 1 - same meaning either way: the trader's own
    -- capital actually posted (= notional / leverage), frozen at open.
    margin_posted     NUMERIC,
    liquidation_price NUMERIC,
    -- NSE MTF only - the account's mtf_annual_interest_rate_pct AT OPEN
    -- TIME, frozen here (not re-read from the account at close) so a later
    -- rate change never retroactively changes an already-open position's
    -- own economics - same "frozen at open" convention as everything else
    -- on this row. interest_charged is the final rupee amount, computed
    -- once at close from this rate + margin_posted + days held (see
    -- position_manager._net_pnl_with_costs) and netted into pnl, same
    -- point-in-time convention as close_fee above (not accrued daily).
    -- Both NULL for every non-leveraged-NSE position.
    mtf_interest_rate_pct NUMERIC,
    interest_charged  NUMERIC,
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
    -- NULL = the automated Strategy-driven flow, non-NULL = a SaaS user's
    -- own manual option order - same convention as positions.user_id above.
    user_id                  UUID,
    signal_id                UUID NOT NULL UNIQUE,
    -- NULL = manually opened (Manual tab, no auto-provisioned Strategy as
    -- of 2026-08-14) - same nullability/meaning as positions.strategy_id
    -- above.
    strategy_id              UUID,
    underlying_symbol        TEXT NOT NULL,  -- the resolved order's own symbol (e.g. "NIFTY") - NOT either leg's own symbol
    exchange                 TEXT NOT NULL,
    -- No FK to accounts (segment) any more - see positions.segment's own
    -- comment on why (accounts.segment alone stopped being unique once
    -- user_id was added there).
    segment                  TEXT NOT NULL CHECK (segment IN ('NSE', 'MCX', 'CRYPTO')),
    strategy_type            TEXT NOT NULL,  -- e.g. "bull_call_spread" - order.strategy['type']
    action                   TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),  -- the original signal direction, not either leg's own action
    horizon                  TEXT NOT NULL,
    quantity                 NUMERIC,  -- lots*lot_size, same units as positions.quantity - NULL if REJECTED
    net_debit                NUMERIC,  -- combined entry premium (long leg - short leg), per unit
    combined_stop_loss_price NUMERIC,
    combined_target_price    NUMERIC,
    -- 'combined' (default): combined_stop_loss_price/combined_target_price
    -- above are what's monitored. 'individual': each leg's own
    -- positions.stop_loss_price/target_price is monitored instead (either
    -- leg tripping still closes the whole group) - combined_stop_loss_price/
    -- combined_target_price stay NULL in this mode. See
    -- docs/contracts/resolved-order.schema.json's option_sl_scope.
    sl_scope                 TEXT NOT NULL DEFAULT 'combined' CHECK (sl_scope IN ('combined', 'individual')),
    -- The underlying's own LTP at open (best-effort - NULL if that quote
    -- failed even though both legs priced fine, non-fatal). Lets
    -- spot_stop_loss_price below be set/displayed as a % move from entry,
    -- same convention positions.stop_loss_percent uses for spot/future.
    entry_spot_price          NUMERIC,
    -- A stop expressed on the UNDERLYING's own price, not the combined
    -- premium - independent of sl_scope/combined_stop_loss_price above and
    -- checked separately (whichever trips first closes the group) - see
    -- option_position_manager.py's _evaluate_option_group_exits. NULL
    -- (default) means no spot-based stop is armed. Either user-set (PUT
    -- /option-groups/{id}/stop-loss, checked against the underlying's own
    -- spot LTP - the original design) OR, when stop_loss_future_symbol
    -- below is set, auto-computed from the Strategy's own
    -- stop_loss_method='indicator' (added 2026-08-21, SuperTrend only
    -- today) and checked against THAT future's LTP instead - an option
    -- premium is too noisy/decaying a series to run an indicator against
    -- directly, so the level is derived from the underlying's own nearest
    -- future contract, same instrument the crossover rule itself may
    -- already be reading.
    spot_stop_loss_price      NUMERIC,
    -- Trailing-stop bookkeeping for the auto-computed case above - mirrors
    -- positions.trailing_stop_enabled/stop_loss_indicator_type/
    -- stop_loss_indicator_params (copied from the Strategy at open time),
    -- but deliberately prefixed spot_stop_loss_ rather than reusing those
    -- column names - this is ONE of three independent stop mechanisms a
    -- group can carry (combined/individual premium-based, and this
    -- spot/future-based one), not the group's only stop-loss config the
    -- way it is for a plain Position row. All four stay NULL/false
    -- together for a user-set (PUT-only) spot_stop_loss_price, or for a
    -- group with no spot-based stop at all.
    spot_stop_loss_trailing_enabled BOOLEAN NOT NULL DEFAULT false,
    -- 'supertrend' only today - MUST be widened in lockstep with
    -- positions.stop_loss_indicator_type's own identical CHECK constraint
    -- and both systems' _STOP_LOSS_*_FUNCS/_MODELS registries whenever a
    -- second indicator type is supported here.
    spot_stop_loss_indicator_type   TEXT CHECK (spot_stop_loss_indicator_type IN ('supertrend')),
    spot_stop_loss_indicator_params JSONB,
    spot_stop_loss_interval         TEXT CHECK (spot_stop_loss_interval IN ('1min', '3min', '5min', '15min', '25min', '30min', '60min')),
    -- The underlying's own nearest-expiry future contract (market-data's
    -- resolve_underlying trade_symbol/trade_exchange) - set once, at open
    -- time, alongside the auto-computed spot_stop_loss_price above; NULL
    -- for a user-set (PUT-only) spot_stop_loss_price, which stays checked
    -- against the underlying's own spot LTP as before. Re-resolving this
    -- on every tick (rather than caching it here) would risk the trailing
    -- job silently switching contracts mid-trade around an expiry
    -- rollover - pinned once instead, same as a position's own entry
    -- price never moving.
    stop_loss_future_symbol   TEXT,
    stop_loss_future_exchange TEXT,
    -- Delta Exchange trading-fee simulation (app/domain/delta_fees.py) -
    -- CRYPTO only, NULL for NSE/MCX groups. Combined across both legs
    -- (compute_option_trading_fee per leg, summed) - real cash outflows
    -- debited from the account at open/close time and netted into the
    -- group's combined pnl (Rule F), same convention positions.open_fee/
    -- close_fee use. No liquidation columns here at all - CRYPTO options
    -- never carry liquidation risk in this platform, see that module's
    -- own docstring.
    open_fee  NUMERIC,
    close_fee NUMERIC,
    status                   TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'REJECTED')),
    rejection_reason         TEXT,
    exit_reason              TEXT CHECK (exit_reason IN ('square_off', 'combined_stop_loss', 'combined_target', 'individual_stop_loss', 'individual_target', 'spot_stop_loss', 'manual', 'counter_signal')),
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

-- Per-position/group unrealized-P&L time series, added 2026-08-21 - lets
-- the frontend chart how a trade's P&L actually moved while it was open,
-- not just its entry/exit endpoints. Recorded piggybacking on the
-- exit-monitor's own 30s tick (position_manager.record_position_pnl_
-- snapshots / option_position_manager.record_option_group_pnl_snapshots,
-- called from app/scheduler.py's run_check_exits) against EVERY OPEN
-- position/group, not just the stop-loss/target/liquidation-having subset
-- check_exits/check_option_group_exits themselves scope to - a separate
-- query + separate quote fetch each tick, reusing the already-existing
-- compute_unrealized_pnl/compute_group_unrealized_pnl pure functions
-- (previously read-only, used by GET /positions?with_live_pnl=true).
-- Two separate tables, not one polymorphic one - mirrors how positions/
-- option_position_groups above already duplicate structure rather than
-- sharing it. ON DELETE CASCADE so the existing "Clear positions" button
-- (which already deletes positions/option_position_groups rows) wipes
-- snapshot history for free, no code change needed there. A position
-- naturally stops accumulating rows the moment it's no longer OPEN (the
-- recording query excludes it) - no pruning/retention policy yet, a
-- known future scaling consideration for a very long-lived positional
-- trade (~120 rows/hour), not solved in this pass.
CREATE TABLE IF NOT EXISTS execution.position_pnl_snapshots (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    position_id    UUID NOT NULL REFERENCES execution.positions (id) ON DELETE CASCADE,
    cmp            NUMERIC NOT NULL,
    unrealized_pnl NUMERIC NOT NULL,
    recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_position_pnl_snapshots_position_id ON execution.position_pnl_snapshots (position_id, recorded_at);

CREATE TABLE IF NOT EXISTS execution.option_group_pnl_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    option_group_id UUID NOT NULL REFERENCES execution.option_position_groups (id) ON DELETE CASCADE,
    combined_price  NUMERIC NOT NULL,
    unrealized_pnl  NUMERIC NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_option_group_pnl_snapshots_group_id ON execution.option_group_pnl_snapshots (option_group_id, recorded_at);

-- Trade discipline checklist (Manual tab only, added 2026-08-25) - an
-- editable list of checklist items (add/remove/edit/reorder via
-- GET/POST/PUT/DELETE /checklist-items), split by `phase` into 'plan'
-- (rendered as checkboxes on every ManualTab.tsx row, before its own
-- "Add" button is enabled - every one must be checked) and 'review'
-- (rendered as checkboxes in the post-trade review banner once a manual
-- trade closes - self-assessed, NOT required to all be checked, since an
-- unchecked one IS the useful signal: "I didn't actually do this").
-- Split 2026-08-25 - the original single 'plan' list mixed items only
-- confirmable in hindsight (did I actually avoid adjusting size mid-
-- trade? did I actually follow my exit plan?) in with genuine pre-trade
-- gates; those moved to 'review', plus one new 'review' item resurrecting
-- the source rulebook's "In Progress: check new OB and Swing" step, which
-- fits neither checkpoint as a pre-trade gate. Deliberately NOT referenced
-- by id from positions/option_position_groups below - plan_checklist/
-- review_checklist there are full {label, checked} SNAPSHOTS taken at
-- order/review time, so editing or deleting an item here later never
-- rewrites a past trade's own record.
-- `segments`: which segment(s) (NSE/MCX/CRYPTO) this item applies to -
-- empty array (default) means all segments. ManualTab.tsx filters an
-- item out of a given row/day-checklist's rendering unless `segments` is
-- empty or contains that row's own segment - e.g. OI change is NSE-only
-- (no OI data for MCX/CRYPTO on this platform's providers). `phase='day'`
-- (added 2026-08-25, alongside `segments`): a THIRD checklist checkpoint,
-- for facts that hold for the whole trading day rather than one trade -
-- e.g. "no major news today" doesn't need re-confirming on every single
-- order. Answered once per (day, segment) via GET/PUT /daily-checklist
-- (execution.daily_checklist_log below), not per position/group - see
-- that table's own comment.
-- user_id NULL = the platform default template (seeded below at install
-- time, before any user exists to own it) - never edited/returned to a
-- SaaS user directly. A signed-in user gets their OWN editable copy
-- (user_id = their id), cloned from the NULL template the first time
-- GET /checklist-items returns empty for them (app/domain/position_manager.py
-- - mirrors execution.accounts' own "seeded lazily on first use" pattern).
-- See docs/architecture.md's "Manual Trading SaaS" section.
CREATE TABLE IF NOT EXISTS execution.checklist_items (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID,
    label       TEXT NOT NULL,
    phase       TEXT NOT NULL DEFAULT 'plan',
    segments    TEXT[] NOT NULL DEFAULT '{}',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill for a volume that already had this table from before the
-- `phase`/`segments` additions (2026-08-25) - safe no-op on a fresh
-- install (the column defaults above already cover it).
ALTER TABLE execution.checklist_items ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'plan';
ALTER TABLE execution.checklist_items ADD COLUMN IF NOT EXISTS segments TEXT[] NOT NULL DEFAULT '{}';

-- Seed rows, guarded rather than ON CONFLICT (no natural unique key on
-- label - the user can freely rename/duplicate items afterward) - only
-- fires the very first time this table is empty, so it's safe to re-run
-- this whole script against an existing volume that's already had items
-- added/edited/removed since.
INSERT INTO execution.checklist_items (label, phase, segments, sort_order)
SELECT * FROM (VALUES
    ('Price has reached the POI - not chasing', 'plan', ARRAY[]::TEXT[], 30),
    ('Positive candle pattern / pullback confirmed at POI', 'plan', ARRAY[]::TEXT[], 40),
    ('OI change checked, consistent with direction', 'plan', ARRAY['NSE'], 50),
    ('Entry only at planned price, in trend direction - not random', 'plan', ARRAY[]::TEXT[], 60),
    ('Capital for this trade fixed in advance', 'plan', ARRAY[]::TEXT[], 70),
    ('Risk <=1% of capital', 'plan', ARRAY[]::TEXT[], 80),
    ('Min reward:risk >=1:4', 'plan', ARRAY[]::TEXT[], 90),
    ('Position size stayed per plan - not adjusted mid-trade', 'review', ARRAY[]::TEXT[], 10),
    ('Monitored for new Order Block / swing structure while open', 'review', ARRAY[]::TEXT[], 20),
    ('Followed exit plan - partial booking + trailed SL to cost-to-cost / prior swing', 'review', ARRAY[]::TEXT[], 30),
    ('POI marked (Order Block / Swing High-Low)', 'day', ARRAY[]::TEXT[], 5),
    ('High-volatility NSE session, no major news/events today (results, RBI policy, etc.)', 'day', ARRAY['NSE'], 10),
    ('High-volatility MCX session, no major commodity news today (crude inventory, geopolitical/global cues)', 'day', ARRAY['MCX'], 20),
    ('No major crypto news or headlines today (regulatory, macro, exchange outages) - crypto trades 24/7, so this checks news risk rather than a session window', 'day', ARRAY['CRYPTO'], 30)
) AS seed(label, phase, segments, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM execution.checklist_items WHERE user_id IS NULL);

-- One-time data fixes for a volume seeded before the 2026-08-25 changes
-- above - each matched by the OLD label/phase, so it only ever fires
-- once per volume (a no-op once already applied) and never touches an
-- item the user has since edited/removed themselves.
--
-- Phase split (same day as the original checklist ship): moves the 2
-- items whose real meaning is "did I actually do this" (only answerable
-- in hindsight) from 'plan' to 'review', with reworded past-tense
-- labels, and adds the 1 new 'review' item ('In Progress' from the
-- source rulebook, previously dropped entirely).
UPDATE execution.checklist_items
   SET phase = 'review', label = 'Position size stayed per plan - not adjusted mid-trade', sort_order = 10
 WHERE label = 'Position size per risk plan, not adjusted on the fly';

UPDATE execution.checklist_items
   SET phase = 'review', label = 'Followed exit plan - partial booking + trailed SL to cost-to-cost / prior swing', sort_order = 30
 WHERE label = 'Exit plan set: partial booking + trail SL to cost-to-cost / prior swing';

INSERT INTO execution.checklist_items (label, phase, segments, sort_order)
SELECT 'Monitored for new Order Block / swing structure while open', 'review', ARRAY[]::TEXT[], 20
WHERE EXISTS (SELECT 1 FROM execution.checklist_items WHERE label = 'POI marked (Order Block / Swing High-Low)')
  AND NOT EXISTS (SELECT 1 FROM execution.checklist_items WHERE label = 'Monitored for new Order Block / swing structure while open');

-- Day-level split (2026-08-25): "no major news today" moves from a
-- per-trade 'plan' checkbox (re-confirmed on every single order) to a
-- once-per-day 'day' one; the OI item becomes NSE-only (no OI data on
-- this platform's providers for MCX/CRYPTO).
UPDATE execution.checklist_items
   SET phase = 'day', sort_order = 10
 WHERE label = 'High-volatility session, no major news today' AND phase = 'plan';

UPDATE execution.checklist_items
   SET segments = ARRAY['NSE']
 WHERE label = 'OI change checked, consistent with direction' AND segments = '{}';

-- Day-level segment split (2026-08-25, second pass): one shared
-- "high-volatility, no major news" item doesn't really fit MCX
-- (commodity-specific news drivers - crude inventory, geopolitical/
-- global cues, not NSE-style results/RBI policy) or CRYPTO (trades
-- 24/7, no real "session" concept - news risk is framed differently) -
-- split into 3 segment-specific items with their own wording.
-- Repurposes the existing single item into the NSE-specific one
-- (checklist_items rows are never referenced by id from past trades'
-- own {label, checked} snapshots - see that column's own comment - so
-- renaming/rescoping it in place is safe) rather than deleting and
-- re-inserting; each guarded by exact-label NOT EXISTS, so this only
-- ever fires once per volume.
UPDATE execution.checklist_items
   SET label = 'High-volatility NSE session, no major news/events today (results, RBI policy, etc.)',
       segments = ARRAY['NSE'], sort_order = 10
 WHERE label = 'High-volatility session, no major news today' AND phase = 'day';

INSERT INTO execution.checklist_items (label, phase, segments, sort_order)
SELECT 'High-volatility MCX session, no major commodity news today (crude inventory, geopolitical/global cues)', 'day', ARRAY['MCX'], 20
WHERE NOT EXISTS (
    SELECT 1 FROM execution.checklist_items
     WHERE label = 'High-volatility MCX session, no major commodity news today (crude inventory, geopolitical/global cues)'
);

INSERT INTO execution.checklist_items (label, phase, segments, sort_order)
SELECT 'No major crypto news or headlines today (regulatory, macro, exchange outages) - crypto trades 24/7, so this checks news risk rather than a session window', 'day', ARRAY['CRYPTO'], 30
WHERE NOT EXISTS (
    SELECT 1 FROM execution.checklist_items
     WHERE label = 'No major crypto news or headlines today (regulatory, macro, exchange outages) - crypto trades 24/7, so this checks news risk rather than a session window'
);

-- 'POI marked' moves from a per-trade 'plan' checkbox to 'day' (2026-08-25,
-- third pass) - key levels are typically drawn once during pre-market
-- prep and hold for every trade that day, not re-marked per order.
-- All segments (unscoped, unlike the news items above) - the same
-- levels-drawn-once-a-day reasoning applies regardless of segment.
UPDATE execution.checklist_items
   SET phase = 'day', segments = ARRAY[]::TEXT[], sort_order = 5
 WHERE label = 'POI marked (Order Block / Swing High-Low)' AND phase = 'plan';

-- One submission per (calendar day, segment) - "today" is computed
-- server-side from execution.settings.timezone (position_manager.
-- _today_in_tz), same timezone the intraday-window/square-off logic
-- already uses, NOT the browser's own local date. `answers` is a
-- {label, checked}[] snapshot of the currently-active 'day'-phase
-- checklist_items rows SCOPED TO `segment` at submission time (same
-- snapshot-not-reference convention as positions.plan_checklist).
-- `notes`: ONE free-text observation for the whole (day, segment)
-- submission, not per item (e.g. what today's overall news/session call
-- was actually based on) - this table's one difference from
-- plan_checklist/review_checklist, which carry no notes at all.
-- position_manager.find_missing_daily_checklist blocks POST /positions/
-- manual and POST /option-groups/manual (409) for a given segment until
-- a row exists here for (today, that segment) - existence only, NOT
-- requiring every answer be checked=true (same "record honestly, don't
-- gate on the actual values" reasoning as review_checklist) - a segment
-- with zero active 'day'-phase items scoped to it has nothing to submit
-- and is never blocked. PUT /daily-checklist upserts (ON CONFLICT DO
-- UPDATE) - answered once, editable the rest of that same day, not an
-- immutable journal entry.
-- Purely a Manual tab/SaaS-user concept (no automated-flow use at all,
-- unlike positions/accounts/settings above) - user_id is a genuine
-- required part of the identity, not nullable.
CREATE TABLE IF NOT EXISTS execution.daily_checklist_log (
    user_id      UUID NOT NULL,
    log_date     DATE NOT NULL,
    segment      TEXT NOT NULL CHECK (segment IN ('NSE', 'MCX', 'CRYPTO')),
    answers      JSONB NOT NULL,
    notes        TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, log_date, segment)
);

-- Backfill for a volume that already had this table before `notes`
-- moved from per-item (inside `answers`) to this one segment-level
-- column (2026-08-25, fourth pass) - safe no-op on a fresh install.
-- Deliberately doesn't try to migrate any already-submitted per-item
-- notes out of `answers` into this column - those stay wherever they
-- were as part of that day's own frozen snapshot, same "past records
-- aren't rewritten" convention plan_checklist/review_checklist already
-- follow.
ALTER TABLE execution.daily_checklist_log ADD COLUMN IF NOT EXISTS notes TEXT;

-- One row per trading SESSION INSTANCE - an explicit "I'm actively
-- trading now"/"done for today" bookend, separate from the discipline
-- checklist above (a different concept - see app/adapters/db/models.py's
-- own TradingSession docstring for why this isn't just two more columns
-- on daily_checklist_log). A (log_date, segment) can have MULTIPLE rows
-- - e.g. checked in, broke for lunch (checked out), checked in again -
-- `checked_out_at IS NULL` marks whichever one is currently open.
-- log_date is server-computed "today" via the same
-- _today_in_tz(execution.settings.timezone) every other day-scoped table
-- already uses. POST /trading-sessions/check-in refuses to open a second
-- session while one's already open for that (log_date, segment); POST
-- .../check-out always targets the currently-open one. Added 2026-08-26,
-- reworked from a one-row-per-day (log_date, segment) PK the same day
-- once one-check-in-per-day turned out to be too restrictive (a real
-- trading day has breaks), to let ManualStatsPage.tsx's Performance page
-- correlate a day's actual session time against its PnL, not just infer
-- a window from whenever trades happened to fill.
-- Purely a Manual tab/SaaS-user concept, same as daily_checklist_log above.
CREATE TABLE IF NOT EXISTS execution.trading_sessions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL,
    log_date       DATE NOT NULL,
    segment        TEXT NOT NULL CHECK (segment IN ('NSE', 'MCX', 'CRYPTO')),
    checked_in_at  TIMESTAMPTZ NOT NULL,
    checked_out_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trading_sessions_user_day_segment ON execution.trading_sessions (user_id, log_date, segment);

-- plan_checklist/review_checklist: the {label, checked}[] snapshots
-- described above, taken at order-placement time and review-submission
-- time respectively - NULL for every pre-existing row and for any
-- non-manual (Strategy-driven) position/group, which never goes through
-- the Manual tab's checklist gate at all. reviewed_at/review_violation/
-- review_notes: filled in via PUT .../review once this position/group
-- CLOSES - position_manager.find_pending_manual_review blocks every
-- future POST /positions/manual and POST /option-groups/manual (409)
-- while ANY manual (strategy_id IS NULL) position/group sits CLOSED with
-- reviewed_at IS NULL, across BOTH tables - see docs/architecture.md
-- § 'Trade discipline checklist'.
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS plan_checklist JSONB;
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS review_violation BOOLEAN;
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS review_notes TEXT;
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS review_checklist JSONB;

ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS plan_checklist JSONB;
ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS review_violation BOOLEAN;
ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS review_notes TEXT;
ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS review_checklist JSONB;

-- Screenshots/chart snapshots attached to a closed manual trade for
-- future review (Manual tab only, added 2026-08-26) - e.g. a TradingView
-- chart at entry/exit, to actually look back at rather than relying on
-- the review checklist/notes alone. Exactly one of position_id/
-- option_group_id is set (a leg row's own images would just be its
-- parent group's - never attached to a leg directly), no FK (same "no
-- cross-row FK, resolved at the API layer" convention plan_checklist's
-- own position_id/option_group_id already follow implicitly). Stored as
-- bytea directly in Postgres rather than a filesystem path - this is a
-- paper-trading practice tool, not expecting the volume of a real photo
-- library, and it keeps GET /images/{id} a single DB round-trip with no
-- separate static-file-serving/volume-mount setup. No FK to positions/
-- option_position_groups (id) either, same reasoning as everywhere else
-- in this file - a deleted trade just orphans its images rather than
-- cascading, consistent with this schema never modeling deletes.
CREATE TABLE IF NOT EXISTS execution.trade_images (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    position_id     UUID,
    option_group_id UUID,
    content_type    TEXT NOT NULL,
    image_data      BYTEA NOT NULL,
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((position_id IS NULL) <> (option_group_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_trade_images_position ON execution.trade_images (position_id) WHERE position_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trade_images_option_group ON execution.trade_images (option_group_id) WHERE option_group_id IS NOT NULL;

-- 'market' | 'limit' - which of the Manual tab's two entry modes placed
-- this trade (see ManualTab.tsx's priceMode - 'market' fires immediately
-- at a fresh live LTP, 'limit' waits for spot to cross a caller-typed
-- price). NULL for every pre-existing row and for every Strategy-driven
-- (non-manual) position/group, same nullability convention plan_checklist
-- above already follows - added 2026-08-26 so a future performance
-- review can break results down by entry style. Same "checklist/review
-- gate lives on the option GROUP row, not each leg" placement as
-- plan_checklist - NULL for every individual option leg Position too.
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS order_type TEXT CHECK (order_type IN ('market', 'limit'));
ALTER TABLE execution.option_position_groups ADD COLUMN IF NOT EXISTS order_type TEXT CHECK (order_type IN ('market', 'limit'));
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS mtf_interest_rate_pct NUMERIC;
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS interest_charged NUMERIC;

-- 'breakeven' stop-loss method (2026-08-29) - see signal-generation's own
-- identical-reasoning migration comment (03-signal-generation.sql) for why
-- an existing volume needs this ALTER even though the CREATE TABLE above
-- was also edited.
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS breakeven_triggered BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE execution.positions DROP CONSTRAINT IF EXISTS positions_stop_loss_method_check;
ALTER TABLE execution.positions ADD CONSTRAINT positions_stop_loss_method_check
    CHECK (stop_loss_method IN ('previous_candle', 'percent', 'indicator', 'breakeven'));

-- Live-broker-adapter P0 (see docs/architecture.md) - pre-existing volumes
-- need these ALTERs even though the CREATE TABLE above was also edited,
-- same pattern this file already uses everywhere else.
ALTER TABLE execution.accounts ADD COLUMN IF NOT EXISTS live_trading_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE execution.accounts ADD COLUMN IF NOT EXISTS max_order_value NUMERIC CHECK (max_order_value > 0);
ALTER TABLE execution.accounts ADD COLUMN IF NOT EXISTS max_daily_loss NUMERIC CHECK (max_daily_loss > 0);

-- One row per real order attempt (entry, exit, or a resting stop-loss) sent
-- to Dhan - NOT columns bolted onto positions, since one position can have
-- multiple broker orders across its life (entry, a resting SL that gets
-- Modify-Order'd repeatedly as it trails, and an eventual exit). See the
-- live-broker-adapter plan's own P0 item 3.
--
-- Submit-then-crash safety: a row is written with status='submitting' and
-- its client_order_id BEFORE calling Dhan's place-order API, then updated
-- after Dhan responds. This makes the crash-mid-flight case (process dies
-- between the outbound call and recording its response) resolvable instead
-- of dangerous - orders_consumer.py's at-least-once redelivery is only
-- safe today because open_position has no external side effect before its
-- own idempotency check; a real broker call does, so client_order_id (our
-- own idempotency key, threaded through as Dhan's correlationId - see
-- DhanProvider.place_order's own docstring on why that dedup isn't yet
-- confirmed to actually work Dhan-side) is what the reconciliation job
-- (app/scheduler.py) uses to match a stuck 'submitting' row against Dhan's
-- own order book (GET /dhan/order-book) rather than ever blindly retrying.
CREATE TABLE IF NOT EXISTS execution.broker_orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID,
    position_id         UUID REFERENCES execution.positions (id),
    option_group_id     UUID REFERENCES execution.option_position_groups (id),
    purpose             TEXT NOT NULL CHECK (purpose IN ('entry', 'exit', 'stop_loss')),
    -- Our own idempotency key, generated before the outbound Dhan call -
    -- unique so a redelivered/retried submission can never double-place.
    client_order_id     TEXT NOT NULL UNIQUE,
    broker_order_id     TEXT,
    status              TEXT NOT NULL DEFAULT 'submitting'
        CHECK (status IN ('submitting', 'pending', 'traded', 'rejected', 'cancelled', 'failed')),
    exchange            TEXT NOT NULL CHECK (exchange IN ('NSE', 'MCX')),
    symbol              TEXT NOT NULL,
    segment             TEXT NOT NULL CHECK (segment IN ('NSE', 'MCX')),
    action              TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
    quantity            INTEGER NOT NULL CHECK (quantity > 0),
    order_type          TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'STOP_LOSS', 'STOP_LOSS_MARKET')),
    product_type        TEXT NOT NULL CHECK (product_type IN ('CNC', 'INTRADAY', 'MARGIN', 'MTF')),
    price               NUMERIC,
    trigger_price       NUMERIC,
    filled_quantity     INTEGER NOT NULL DEFAULT 0,
    average_fill_price  NUMERIC,
    -- Dhan's raw place-order/postback response, verbatim - see
    -- OrderResponse's own docstring (market-data) on why the exact shape
    -- isn't mirrored field-by-field yet.
    raw_response        JSONB,
    failure_reason      TEXT,
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((position_id IS NULL) OR (option_group_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_broker_orders_position ON execution.broker_orders (position_id) WHERE position_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_broker_orders_option_group ON execution.broker_orders (option_group_id) WHERE option_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_broker_orders_status ON execution.broker_orders (status) WHERE status IN ('submitting', 'pending');

-- Live-broker-adapter P1 (see docs/architecture.md) - pre-existing volumes
-- need these ALTERs even though the CREATE TABLE/accounts definitions
-- above were also edited, same pattern this file already uses everywhere.
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS is_live_broker_order BOOLEAN NOT NULL DEFAULT false;

-- Live-broker-adapter P3 item 14 - see this file's own comments on
-- strategy_accounts' 4 new columns and positions.live_trading_user_id.
ALTER TABLE execution.positions ADD COLUMN IF NOT EXISTS live_trading_user_id UUID;
ALTER TABLE execution.strategy_accounts ADD COLUMN IF NOT EXISTS live_trading_user_id UUID;
ALTER TABLE execution.strategy_accounts ADD COLUMN IF NOT EXISTS live_trading_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE execution.strategy_accounts ADD COLUMN IF NOT EXISTS max_order_value NUMERIC CHECK (max_order_value > 0);
ALTER TABLE execution.strategy_accounts ADD COLUMN IF NOT EXISTS max_daily_loss NUMERIC CHECK (max_daily_loss > 0);
ALTER TABLE execution.strategy_accounts DROP CONSTRAINT IF EXISTS strategy_accounts_live_requires_user;
ALTER TABLE execution.strategy_accounts ADD CONSTRAINT strategy_accounts_live_requires_user
    CHECK (NOT live_trading_enabled OR live_trading_user_id IS NOT NULL);
