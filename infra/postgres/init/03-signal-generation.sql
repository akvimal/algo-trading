-- Runs automatically on first container start (docker-entrypoint-initdb.d).

CREATE SCHEMA IF NOT EXISTS signal_generation;

-- A Rule is a saved, reusable, independently-backtestable definition of
-- *when a signal should fire* - separated out from Strategy (below), which
-- only decides what happens once it does (instrument/segment to trade,
-- stop-loss/target, option shape, conflict policies). One Rule can back
-- many Strategies (e.g. the same crossover backing both a spot Strategy
-- and an option-spread Strategy on the same underlying) - see
-- docs/architecture.md's "Rules module" section.
--
-- Purely an in-house condition definition - a Rule is always evaluated by
-- this system's own engine. An external (webhook) Strategy carries its
-- own source_type directly and references no Rule at all (rule_id is
-- NULL for it - see strategies.rule_id below); the provider decides when
-- a signal fires, not this system.
CREATE TABLE IF NOT EXISTS signal_generation.rules (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name               TEXT NOT NULL,
    description        TEXT,
    -- Which market this rule's condition/universe is evaluated against -
    -- distinct from a linked Strategy's own `segment` (what gets traded
    -- when it fires - see strategies.segment below). Only NSE is actually
    -- exercised today; MCX/CRYPTO recorded as intent, same convention
    -- strategies.segment already uses.
    segment            TEXT NOT NULL DEFAULT 'NSE' CHECK (segment IN ('NSE', 'MCX', 'CRYPTO')),
    -- The logical underlying to watch (e.g. "GOLDM", "NIFTY") and a typed
    -- JSON rule config (CrossoverRuleConfig - {"type": "crossover",
    -- "indicator_id": ...} - or BreakoutRuleConfig/RangeBreakoutRuleConfig).
    -- Names WHICH indicator (signal_generation.indicators below) and HOW
    -- to decide from it - deliberately NOT the indicator's own params
    -- (period etc.), which live on the referenced Indicator row instead,
    -- so one indicator definition can be reused by many rules. JSONB (not
    -- dedicated columns) so a second rule type is new code, not a
    -- migration.
    underlying         TEXT NOT NULL,
    -- 'symbol' (default): underlying names one traded symbol. 'universe':
    -- underlying instead names an index-constituent group key (e.g.
    -- 'NIFTYBANK', resolved via market-data's GET
    -- /instruments/universe/constituents) - the engine evaluates this
    -- rule against every constituent independently. Universes are NSE
    -- cash-equity index membership lists only - see universe_requires_nse
    -- below. Not coupled to instrument_type (that's a Strategy concern
    -- now) - a universe scan can back a spot, future, or option Strategy.
    -- 'symbol_list': underlying instead holds a comma-separated list of
    -- explicit symbols (e.g. "GOLDM,SILVER,CRUDEOIL") - for segments like
    -- MCX with no index/universe concept, a rule can still scan a
    -- hand-picked set of symbols. Fully local (never calls market-data),
    -- so unlike 'universe' it works on any segment. 'watchlist': underlying
    -- instead names a signal_generation.watchlists row (below) by its
    -- unique name - a user-managed, reusable symbol group, unlike
    -- 'symbol_list' (baked into this one rule, not shared) and unlike
    -- 'universe' (fixed to whatever market-data's index API exposes).
    -- Segment-agnostic like 'symbol_list' - no NSE restriction.
    underlying_type    TEXT NOT NULL DEFAULT 'symbol' CHECK (underlying_type IN ('symbol', 'universe', 'symbol_list', 'watchlist')),
    -- Signal/candle cadence.
    interval           TEXT NOT NULL CHECK (interval IN ('1min', '3min', '5min', '15min', '30min', '60min', 'daily')),
    rule_config        JSONB NOT NULL,
    -- Which regime-type Indicators (signal_generation.indicators below,
    -- type IN ('structure', 'efficiency_ratio', 'adx', 'dmi_direction',
    -- 'ema_slope')) must ALL confirm this rule's own bias before it
    -- fires - a JSONB array of indicator id strings, no DB FK (same
    -- reason rule_config's own indicator_id has none - see above);
    -- existence + regime-typedness is checked at the API layer instead
    -- (app/api/routes/rules.py). Empty (default) means no regime gate.
    -- Applies uniformly across all 3 rule_config types (crossover,
    -- breakout, range_breakout) - it's a cross-cutting modifier, not
    -- specific to any one condition type, so it lives here at the top
    -- level rather than nested inside rule_config.
    regime_indicator_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT universe_requires_nse CHECK (
        underlying_type != 'universe' OR segment = 'NSE'
    )
);

-- A named, reusable, user-managed group of symbols - referenced by name from
-- a Rule's own `underlying` when underlying_type='watchlist' (see the CHECK
-- constraint above), exactly how 'universe' references a fixed NSE index
-- key, except this group is created/edited by the user rather than fixed to
-- whatever market-data's index API exposes. No FK from rules to this table -
-- a Rule referencing a since-deleted/renamed watchlist name degrades
-- exactly like an unresolvable 'universe' key already does (logged and
-- skipped for that tick, 502 on backtest), same precedent, no new guard
-- code. `name` is effectively immutable in practice: PUT /watchlists/{id}
-- only ever updates `symbols`, never `name`, so no Rule reference can ever
-- be silently orphaned by a rename.
CREATE TABLE IF NOT EXISTS signal_generation.watchlists (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    -- Comma-separated, same raw-string shape/parsing as rules.underlying for
    -- underlying_type='symbol_list' (parse_symbol_list, app/domain/rule.py) -
    -- reuses that exact helper rather than a JSONB-array parallel path.
    symbols     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A reusable indicator definition (e.g. "RSI 14", "ADX 14/20") - any
-- number of Rule rows can reference one, either via rule_config's
-- indicator_id ("rsi" only - crossover) or via the top-level
-- regime_indicator_ids above (the other 6, regime types) - no DB FK
-- either way (existence + type-compatibility is checked at the API layer
-- instead, see app/api/routes/rules.py). params is JSONB (not dedicated
-- columns) so a new indicator type is new code, not a migration - but
-- THIS constraint still must be widened in lockstep with any new
-- IndicatorType, or creation 500s (this was once left behind - see
-- app/domain/rule.py's own comment).
CREATE TABLE IF NOT EXISTS signal_generation.indicators (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('rsi', 'structure', 'efficiency_ratio', 'adx', 'dmi_direction', 'ema_slope', 'supertrend')),
    params      JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A Strategy is the unit of configuration for a signal source - either an
-- external webhook provider (chartink, tradingview) or an in-house
-- engine, via whichever Rule it points to (rule_id below) - see
-- docs/architecture.md. Its id doubles as the ?strategy_id= value given
-- to the provider (or generated internally), and its horizon/
-- instrument_type are what signal-processing resolves a signal to.
--
-- Deliberately no quantity/capital column here - position sizing math
-- (the capital cap, risk %) is still execution's job
-- (execution.settings.capital_per_trade/risk_per_trade_pct). Stop-loss and
-- target ARE here though: unlike a flat capital figure, stop distance
-- genuinely varies by strategy/scan/timeframe, so the *method* belongs
-- with what produces the signal - execution just consumes the resulting
-- stop_loss_price/target_price (passed through resolved-order) to size
-- and monitor the position. See docs/architecture.md.
--
-- New strategies start as 'draft' regardless of source_type: creating one
-- and getting webhook URLs does not start trading - you flip it to 'live'
-- explicitly once you've verified the provider is wired up correctly.
CREATE TABLE IF NOT EXISTS signal_generation.strategies (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             TEXT NOT NULL,
    -- 'in_house' is the one reserved value everything else compares
    -- against (see every backend source_type check) - anything else names
    -- an external webhook provider (chartink, tradingview, or any new
    -- one), free-form so a new provider needs no schema/code change here.
    source_type      TEXT NOT NULL CHECK (source_type <> ''),
    exchange         TEXT NOT NULL CHECK (exchange IN ('NSE')),
    horizon          TEXT NOT NULL CHECK (horizon IN ('intraday', 'positional')),
    instrument_type  TEXT NOT NULL CHECK (instrument_type IN ('spot', 'future', 'option')),
    -- Which saved Rule (above) decides when this strategy's signals fire -
    -- in_house only (NULL for an external strategy - it carries no
    -- evaluable condition, the provider decides when a signal fires). Not
    -- ON DELETE CASCADE: a Rule with strategies still pointing at it
    -- shouldn't silently vanish - see app/api/routes/rules.py's delete
    -- guard.
    rule_id          UUID REFERENCES signal_generation.rules (id),
    -- Whoever was logged in (systems/accounts) when this Strategy was
    -- created - no FK (cross-system, accounts owns its own users table,
    -- see the systems/* self-containment rule). NULL for one created with
    -- no bearer token at all (e.g. make test-signal's throwaway strategy,
    -- or any pre-existing Strategy from before this column existed).
    -- Captured once at creation time, never changed afterward. Threaded
    -- through to execution as resolved-order's own owner_user_id so a
    -- Strategy-driven position can size against and be attributed to ITS
    -- OWN creator's account instead of always the platform-wide one - see
    -- docs/architecture.md.
    created_by       UUID,
    -- Stop-loss: the low/high of the previous completed candle at
    -- stop_loss_interval, a flat % from entry price, or the latest value
    -- of a pluggable indicator computation (stop_loss_indicator_type +
    -- stop_loss_indicator_params, see app/domain/rule.py's
    -- validate_stop_loss_indicator_params/_STOP_LOSS_INDICATOR_PARAMS_MODELS
    -- for the type->params-shape dispatch). Exactly one of
    -- stop_loss_interval/stop_loss_percent/(stop_loss_indicator_type+
    -- stop_loss_indicator_params) is set, matching stop_loss_method.
    -- trailing_stop_enabled only means something once a stop_loss_method
    -- is set. Interval values (1/5/15/25/60min, no 'daily', no '30min')
    -- match Dhan's charts/intraday API exactly - see market-data's
    -- DhanProvider.get_previous_candle.
    stop_loss_method    TEXT CHECK (stop_loss_method IN ('previous_candle', 'percent', 'indicator', 'breakeven')),
    stop_loss_interval  TEXT CHECK (stop_loss_interval IN ('1min', '3min', '5min', '15min', '25min', '30min', '60min')),
    stop_loss_percent   NUMERIC CHECK (stop_loss_percent > 0 AND stop_loss_percent < 100),
    -- 'ema'/'supertrend' today - MUST be widened here in lockstep with
    -- _STOP_LOSS_INDICATOR_PARAMS_MODELS in app/domain/rule.py whenever a
    -- new stop-loss indicator type is added (indicators.type's own CHECK
    -- constraint was once left behind when new IndicatorTypes were added
    -- at the Pydantic layer - don't repeat that here).
    stop_loss_indicator_type   TEXT CHECK (stop_loss_indicator_type IN ('ema', 'supertrend')),
    stop_loss_indicator_params JSONB,
    -- Target (take-profit): always a flat % from entry price, independent
    -- of the stop-loss method. No trailing variant for target.
    target_percent      NUMERIC CHECK (target_percent > 0 AND target_percent < 100),
    trailing_stop_enabled BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT stop_loss_fields_consistent CHECK (
        (stop_loss_method IS NULL AND stop_loss_interval IS NULL AND stop_loss_percent IS NULL
            AND stop_loss_indicator_type IS NULL AND stop_loss_indicator_params IS NULL
            AND trailing_stop_enabled = false)
        OR (stop_loss_method = 'previous_candle' AND stop_loss_interval IS NOT NULL AND stop_loss_percent IS NULL
            AND stop_loss_indicator_type IS NULL AND stop_loss_indicator_params IS NULL)
        OR (stop_loss_method = 'percent' AND stop_loss_percent IS NOT NULL AND stop_loss_interval IS NULL
            AND stop_loss_indicator_type IS NULL AND stop_loss_indicator_params IS NULL)
        OR (stop_loss_method = 'indicator' AND stop_loss_interval IS NOT NULL AND stop_loss_percent IS NULL
            AND stop_loss_indicator_type IS NOT NULL AND stop_loss_indicator_params IS NOT NULL)
        -- 'breakeven': same field shape as 'percent' (stop_loss_percent is
        -- both the initial stop distance and the favorable-move trigger
        -- threshold, see StopLossMethod's own comment in signal-generation's
        -- app/domain/generation/models.py) - added 2026-08-29. Also requires
        -- trailing_stop_enabled=true (unlike 'percent', a flat/non-trailing
        -- breakeven stop would never actually snap to entry - see
        -- validate_stop_loss_fields's identical check).
        OR (stop_loss_method = 'breakeven' AND stop_loss_percent IS NOT NULL AND stop_loss_interval IS NULL
            AND stop_loss_indicator_type IS NULL AND stop_loss_indicator_params IS NULL
            AND trailing_stop_enabled = true)
    ),
    -- Which market this strategy trades in - distinct from `exchange`
    -- above (still fixed to NSE, the only one actually wired up
    -- end-to-end), and distinct from the linked Rule's own `segment`
    -- (which market the rule's condition/universe watches - see
    -- rules.segment above; the two aren't required to match, e.g. an NSE
    -- spot scan could in principle back an option strategy on the same
    -- underlying). MCX/CRYPTO can be recorded as intent even though
    -- nothing downstream trades them yet - see docs/architecture.md.
    segment          TEXT NOT NULL DEFAULT 'NSE' CHECK (segment IN ('NSE', 'MCX', 'CRYPTO')),
    -- instrument_type='option' only - which fixed template choose_strategy
    -- (signal-processing) builds: 'spread' (bull_call_spread/bear_put_spread,
    -- Phase 4b) or 'naked' (naked_call/naked_put - single BUY leg, no short
    -- leg). Harmlessly ignored for spot/future strategies.
    option_position_style TEXT NOT NULL DEFAULT 'spread' CHECK (option_position_style IN ('spread', 'naked')),
    -- instrument_type='option' only - which strike the primary (long) leg
    -- uses, ITM2/ITM1/ATM/OTM1/OTM2 relative to spot (see signal-processing's
    -- option_templates.py _MONEYNESS_OFFSETS). Harmlessly ignored for
    -- spot/future strategies. A spread's short leg still sits
    -- SPREAD_WIDTH_STRIKES further out from wherever this lands, not from
    -- ATM itself.
    option_strike_moneyness TEXT NOT NULL DEFAULT 'ATM' CHECK (option_strike_moneyness IN ('ITM2', 'ITM1', 'ATM', 'OTM1', 'OTM2')),
    -- instrument_type='option' only - whether execution monitors one
    -- SL/target threshold on the combined (net debit) premium ('combined',
    -- the original design) or each leg's own threshold computed from its
    -- own entry premium ('individual' - either leg tripping still closes
    -- the whole group together, never just one leg). Harmlessly ignored
    -- for spot/future strategies.
    option_sl_scope TEXT NOT NULL DEFAULT 'combined' CHECK (option_sl_scope IN ('combined', 'individual')),
    -- Every instrument_type, nullable (renamed from option_fixed_lots,
    -- which used to be options-only). When set, execution trades exactly
    -- this many LOTS instead of auto-sizing off capital/risk% - takes
    -- precedence over stop-loss-based sizing entirely. Number of lots,
    -- not raw underlying units - a no-op distinction for spot (lot_size
    -- is always 1 there) but real for futures/options.
    fixed_lots INTEGER CHECK (fixed_lots > 0),
    -- horizon='positional' + instrument_type='spot' + segment='NSE' only
    -- (harmlessly ignored otherwise, same "shared table, segment-scoped
    -- meaning" convention as option_sl_scope above) - opts this Strategy's
    -- orders into execution.accounts' platform-wide NSE leverage (Dhan
    -- MTF) when configured there, rather than every positional NSE order
    -- getting leveraged sizing unconditionally. See execution's
    -- position_manager.open_position and docs/architecture.md.
    use_margin BOOLEAN NOT NULL DEFAULT false,
    -- Optional per-strategy time-of-day window (e.g. 09:15-11:00) during
    -- which this strategy accepts signals - a JSON array of
    -- {"start": "HH:MM:SS", "end": "HH:MM:SS"} objects, e.g.
    -- [{"start":"09:15:00","end":"10:30:00"},{"start":"13:00:00","end":"14:30:00"}] -
    -- a signal is accepted if it falls within ANY one of them (multiple
    -- windows may overlap, harmlessly). Enforced by signal-processing's
    -- resolve() against the signal's own timestamp (not wall-clock time
    -- at resolution), for every source_type, not just in_house. Purely
    -- gates whether an entry SIGNAL is accepted - an already-open
    -- position can still close outside every window via stop-loss/
    -- target/square-off/counter-signal, unaffected by this field
    -- entirely (no longer interacts with square-off in any way -
    -- square-off is a per-segment execution.accounts setting now, not a
    -- Strategy field - see docs/architecture.md). Empty array (default)
    -- means no restriction. Internal shape (each window's own end>start)
    -- validated at the Pydantic layer only (ActiveWindow in
    -- app/domain/models.py) - same as rule_config/regime_indicator_ids
    -- elsewhere in this file, no DB-level CHECK on JSONB internals.
    active_windows JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Optional day-of-week filter, e.g. ["Mon","Tue","Wed","Thu","Fri"]
    -- for weekdays-only - a JSON array of "Mon".."Sun" strings. Same
    -- signal-ACCEPTANCE-only scope as active_windows above (an already-
    -- open position still closes outside it via stop-loss/target/
    -- square-off/counter-signal), enforced the same place (signal-
    -- processing's resolve(), every source_type). Empty array (default)
    -- means no restriction. Validated at the Pydantic layer only
    -- (Weekday literal in app/domain/models.py), no DB-level CHECK on
    -- JSONB internals - same precedent as active_windows/rule_config.
    active_weekdays JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Signal-conflict policy - passed through unchanged on resolved-order
    -- to execution's position_manager._resolve_signal_conflicts.
    -- duplicate_signal_policy: what to do when this symbol already has an
    -- OPEN position in the SAME direction as an incoming signal - 'skip'
    -- rejects the new order, 'add_position' pyramids (opens an
    -- independent additional position). counter_signal_policy: what to do
    -- when an OPPOSITE-direction signal arrives - 'skip' leaves the
    -- existing position untouched, 'close_and_flip' closes it (ahead of
    -- its own stop-loss/target/square-off) before the new one opens.
    -- Defaults match the platform-wide behavior these replaced (see
    -- infra/postgres/init/02-execution.sql).
    duplicate_signal_policy TEXT NOT NULL DEFAULT 'skip' CHECK (duplicate_signal_policy IN ('skip', 'add_position')),
    counter_signal_policy   TEXT NOT NULL DEFAULT 'close_and_flip' CHECK (counter_signal_policy IN ('skip', 'close_and_flip')),
    -- instrument_type in ('future', 'option') only - restricts signals to
    -- a specific day in the contract's lifecycle. 'any' (default): no
    -- restriction, today's behavior unchanged. 'expiry': only the
    -- contract's own expiry day. 'start': only the day the CURRENT
    -- expiry/contract became the relevant one - option only, computed
    -- from market-data's live expiry list (day after the previous
    -- expiry); not reliably computable for futures (Dhan's instrument
    -- master never lists an already-expired contract to compute
    -- day-after from), so 'start'+'future' is rejected at create/update
    -- time - see validate_contract_day_filter_fields. Never enforced for
    -- segment='CRYPTO' (daily option expiry makes the distinction
    -- meaningless there) - harmlessly ignored for 'spot' too (no expiry
    -- concept at all).
    contract_day_filter TEXT NOT NULL DEFAULT 'any' CHECK (contract_day_filter IN ('any', 'start', 'expiry')),
    status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'backtesting', 'live', 'paused')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- rule_id required exactly for source_type='in_house', forbidden
    -- otherwise - DB-level mirror of validate_strategy_rule_requirement
    -- (app/domain/models.py), enforced app-side at create/update time.
    CONSTRAINT rule_id_matches_source_type CHECK ((source_type = 'in_house') = (rule_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_strategies_status ON signal_generation.strategies (status);
CREATE INDEX IF NOT EXISTS idx_strategies_rule_id ON signal_generation.strategies (rule_id);

-- 'breakeven' stop-loss method (2026-08-29) - a fresh CREATE TABLE above
-- already lists it, but an existing volume's own inline CHECK constraints
-- were fixed at their original CREATE TABLE time and don't pick up an
-- edited CREATE TABLE statement automatically (init scripts never re-run) -
-- these two ALTERs re-widen them on an already-existing strategies table.
ALTER TABLE signal_generation.strategies DROP CONSTRAINT IF EXISTS strategies_stop_loss_method_check;
ALTER TABLE signal_generation.strategies ADD CONSTRAINT strategies_stop_loss_method_check
    CHECK (stop_loss_method IN ('previous_candle', 'percent', 'indicator', 'breakeven'));
ALTER TABLE signal_generation.strategies DROP CONSTRAINT IF EXISTS stop_loss_fields_consistent;
ALTER TABLE signal_generation.strategies ADD CONSTRAINT stop_loss_fields_consistent CHECK (
    (stop_loss_method IS NULL AND stop_loss_interval IS NULL AND stop_loss_percent IS NULL
        AND stop_loss_indicator_type IS NULL AND stop_loss_indicator_params IS NULL
        AND trailing_stop_enabled = false)
    OR (stop_loss_method = 'previous_candle' AND stop_loss_interval IS NOT NULL AND stop_loss_percent IS NULL
        AND stop_loss_indicator_type IS NULL AND stop_loss_indicator_params IS NULL)
    OR (stop_loss_method = 'percent' AND stop_loss_percent IS NOT NULL AND stop_loss_interval IS NULL
        AND stop_loss_indicator_type IS NULL AND stop_loss_indicator_params IS NULL)
    OR (stop_loss_method = 'indicator' AND stop_loss_interval IS NOT NULL AND stop_loss_percent IS NULL
        AND stop_loss_indicator_type IS NOT NULL AND stop_loss_indicator_params IS NOT NULL)
    OR (stop_loss_method = 'breakeven' AND stop_loss_percent IS NOT NULL AND stop_loss_interval IS NULL
        AND stop_loss_indicator_type IS NULL AND stop_loss_indicator_params IS NULL
        AND trailing_stop_enabled = true)
);

-- Idempotent for existing volumes (init scripts don't re-run) - matches the
-- same convention used in 02-execution.sql/04-accounts.sql.
ALTER TABLE signal_generation.strategies ADD COLUMN IF NOT EXISTS use_margin BOOLEAN NOT NULL DEFAULT false;

-- Runtime bookkeeping for the in-house engine's periodic tick - which
-- completed candle a strategy last acted on, so the poll loop (running
-- far more often than any one strategy's own interval) doesn't re-signal
-- on the same bar every tick. Deliberately separate from the strategies
-- table above: this is mutable engine state, not user-configured intent.
-- Keyed by (strategy_id, symbol), not rule_id - two Strategies can share
-- the same Rule (e.g. a spot strategy and an option strategy on the same
-- crossover), and each needs its own independent dedupe/position state,
-- not one shared state for both. Keyed by (strategy_id, symbol), not just
-- strategy_id: a universe-scoped rule (underlying_type='universe') checks
-- many symbols independently each tick and needs its own dedupe state per
-- constituent, not one shared state for the whole strategy. A plain
-- symbol-scoped rule just gets one row, keyed by its one symbol.
CREATE TABLE IF NOT EXISTS signal_generation.engine_runs (
    strategy_id            UUID NOT NULL REFERENCES signal_generation.strategies (id) ON DELETE CASCADE,
    symbol                 TEXT NOT NULL,
    last_signal_candle_ts  TIMESTAMPTZ,
    last_checked_at        TIMESTAMPTZ,
    PRIMARY KEY (strategy_id, symbol)
);

-- A saved snapshot of a POST /rules/{id}/backtest run - both the request
-- body (criteria) AND the response it produced (result), frozen at save
-- time. Deliberately not just the request replayed on read: market data
-- keeps arriving, so re-running later against a fixed from/to range could
-- silently produce different numbers than what was actually reviewed and
-- saved - this is a point-in-time record, not a live query. User-named
-- (name) so a growing list stays scannable. "Duplicate and edit" is a
-- frontend-only operation (prefills the backtest form from an existing
-- row's request); saving again always INSERTs a new row rather than
-- updating one in place, so history is never silently overwritten - see
-- app/api/routes/saved_backtests.py. ON DELETE CASCADE: a saved snapshot
-- for a deleted Rule has nothing left to re-run it against, same
-- reasoning engine_runs above already uses.
CREATE TABLE IF NOT EXISTS signal_generation.saved_backtests (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id     UUID NOT NULL REFERENCES signal_generation.rules (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    from_date   DATE NOT NULL,
    to_date     DATE NOT NULL,
    -- The exact RuleBacktestRequest body used - JSONB (not dedicated
    -- columns) so a new backtest-request field is new code, not a
    -- migration, same reasoning rule_config elsewhere in this file uses.
    request     JSONB NOT NULL,
    -- The exact response POST /rules/{id}/backtest returned (single-symbol
    -- BacktestResult, or the pooled by_symbol shape for underlying_type IN
    -- ('universe', 'symbol_list')).
    result      JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saved_backtests_rule_id ON signal_generation.saved_backtests (rule_id);

-- Strategy ownership (2026-08-30) - idempotent for existing volumes (init
-- scripts don't re-run), same convention as use_margin above. See
-- strategies.created_by's own comment near its CREATE TABLE definition.
ALTER TABLE signal_generation.strategies ADD COLUMN IF NOT EXISTS created_by UUID;
