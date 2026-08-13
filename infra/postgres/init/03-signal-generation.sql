-- Runs automatically on first container start (docker-entrypoint-initdb.d).

CREATE SCHEMA IF NOT EXISTS signal_generation;

-- A Strategy is the unit of configuration for a signal source - either an
-- external webhook provider (chartink, tradingview) or, eventually, an
-- in-house indicator/price-action engine. Its id doubles as the
-- ?strategy_id= value given to the provider (or generated internally),
-- and its horizon/instrument_type are what signal-processing resolves a
-- signal to - see docs/architecture.md.
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
    -- against (see in_house_fields_consistent below and every backend
    -- source_type check) - anything else names an external webhook
    -- provider (chartink, tradingview, or any new one), free-form so a
    -- new provider needs no schema/code change here.
    source_type      TEXT NOT NULL CHECK (source_type <> ''),
    exchange         TEXT NOT NULL CHECK (exchange IN ('NSE')),
    horizon          TEXT NOT NULL CHECK (horizon IN ('intraday', 'swing', 'positional')),
    instrument_type  TEXT NOT NULL CHECK (instrument_type IN ('spot', 'future', 'option')),
    -- Signal/candle cadence. Optional: for external providers it's purely
    -- descriptive (we don't control when Chartink actually fires - this
    -- just documents the expected cadence for future staleness checks);
    -- for an in-house strategy it will drive the engine's own check
    -- interval and backtest granularity once that's built - see
    -- docs/architecture.md.
    interval         TEXT CHECK (interval IN ('1min', '3min', '5min', '15min', '30min', '60min', 'daily')),
    -- Stop-loss: either the low/high of the previous completed candle at
    -- stop_loss_interval, or a flat % from entry price. The two are
    -- mutually exclusive - exactly one of stop_loss_interval/
    -- stop_loss_percent is set, matching whichever stop_loss_method was
    -- chosen. trailing_stop_enabled only means something once a
    -- stop_loss_method is set. Interval values (1/5/15/25/60min, no
    -- 'daily', no '30min') match Dhan's charts/intraday API exactly -
    -- see market-data's DhanProvider.get_previous_candle.
    stop_loss_method    TEXT CHECK (stop_loss_method IN ('previous_candle', 'percent')),
    stop_loss_interval  TEXT CHECK (stop_loss_interval IN ('1min', '5min', '15min', '25min', '60min')),
    stop_loss_percent   NUMERIC CHECK (stop_loss_percent > 0 AND stop_loss_percent < 100),
    -- Target (take-profit): always a flat % from entry price, independent
    -- of the stop-loss method. No trailing variant for target.
    target_percent      NUMERIC CHECK (target_percent > 0 AND target_percent < 100),
    trailing_stop_enabled BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT stop_loss_fields_consistent CHECK (
        (stop_loss_method IS NULL AND stop_loss_interval IS NULL AND stop_loss_percent IS NULL
            AND trailing_stop_enabled = false)
        OR (stop_loss_method = 'previous_candle' AND stop_loss_interval IS NOT NULL AND stop_loss_percent IS NULL)
        OR (stop_loss_method = 'percent' AND stop_loss_percent IS NOT NULL AND stop_loss_interval IS NULL)
    ),
    -- Which market this strategy trades in - distinct from `exchange`
    -- above (still fixed to NSE, the only one actually wired up
    -- end-to-end). Only drives the square_off_time default below; MCX/
    -- CRYPTO can be recorded as intent even though nothing downstream
    -- trades them yet - see docs/architecture.md.
    segment          TEXT NOT NULL DEFAULT 'NSE' CHECK (segment IN ('NSE', 'MCX', 'CRYPTO')),
    -- instrument_type='option' only - which fixed template choose_strategy
    -- (signal-processing) builds: 'spread' (bull_call_spread/bear_put_spread,
    -- Phase 4b) or 'naked' (naked_call/naked_put - single BUY leg, no short
    -- leg). Harmlessly ignored for spot/future strategies, same convention
    -- as regime_filter_enabled being ignored for non-in_house strategies.
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
    -- Required for horizon='intraday' only - square-off doesn't apply to
    -- swing/positional strategies (positions aren't closed same-day), so
    -- this stays NULL for them. Auto-defaulted server-side from
    -- (horizon, segment) when omitted on an intraday strategy - 15:00 for
    -- NSE, 22:00 for MCX, 17:25 for CRYPTO. execution has no
    -- platform-wide fallback of its own.
    square_off_time  TIME,
    -- in_house only - the logical underlying to watch (e.g. "GOLDM",
    -- "NIFTY") and a typed JSON rule config (CrossoverRuleConfig today -
    -- {"type": "crossover", "indicator_id": ..., "signal_source": "sma_of_indicator", "signal_period": ...}).
    -- Names WHICH indicator (signal_generation.indicators below) and HOW
    -- to decide from it - deliberately NOT the indicator's own params
    -- (period etc.), which live on the referenced Indicator row instead,
    -- so one indicator definition can be reused by many strategies. JSONB
    -- (not dedicated columns) so a second rule type is new code, not a
    -- migration. Note: `exchange` above stays fixed 'NSE' even for an
    -- in_house MCX strategy - the actual traded exchange for a signal
    -- this engine posts comes from market-data's GET /instruments/resolve
    -- response (trade_exchange), not this column; `segment` is the field
    -- that carries real MCX/NSE intent here.
    underlying       TEXT,
    -- 'symbol' (default): underlying names one traded symbol, as before.
    -- 'universe': underlying instead names an NSE index-constituent
    -- group key (e.g. 'NIFTYBANK', resolved via market-data's GET
    -- /instruments/universe/constituents) - the engine evaluates this
    -- strategy's rule against every constituent independently, each
    -- with its own row in engine_runs below. Universes are NSE
    -- cash-equity index membership lists only - see the
    -- universe_requires_nse_spot constraint.
    underlying_type  TEXT NOT NULL DEFAULT 'symbol' CHECK (underlying_type IN ('symbol', 'universe')),
    rule_config      JSONB,
    -- in_house only (harmlessly ignored for webhook strategies) - gates a
    -- crossover signal on a single-timeframe market regime classification
    -- (UPTREND/DOWNTREND/RANGE/TRANSITION from swing structure, Efficiency
    -- Ratio, ADX/DMI, ATR-normalized EMA slope - see
    -- app/domain/regime.py) computed on this strategy's own `interval`,
    -- not a separate higher timeframe. Default false preserves today's
    -- behavior exactly. See docs/architecture.md.
    regime_filter_enabled BOOLEAN NOT NULL DEFAULT false,
    -- Which of the 5 sub-conditions classify_regime combines
    -- (structure/efficiency_ratio/adx/dmi_direction/ema_slope, see
    -- app/domain/regime.py's REGIME_CHECK_NAMES) must agree to confirm a
    -- signal's direction when regime_filter_enabled - defaults to all 5,
    -- matching classify_regime's own fixed "regime" label exactly.
    regime_filter_checks JSONB NOT NULL DEFAULT '["structure", "efficiency_ratio", "adx", "dmi_direction", "ema_slope"]',
    -- Optional per-strategy time-of-day window (e.g. 09:15-11:00) during
    -- which this strategy accepts signals - both-or-neither, enforced by
    -- signal-processing's resolve() against the signal's own timestamp
    -- (not wall-clock time at resolution), for every source_type, not
    -- just in_house. active_to_time also bounds how long a position this
    -- strategy opens can stay open: resolve() folds it into the resolved
    -- order's square_off_time (the earlier of the two), so execution's
    -- existing square-off machinery force-closes at the window's end with
    -- no execution-side changes - see docs/architecture.md. NULL/NULL
    -- (default) means no restriction, unchanged from today's behavior.
    active_from_time TIME,
    active_to_time   TIME,
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
    CONSTRAINT square_off_time_required_for_intraday CHECK (horizon != 'intraday' OR square_off_time IS NOT NULL),
    CONSTRAINT in_house_fields_consistent CHECK (
        (source_type = 'in_house' AND underlying IS NOT NULL AND rule_config IS NOT NULL AND interval IS NOT NULL)
        OR (source_type != 'in_house' AND underlying IS NULL AND rule_config IS NULL)
    ),
    CONSTRAINT universe_requires_nse_spot CHECK (
        underlying_type != 'universe' OR (segment = 'NSE' AND instrument_type = 'spot')
    ),
    CONSTRAINT active_window_consistent CHECK (
        (active_from_time IS NULL) = (active_to_time IS NULL)
        AND (active_to_time IS NULL OR active_to_time > active_from_time)
    )
);

CREATE INDEX IF NOT EXISTS idx_strategies_status ON signal_generation.strategies (status);

-- A reusable indicator definition (e.g. "RSI 14") - any number of
-- Strategy rows can reference one via rule_config's indicator_id (no DB
-- FK - that field is inside a JSONB blob, not a plain column; existence
-- is checked at the API layer instead, see app/api/routes/strategies.py).
-- params is JSONB (not dedicated columns) for the same reason rule_config
-- is: a second indicator type is new code, not a migration.
CREATE TABLE IF NOT EXISTS signal_generation.indicators (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('rsi')),
    params      JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Runtime bookkeeping for the in-house engine's periodic tick - which
-- completed candle a strategy last acted on, so the poll loop (running
-- far more often than any one strategy's own interval) doesn't re-signal
-- on the same bar every tick. Deliberately separate from the strategies
-- table above: this is mutable engine state, not user-configured intent.
-- Keyed by (strategy_id, symbol), not just strategy_id: a
-- universe-scoped strategy (underlying_type='universe') checks many
-- symbols independently each tick and needs its own dedupe state per
-- constituent, not one shared state for the whole strategy. A plain
-- symbol-scoped strategy just gets one row, keyed by its one symbol.
CREATE TABLE IF NOT EXISTS signal_generation.engine_runs (
    strategy_id            UUID NOT NULL REFERENCES signal_generation.strategies (id) ON DELETE CASCADE,
    symbol                 TEXT NOT NULL,
    last_signal_candle_ts  TIMESTAMPTZ,
    last_checked_at        TIMESTAMPTZ,
    PRIMARY KEY (strategy_id, symbol)
);
