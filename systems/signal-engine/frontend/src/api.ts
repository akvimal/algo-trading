// Free-form: only "in_house" is reserved/special (see backend
// app/domain/models.py's SourceType) - anything else names an external
// webhook provider (chartink, tradingview, or any new one).
export type SourceType = string;
export type Horizon = "intraday" | "positional"; // "swing" merged into these two 2026-08-17
export type InstrumentType = "spot" | "future" | "option";
export type StrategyStatus = "draft" | "backtesting" | "live" | "paused";
// One [start, end) slice of a Strategy's optional signal-acceptance
// window(s) - "HH:MM:SS" strings, end strictly after start.
export type ActiveWindow = { start: string; end: string };
// Mon-Sun abbreviations for Strategy.active_weekdays - a day-of-week
// signal-acceptance filter, independent of ActiveWindow's time-of-day
// one. Empty array (the default) means unrestricted.
export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
export const ALL_WEEKDAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// The UI's own default-checked set for a new/never-configured strategy -
// weekdays only (most strategies target NSE/MCX, which don't trade
// weekends). A real, active restriction (excludes Sat/Sun), NOT a stand-in
// for "unrestricted" the way checking all 7 would be - a CRYPTO strategy
// meant to trade every day still needs Sat/Sun checked explicitly.
export const DEFAULT_ACTIVE_WEEKDAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri"];
export type Interval = "1min" | "3min" | "5min" | "15min" | "30min" | "60min" | "daily";
export type StopLossMethod = "previous_candle" | "percent" | "indicator" | "breakeven";
// Backtest-only - "touch" (default, matches live execution's continuous
// CMP monitoring) vs "close" (a what-if: only exits once a bar's CLOSE
// crosses the stop level). See backend's ExitConfig docstring.
export type StopLossConfirmation = "touch" | "close";
// stop_loss_method='indicator' only - which computation to run. 'ema'/
// 'supertrend' today - see backend app/domain/rule.py's
// _STOP_LOSS_INDICATOR_PARAMS_MODELS.
export type StopLossIndicatorType = "ema" | "supertrend";
// Shape depends on StopLossIndicatorType - 'ema' uses only `period`,
// 'supertrend' uses both (ATR period + band multiplier). `multiplier`
// stays optional here rather than a discriminated union so every existing
// `{ period }`-shaped call site keeps compiling unchanged.
export type StopLossIndicatorParams = { period: number; multiplier?: number };
// 1/5/15/25/60 are Dhan's native intraday-candle intervals; 3min/30min
// are locally aggregated from 1min bars (same as Interval's own 3min/
// 30min support) - "daily" excluded, the intraday endpoints don't serve it.
export type StopLossInterval = "1min" | "3min" | "5min" | "15min" | "25min" | "30min" | "60min";
// instrument_type='option' only - which fixed template signal-processing's
// choose_strategy builds: 'spread' (bull_call_spread/bear_put_spread,
// 2 legs) or 'naked' (naked_call/naked_put, single BUY leg only, no
// short leg). Harmlessly ignored for spot/future strategies.
export type OptionPositionStyle = "spread" | "naked";
// instrument_type='option' only - which strike the primary (long) leg
// uses, relative to spot. 'ATM' default reproduces pre-this-field
// behavior exactly. A spread's short leg still sits a fixed distance
// further out from wherever this lands, not from ATM itself.
export type OptionStrikeMoneyness = "ITM2" | "ITM1" | "ATM" | "OTM1" | "OTM2";
// instrument_type='option' only - whether execution monitors one SL/target
// threshold on the combined (net debit) premium ('combined', default) or
// each leg's own threshold computed from its own entry premium
// ('individual'). Either scope still closes the WHOLE group together when
// tripped - this only changes the trigger condition. Mathematically
// identical to 'combined' for a naked (1-leg) position.
export type OptionSlScope = "combined" | "individual";
// instrument_type in ('future', 'option') only - restricts signal
// eligibility to a specific day in the underlying contract's lifecycle.
// 'any' (default) never restricts. 'expiry' requires today to be the
// resolved contract's own expiry day - works for both future and option.
// 'start' requires today to be the day after the *previous* contract's
// expiry - option only, rejected by the backend for instrument_type=
// 'future' (not reliably computable there - Dhan's instrument master never
// retains an already-expired contract to compute day-after from). Never
// enforced for segment/exchange='CRYPTO' (daily expiry makes the
// distinction meaningless there).
export type ContractDayFilter = "any" | "start" | "expiry";
// Which market this strategy trades in - distinct from `exchange` (still
// fixed to "NSE", the only one actually wired up end-to-end), and distinct
// from a linked Rule's own `segment` (which market the rule's
// condition/universe watches - see Rule below; the two aren't required to
// match). MCX/CRYPTO can be recorded as intent even though nothing
// downstream trades them yet.
export type Segment = "NSE" | "MCX" | "CRYPTO";

// Signal-conflict policy, per-strategy - passed through unchanged on
// resolved-order to execution. duplicate_signal_policy: what happens when
// this symbol already has an OPEN position in the SAME direction as an
// incoming signal ("skip" rejects it, "add_position" pyramids).
// counter_signal_policy: what happens when an OPPOSITE-direction signal
// arrives ("skip" leaves the existing position untouched, "close_and_flip"
// closes it - ahead of its own stop-loss/target/square-off - before the
// new one opens).
export type DuplicateSignalPolicy = "skip" | "add_position";
export type CounterSignalPolicy = "skip" | "close_and_flip";

// A Rule's own scanning scope. 'symbol' (default): underlying names one
// traded symbol. 'universe': underlying instead names an NSE
// index-constituent group key (e.g. "NIFTYBANK", from fetchUniverses()
// below) - the engine evaluates the rule against every constituent
// independently. Only valid combined with segment='NSE' - not coupled to
// any linked Strategy's instrument_type (a universe scan can back a spot,
// future, or option strategy alike). 'symbol_list': underlying instead
// holds a comma-separated list of explicit symbols (e.g.
// "GOLDM,SILVER,CRUDEOIL") - for segments like MCX with no index/universe
// concept, valid on any segment since it never calls market-data.
// 'watchlist': underlying instead names a Watchlist (below) by its unique
// name - a user-managed, reusable symbol group, unlike 'symbol_list' (baked
// into this one rule) and unlike 'universe' (fixed to market-data's index
// API). Valid on any segment, same as 'symbol_list'.
export type UnderlyingType = "symbol" | "universe" | "symbol_list" | "watchlist";

// Indicators are their own entity (backend: signal_generation.indicators)
// so one definition (e.g. "RSI 14") can be reused by any number of
// rules - see docs/architecture.md. Only "rsi" exists today.
export type IndicatorType = "rsi" | "structure" | "efficiency_ratio" | "adx" | "dmi_direction" | "ema_slope" | "supertrend";

// The 6 market-regime checks (backend's app/domain/regime.py) as
// independent Indicator types, referenced from a Rule via its own
// regime_indicator_ids (see Rule below) rather than "rsi", which is
// crossover-only (CrossoverRuleConfig.indicator_id).
export const REGIME_INDICATOR_TYPES: IndicatorType[] = [
  "structure",
  "efficiency_ratio",
  "adx",
  "dmi_direction",
  "ema_slope",
  "supertrend",
];

// IndicatorTypes valid as CrossoverRuleConfig.indicator_id - mirrors the
// backend's CROSSOVER_INDICATOR_TYPES (app/domain/rule.py). "supertrend"
// is deliberately in both this list and REGIME_INDICATOR_TYPES above -
// price crossing the SuperTrend line is a standard crossover entry
// signal, independent of whether some other saved SuperTrend indicator
// row also backs a regime filter/stop-loss elsewhere. "rsi" stays
// crossover-only, same as before.
export const CROSSOVER_INDICATOR_TYPES: IndicatorType[] = ["rsi", "supertrend"];
export const INDICATOR_TYPE_LABELS: Record<IndicatorType, string> = {
  rsi: "RSI",
  structure: "Swing structure",
  efficiency_ratio: "Efficiency Ratio",
  adx: "ADX strength",
  dmi_direction: "DMI direction",
  ema_slope: "EMA slope",
  supertrend: "SuperTrend",
};

// sma_period is RSI's own signal line (SMA of RSI) - bundled into the
// indicator's own definition, matching how TradingView's RSI script
// bundles "RSI Length" and "MA Length" into one indicator's settings.
export type RsiParams = { period: number; sma_period: number };
// Confirmed swing structure (regime.check_structure) - bars each side
// required to confirm a pivot.
export type StructureParams = { swing_lookback: number };
// Kaufman's Efficiency Ratio (regime.check_efficiency_ratio) -
// trend_threshold is bias-independent (ER only measures how efficiently
// price is moving, not which way).
export type EfficiencyRatioParams = { period: number; trend_threshold: number };
// Wilder's ADX (regime.check_adx) - trend_threshold is bias-independent
// (ADX measures trend strength, not direction).
export type AdxParams = { period: number; trend_threshold: number };
// +DI vs -DI direction (regime.check_dmi_direction).
export type DmiDirectionParams = { period: number };
// ATR-normalized EMA slope (regime.check_ema_slope) - atr_period sizes
// the normalizing ATR independently of ema_period.
export type EmaSlopeParams = { ema_period: number; slope_lookback: number; slope_threshold: number; atr_period: number };
// SuperTrend line vs. close (regime.check_supertrend) - same {period,
// multiplier} shape as StopLossIndicatorType='supertrend' above, but a
// separate, unrelated params type (different registry/concern).
export type SupertrendParams = { period: number; multiplier: number };

export type IndicatorParams =
  | RsiParams
  | StructureParams
  | EfficiencyRatioParams
  | AdxParams
  | DmiDirectionParams
  | EmaSlopeParams
  | SupertrendParams;

export type Indicator = {
  id: string;
  name: string;
  type: IndicatorType;
  params: IndicatorParams;
  created_at: string;
  updated_at: string;
};

export type IndicatorCreate = {
  name: string;
  type: IndicatorType;
  params: IndicatorParams;
};

export type IndicatorUpdate = {
  name?: string;
  params?: IndicatorParams;
};

// A named, reusable, user-managed group of symbols - referenced by name
// from a Rule's own `underlying` when underlying_type='watchlist' above,
// exactly how 'universe' references a fixed NSE index key. See
// docs/architecture.md's Watchlist section.
export type Watchlist = {
  id: string;
  name: string;
  // Comma-separated, same raw-string shape as symbol_list's own underlying.
  symbols: string;
  symbol_count: number;
  created_at: string;
  updated_at: string;
};

export type WatchlistCreate = {
  name: string;
  symbols: string;
};

// name isn't editable after creation - see the backend's WatchlistUpdate
// docstring (a rename would silently orphan every Rule already referencing
// the old name).
export type WatchlistUpdate = {
  symbols: string;
};

// Names WHICH indicator a rule uses; "crosses its own signal line" needs
// no parameters of its own since the signal line is the indicator's own
// concern (e.g. RsiParams.sma_period). A typed JSON blob (not dedicated
// columns) so a second rule type later is new code, not a migration. See
// backend's CrossoverRuleConfig.
export type CrossoverRuleConfig = {
  type: "crossover";
  indicator_id: string;
};

// A second, structurally independent rule type - a multi-timeframe
// Donchian breakout, no indicator involved at all. HTF confirms an N-bar
// high/low breakout (optionally also requiring price be above/below
// EMA(ema_period)), which arms an entry window valid only until the next
// HTF candle closes; within that window, the first LTF candle to itself
// break its own N-bar high/low triggers entry. See backend's
// BreakoutRuleConfig / app/domain/breakout.py for the full mechanics
// (including the reversal-exit condition, which only ever runs in the
// backtest - see docs/architecture.md's "live enforcement gap").
export type BreakoutRuleConfig = {
  type: "breakout";
  htf_interval: Interval;
  htf_breakout_period: number;
  ltf_interval: Interval;
  ltf_breakout_period: number;
  ema_filter_enabled: boolean;
  ema_period: number;
};

// A third, minimal rule type - single-timeframe Donchian breakout ("close
// greater than the last N candles' high", or below their low for a
// bearish signal), on the rule's own `interval`. No indicator, no htf/ltf
// split, no rule-intrinsic exit scheme - whatever exit config the linked
// Strategy (or a backtest request) supplies applies as-is, unlike
// BreakoutRuleConfig above. See backend's RangeBreakoutRuleConfig.
export type RangeBreakoutRuleConfig = {
  type: "range_breakout";
  breakout_period: number;
};

// One leaf value in a MultiConditionRuleConfig's Condition (below) -
// deliberately FLAT, not a recursive expression tree. `field` names which
// raw OHLCV series a windowed kind (sma/ema/highest/lowest) or 'price'
// itself reads off the candle - required for those, must be omitted for
// every other kind. `offset_bars` shifts the whole computed series back N
// completed bars - "N days/bars ago X". `scale` multiplies the final value
// (covers e.g. "candle_range / 4" as scale=0.25). See backend's Term.
export type TermKind =
  | "price"
  | "volume"
  | "sma"
  | "ema"
  | "rsi"
  | "cci"
  | "highest"
  | "lowest"
  | "candle_body"
  | "candle_range"
  | "constant";

export type Term = {
  kind: TermKind;
  field?: "open" | "high" | "low" | "close" | "volume";
  period?: number;
  offset_bars?: number;
  scale?: number;
  value?: number;
};

// One AND-combined leaf of a MultiConditionRuleConfig - `interval` is THIS
// condition's own timeframe, independent of the Rule's own top-level
// `interval` (unlike every other rule type). See backend's Condition.
export type Condition = {
  interval: Interval;
  left: Term;
  operator: ">" | "<" | ">=" | "<=";
  right: Term;
};

// A 4th, structurally independent rule type - an arbitrary AND-combined
// list of Conditions, each with its own timeframe, for recreating
// Chartink-style multi-filter scans (e.g. "daily volume > its own 20-SMA
// AND 15m CCI(200) > 100 AND ..."). Deliberately ONE-DIRECTIONAL
// (`direction` picked once, matching how a Chartink scan itself is always
// a buy-scan or a sell-scan, never both) - see backend's
// MultiConditionRuleConfig.
export type MultiConditionRuleConfig = {
  type: "multi_condition";
  direction: "bullish" | "bearish";
  conditions: Condition[];
};

export type RuleConfig = CrossoverRuleConfig | BreakoutRuleConfig | RangeBreakoutRuleConfig | MultiConditionRuleConfig;

// A saved, reusable, independently-backtestable definition of *when a
// signal should fire* - a Strategy just picks one (Strategy.rule_id
// below). One Rule can back many Strategies (e.g. the same crossover
// backing both a spot strategy and an option-spread strategy on the same
// underlying) - see docs/architecture.md's "Rules module" section.
// Rule is purely an in-house condition definition now - external (webhook)
// strategies carry their own source_type directly and reference no Rule at
// all (Strategy.rule_id is null for them) - see Strategy below.
export type Rule = {
  id: string;
  name: string;
  description: string | null;
  segment: Segment;
  underlying: string;
  underlying_type: UnderlyingType;
  interval: Interval;
  rule_config: RuleConfig | null;
  // Which regime-type Indicators (REGIME_INDICATOR_TYPES above) must ALL
  // confirm this rule's own bias before it fires - a cross-cutting
  // modifier applying uniformly regardless of rule_config's own type.
  // Empty means no regime gate at all.
  regime_indicator_ids: string[];
  created_at: string;
  updated_at: string;
};

export type RuleCreate = {
  name: string;
  description?: string;
  segment?: Segment;
  underlying: string;
  underlying_type?: UnderlyingType;
  interval: Interval;
  rule_config: RuleConfig;
  regime_indicator_ids?: string[];
};

export type RuleUpdate = {
  name?: string;
  description?: string;
  segment?: Segment;
  underlying?: string;
  underlying_type?: UnderlyingType;
  interval?: Interval;
  rule_config?: RuleConfig;
  regime_indicator_ids?: string[];
};

// Lightweight embed on Strategy (see below) - which rule backs it, without
// an extra fetch per row in the strategy table.
export type RuleSummary = {
  id: string;
  name: string;
  segment: Segment;
};

// No quantity/capital field here on purpose - the actual sizing math
// (capital cap, risk %) is still execution's job. Stop-loss/target ARE
// here: stop distance varies by strategy/scan/timeframe, so the method
// belongs with what produces the signal. See docs/architecture.md.
export type Strategy = {
  id: string;
  name: string;
  source_type: SourceType;
  // Provider's own name for the thing that fires this strategy's signals
  // (e.g. the Chartink scan's title) - purely descriptive, never matched
  // against anywhere (unlike source_type itself). External strategies
  // only; null for in_house (which has a real Rule name via `rule`
  // instead). Unlike source_type, this IS editable after creation.
  source_rule_name: string | null;
  exchange: string;
  horizon: Horizon;
  instrument_type: InstrumentType;
  // Which saved Rule decides when this strategy's signals fire - in_house
  // only. Null for external (webhook) strategies - they carry no Rule at
  // all, the provider decides when a signal fires. See Rule above.
  rule_id: string | null;
  rule: RuleSummary | null;
  stop_loss_method: StopLossMethod | null;
  stop_loss_interval: StopLossInterval | null;
  stop_loss_percent: number | null;
  // stop_loss_method='indicator' only - see StopLossIndicatorType above.
  stop_loss_indicator_type: StopLossIndicatorType | null;
  stop_loss_indicator_params: StopLossIndicatorParams | null;
  target_percent: number | null;
  trailing_stop_enabled: boolean;
  // Optional independent live exit trigger (a single Condition, reused
  // from MultiConditionRuleConfig above) - closes the position the first
  // exit-monitor tick it's true, independent of stop_loss/target/
  // square-off. null = unused. See backend's validate_exit_condition.
  exit_condition: Condition | null;
  // instrument_type='option' only - see OptionPositionStyle above.
  option_position_style: OptionPositionStyle;
  option_strike_moneyness: OptionStrikeMoneyness;
  option_sl_scope: OptionSlScope;
  // Every instrument_type, nullable (renamed from option_fixed_lots,
  // which used to be options-only). When set, execution trades exactly
  // this many LOTS instead of auto-sizing off capital/risk% - takes
  // precedence over stop-loss-based sizing entirely. Number of lots, not
  // raw underlying units - a no-op distinction for spot (lot_size is
  // always 1 there, so this is really "quantity" for spot) but real for
  // futures/options.
  fixed_lots: number | null;
  // segment='NSE'+horizon='positional'+instrument_type='spot' only
  // (harmlessly ignored otherwise). Opts this strategy's orders into
  // execution's platform-wide NSE leverage (Dhan MTF) + interest when the
  // admin has configured it there - see docs/architecture.md.
  use_margin: boolean;
  contract_day_filter: ContractDayFilter;
  segment: Segment;
  duplicate_signal_policy: DuplicateSignalPolicy;
  counter_signal_policy: CounterSignalPolicy;
  // Optional per-strategy signal-acceptance window(s) (e.g. 09:15-11:00,
  // or several) - every source_type, empty array means unrestricted.
  // Enforced by signal-processing's resolve() against the signal's own
  // timestamp - a signal is accepted if it falls within ANY one of them.
  // Purely gates whether a signal is accepted, unrelated to square-off (a
  // per-segment execution setting now, not a Strategy field - see
  // docs/architecture.md).
  active_windows: ActiveWindow[];
  // Optional day-of-week filter (e.g. ["Mon","Tue","Wed","Thu","Fri"] for
  // weekdays-only) - independent of active_windows, same signal-
  // ACCEPTANCE-only scope. Empty array means unrestricted.
  active_weekdays: Weekday[];
  status: StrategyStatus;
  // MAX(engine_runs.last_checked_at) across every symbol this strategy
  // scans - null if the engine has never ticked it yet (e.g. just
  // created, or paused since before it ever got its first poll).
  last_scan_at: string | null;
  // MAX(signals.received_at) for this strategy - the external-strategy
  // counterpart to last_scan_at above (which is always null for one,
  // since it has no EngineRun at all). Null if no signal has arrived yet.
  last_signal_at: string | null;
  created_at: string;
  updated_at: string;
};

export type StrategyCreate = {
  name: string;
  source_type: SourceType;
  // External strategies only, optional. See Strategy's own comment above.
  source_rule_name?: string | null;
  horizon: Horizon;
  instrument_type: InstrumentType;
  // Required iff source_type === 'in_house'; omit/null for external.
  rule_id?: string | null;
  // null accepted (treated as omitted) - the create/edit form builds one
  // payload shape for both and sends explicit null on cleared fields.
  stop_loss_method?: StopLossMethod | null;
  stop_loss_interval?: StopLossInterval | null;
  stop_loss_percent?: number | null;
  stop_loss_indicator_type?: StopLossIndicatorType | null;
  stop_loss_indicator_params?: StopLossIndicatorParams | null;
  target_percent?: number | null;
  trailing_stop_enabled?: boolean;
  exit_condition?: Condition | null;
  option_position_style?: OptionPositionStyle;
  option_strike_moneyness?: OptionStrikeMoneyness;
  option_sl_scope?: OptionSlScope;
  fixed_lots?: number;
  use_margin?: boolean;
  contract_day_filter?: ContractDayFilter;
  segment?: Segment;
  duplicate_signal_policy?: DuplicateSignalPolicy;
  counter_signal_policy?: CounterSignalPolicy;
  // See Strategy's own comment above. Omitted = empty (unrestricted).
  active_windows?: ActiveWindow[];
  active_weekdays?: Weekday[];
};

// source_type/exchange aren't here - not editable after creation, see
// the backend's StrategyUpdate docstring. The stop-loss group accepts an
// explicit null now: sending {stop_loss_method: null} (which the form
// does when you clear the method while editing) DISABLES the stop-loss -
// the route treats stop_loss_method being present-in-body as "replace the
// whole group". Omitting a key still leaves it unchanged.
export type StrategyEdit = {
  name?: string;
  status?: StrategyStatus;
  // Unlike source_type itself, this IS editable after creation (external
  // strategies only) - see backend's StrategyUpdate docstring.
  source_rule_name?: string;
  horizon?: Horizon;
  instrument_type?: InstrumentType;
  rule_id?: string;
  stop_loss_method?: StopLossMethod | null;
  stop_loss_interval?: StopLossInterval | null;
  stop_loss_percent?: number | null;
  stop_loss_indicator_type?: StopLossIndicatorType | null;
  stop_loss_indicator_params?: StopLossIndicatorParams | null;
  target_percent?: number | null;
  trailing_stop_enabled?: boolean;
  // Condition | null (not just optional) - like fixed_lots below, an
  // explicit {exit_condition: null} clears it; omitting leaves it
  // unchanged. See the backend's update_strategy.
  exit_condition?: Condition | null;
  option_position_style?: OptionPositionStyle;
  option_strike_moneyness?: OptionStrikeMoneyness;
  option_sl_scope?: OptionSlScope;
  // number | null (not just optional) - unlike every other field here,
  // this one can be explicitly cleared back to auto-sizing via
  // {fixed_lots: null} - see the backend's update_strategy
  // (model_fields_set-based).
  fixed_lots?: number | null;
  use_margin?: boolean;
  contract_day_filter?: ContractDayFilter;
  segment?: Segment;
  duplicate_signal_policy?: DuplicateSignalPolicy;
  counter_signal_policy?: CounterSignalPolicy;
  // Omitted = unchanged; [] explicitly clears back to unrestricted - the
  // backend tells these apart via model_fields_set (same pattern
  // fixed_lots above already established for a nullable field).
  active_windows?: ActiveWindow[];
  active_weekdays?: Weekday[];
};

// A simulated paper trade from POST /rules/{id}/backtest - entry on a
// fresh signal, closed the same way execution's real position would be
// (stop-loss/target hit, square-off, or, with nothing more specific
// configured/triggered, the next opposite-direction signal). See the
// backend's app/domain/backtest.py simulate_trades for exactly how.
export type BacktestExitReason =
  | "stop_loss"
  | "target"
  | "square_off"
  | "opposite_signal"
  | "end_of_data"
  | "initial_stop_loss" // breakout rule only
  | "reversal_exit"; // breakout rule only

export type BacktestTrade = {
  entry_time: string;
  direction: "bullish" | "bearish";
  entry_price: number;
  exit_time: string;
  exit_price: number;
  exit_reason: BacktestExitReason;
  pnl: number;
};

export type TimeOfDayBucket = {
  start: string; // "HH:MM", clock-aligned (not market-open-aligned)
  end: string;
  trade_count: number;
  hypothetical_pnl: number;
  win_rate: number;
};

// Always all 7 entries, Mon-Sun order, even for a weekday with zero
// trades (e.g. Sat/Sun on an NSE rule) - see backend's _weekday_breakdown.
export type WeekdayBucket = {
  weekday: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  trade_count: number;
  hypothetical_pnl: number;
  win_rate: number;
};

// Every bar the rule's own condition matched, independent of whether it
// went on to open a trade (see backend's simulate_trades own
// matched_signals param) - traded=false + skip_reason explains why a
// match didn't become one of the `trades` above (regime_filter,
// outside_entry_window, weekday_excluded, past_square_off_time). A rule
// scanned while a previous trade was still open never reaches the
// condition check at all, so it can't appear here either - this only
// distinguishes "condition never fired" from "fired but got filtered."
export type SkipReason = "regime_filter" | "outside_entry_window" | "weekday_excluded" | "past_square_off_time";

export type MatchedSignal = {
  timestamp: string;
  direction: "bullish" | "bearish";
  traded: boolean;
  skip_reason: SkipReason | null;
};

export type BacktestResult = {
  trade_count: number;
  hypothetical_pnl: number;
  win_rate: number;
  max_drawdown: number;
  // Both only present when the request set time_bucket_minutes - see
  // backtestOverrides' own comment. weekday_breakdown rides the same
  // opt-in flag even though it has no "bucket size" of its own.
  time_of_day_breakdown?: TimeOfDayBucket[];
  weekday_breakdown?: WeekdayBucket[];
  trades: BacktestTrade[];
  matched_signals: MatchedSignal[];
};

// POST /rules/{id}/backtest for a universe-scoped rule - the same
// backtest run independently against every constituent and pooled:
// trade_count/hypothetical_pnl are totals across all of them,
// constituents_skipped counts ones that failed to resolve (delisted,
// not in market-data's cache, ...) rather than failing the whole
// request, by_symbol has the full per-constituent BacktestResult for
// drill-down. `pooled: true` distinguishes this from a plain BacktestResult.
export type UniverseBacktestResult = {
  pooled: true;
  trade_count: number;
  hypothetical_pnl: number;
  constituents_tested: number;
  constituents_skipped: number;
  by_symbol: Record<string, BacktestResult>;
};

// One row per param combination tried by POST /rules/{id}/backtest/grid -
// `error` is present instead of trade_count/hypothetical_pnl when that
// combination fails its own param validation (e.g. period=1) rather than
// being silently dropped. Rows arrive pre-sorted best (highest pnl) first.
export type GridBacktestRow = {
  params: Record<string, number>;
  // Present only when the request swept stop_loss_indicator_param_grid -
  // which stop-loss params (e.g. EMA period) this particular row used.
  stop_loss_indicator_params?: Record<string, number>;
  // Present only when the request swept stop_loss_percent_grid instead -
  // the alternative sweep dimension for stop_loss_method='percent'.
  stop_loss_percent?: number;
  trade_count?: number;
  hypothetical_pnl?: number;
  error?: string;
};

export type GridBacktestResult = {
  combinations_tested: number;
  results: GridBacktestRow[];
};

// Optional per-run overrides for POST /rules/{id}/backtest - a Rule alone
// carries no exit config/instrument_type/horizon (all Strategy-owned
// trading concepts, see Rule above); omitting the exit-config fields
// reproduces the backend's bare ExitConfig() defaults: opposite-signal/
// end-of-data exits only, no stop-loss/target.
export type RuleBacktestRequest = {
  instrument_type?: InstrumentType;
  horizon?: Horizon; // instrument_type='option' only - WEEK vs MONTH expiry choice
  stop_loss_method?: StopLossMethod;
  stop_loss_interval?: StopLossInterval;
  stop_loss_percent?: number;
  stop_loss_indicator_type?: StopLossIndicatorType;
  stop_loss_indicator_params?: StopLossIndicatorParams;
  target_percent?: number;
  trailing_stop_enabled?: boolean;
  square_off_time?: string;
  option_position_style?: OptionPositionStyle;
  option_strike_moneyness?: OptionStrikeMoneyness;
  // Opt-in - adds time_of_day_breakdown to the report, bucketed into
  // this many clock-aligned minutes (e.g. 60 = hourly). Omitted means no
  // breakdown at all, not just an empty one.
  time_bucket_minutes?: number;
  // "touch" (default) vs "close" - see StopLossConfirmation above.
  stop_loss_confirmation?: StopLossConfirmation;
  // Both-or-neither time-of-day window (HH:MM:SS, inclusive) a fresh
  // signal must fall in to open a trade at all - date range stays from/to
  // on the request itself, this is time-of-day only.
  entry_window_start?: string;
  entry_window_end?: string;
  // Which weekdays a fresh signal is allowed to open a trade on - same
  // "gates acceptance only" scope as entry_window_start/end, mirroring
  // Strategy's own active_weekdays. Omitted/empty means unrestricted.
  entry_weekdays?: Weekday[];
  // Per-run override, same shape as Strategy.exit_condition - closes a
  // trade the first bar this single Condition is true (exit_reason=
  // 'exit_condition'), after stop-loss/target. Applied only to spot/
  // future crossover/range_breakout/multi_condition backtests. interval
  // 'daily' is rejected (422), same as on a Strategy.
  exit_condition?: Condition;
};

export type RuleBacktestGridRequest = {
  param_grid: Record<string, number[]>;
  stop_loss_method?: StopLossMethod;
  stop_loss_interval?: StopLossInterval;
  stop_loss_percent?: number;
  stop_loss_indicator_type?: StopLossIndicatorType;
  stop_loss_indicator_params?: StopLossIndicatorParams;
  // A second, independent sweep dimension (stop_loss_method='indicator'
  // only) - e.g. {"period": [10, 15, 20]} to try multiple EMA periods, or
  // {"period": [7, 14], "multiplier": [2, 3]} for SuperTrend, against
  // every param_grid combination above (full cartesian product).
  stop_loss_indicator_param_grid?: Record<string, number[]>;
  // The same second sweep dimension, for stop_loss_method='percent'
  // instead - e.g. [1, 1.5, 2, 2.5] to try multiple SL percentages
  // against every param_grid combination above. Mutually exclusive with
  // stop_loss_indicator_param_grid in practice (one fixed stop_loss_method
  // per request).
  stop_loss_percent_grid?: number[];
  target_percent?: number;
  trailing_stop_enabled?: boolean;
  square_off_time?: string;
  // Same as RuleBacktestRequest's own copies.
  stop_loss_confirmation?: StopLossConfirmation;
  entry_window_start?: string;
  entry_window_end?: string;
  entry_weekdays?: Weekday[];
};

// A frozen snapshot (request + result, as they were at save time) of a
// completed POST /rules/{id}/backtest run - see backend's
// SavedBacktestCreate/Out docstrings for why it's a verbatim record, not
// a re-derived one, and why there's no update endpoint (saving again
// after editing a duplicated one always creates a new row).
export type SavedBacktestCreate = {
  name: string;
  from_date: string;
  to_date: string;
  request: RuleBacktestRequest;
  result: BacktestResult | UniverseBacktestResult;
};

// GET /rules/{rule_id}/saved-backtests' list view - no request/result (a
// pooled universe/symbol_list result can be large) - see
// SavedBacktestOut for the full detail, fetched on demand when loaded.
export type SavedBacktestSummary = {
  id: string;
  name: string;
  from_date: string;
  to_date: string;
  trade_count: number | null;
  hypothetical_pnl: number | null;
  // Only present for a plain (non-pooled) single-symbol result - null for
  // a pooled universe/symbol_list save (no top-level equivalent there).
  win_rate: number | null;
  max_drawdown: number | null;
  created_at: string;
};

export type SavedBacktestOut = {
  id: string;
  rule_id: string;
  name: string;
  from_date: string;
  to_date: string;
  request: RuleBacktestRequest;
  result: BacktestResult | UniverseBacktestResult;
  created_at: string;
};

export type ProviderSignal = {
  signal_id: string;
  strategy_id: string;
  symbol: string;
  exchange: string;
  action: "BUY" | "SELL";
  price: number;
  source: string;
  received_at: string;
  horizon: string | null;
  instrument_type: string | null;
  status: string | null;
  rejection_reason: string | null;
};

// Port is build-time configurable (VITE_SIGNAL_ENGINE_PORT - see
// Dockerfile's ARG/ENV and docker-compose.yml's build args) so a
// port-shifted container group (e.g. a separate local test stack)
// actually calls its OWN backend instead of a hardcoded dev port.
// Default matches dev's port, so `npm run dev` with no .env still works
// exactly as before. One backend/one base URL since the signal-engine
// merge (2026-08-28, see docs/architecture.md) - signal-generation and
// signal-processing used to be two separate services/ports here.
const SIGNAL_ENGINE_PORT = import.meta.env.VITE_SIGNAL_ENGINE_PORT ?? "8000";
const MARKET_DATA_PORT = import.meta.env.VITE_MARKET_DATA_PORT ?? "8001";

const API_BASE_URL = `http://${location.hostname}:${SIGNAL_ENGINE_PORT}`;
// market-data's API, read directly from the browser (CORS-enabled) - just
// for the universe picker below.
const MARKET_DATA_BASE_URL = `http://${location.hostname}:${MARKET_DATA_PORT}`;

// FastAPI's own error body shape is {"detail": "..."} - a specific reason
// (e.g. DELETE /rules/{id}'s own "cannot delete rule - 2 strategies still
// reference it") is far more useful to show than the bare status code
// alone, which is all callers saw before this existed. Falls back to the
// status code if the body isn't JSON or has no `detail` (a non-FastAPI
// failure, e.g. a proxy/network-level error page). A 422 from FastAPI's
// own request-body/query validation (as opposed to one raised explicitly
// via HTTPException elsewhere in a route) shapes `detail` as a LIST of
// {loc, msg} objects instead of a string - e.g. an out-of-range enum
// value or a field that failed a Pydantic type check - so that shape is
// handled here too, rather than silently falling through to the
// uninformative "HTTP 422" every caller used to see for it.
async function extractErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.detail === "string") return body.detail;
    if (body && Array.isArray(body.detail)) {
      const messages = body.detail
        .map((e: { loc?: unknown[]; msg?: string }) => {
          const field = Array.isArray(e.loc) ? e.loc.filter((p) => p !== "body").join(".") : null;
          return field && e.msg ? `${field}: ${e.msg}` : e.msg;
        })
        .filter(Boolean);
      if (messages.length > 0) return messages.join("; ");
    }
  } catch {
    // not JSON - fall through to the status code below
  }
  return `HTTP ${res.status}`;
}

async function asJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${what} failed: ${await extractErrorDetail(res)}`);
  }
  return res.json();
}

export async function fetchIndicators(): Promise<Indicator[]> {
  const res = await fetch(`${API_BASE_URL}/indicators`);
  return asJson(res, "GET /indicators");
}

export async function createIndicator(payload: IndicatorCreate): Promise<Indicator> {
  const res = await fetch(`${API_BASE_URL}/indicators`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "POST /indicators");
}

export async function updateIndicator(id: string, payload: IndicatorUpdate): Promise<Indicator> {
  const res = await fetch(`${API_BASE_URL}/indicators/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "PATCH /indicators/{id}");
}

export async function deleteIndicator(id: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/indicators/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`DELETE /indicators/{id} failed: ${await extractErrorDetail(res)}`);
  }
}

export async function fetchWatchlists(): Promise<Watchlist[]> {
  const res = await fetch(`${API_BASE_URL}/watchlists`);
  return asJson(res, "GET /watchlists");
}

export async function createWatchlist(payload: WatchlistCreate): Promise<Watchlist> {
  const res = await fetch(`${API_BASE_URL}/watchlists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "POST /watchlists");
}

export async function updateWatchlist(id: string, payload: WatchlistUpdate): Promise<Watchlist> {
  const res = await fetch(`${API_BASE_URL}/watchlists/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "PUT /watchlists/{id}");
}

export async function deleteWatchlist(id: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/watchlists/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`DELETE /watchlists/{id} failed: ${await extractErrorDetail(res)}`);
  }
}

export async function fetchRules(): Promise<Rule[]> {
  const res = await fetch(`${API_BASE_URL}/rules`);
  return asJson(res, "GET /rules");
}

export async function createRule(payload: RuleCreate): Promise<Rule> {
  const res = await fetch(`${API_BASE_URL}/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "POST /rules");
}

export async function updateRule(id: string, payload: RuleUpdate): Promise<Rule> {
  const res = await fetch(`${API_BASE_URL}/rules/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "PATCH /rules/{id}");
}

export async function deleteRule(id: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/rules/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`DELETE /rules/{id} failed: ${await extractErrorDetail(res)}`);
  }
}

export async function backtestRule(
  id: string,
  from: string,
  to: string,
  overrides: RuleBacktestRequest = {},
): Promise<BacktestResult | UniverseBacktestResult> {
  const params = new URLSearchParams({ from, to });
  const res = await fetch(`${API_BASE_URL}/rules/${id}/backtest?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(overrides),
  });
  return asJson(res, "POST /rules/{id}/backtest");
}

export async function listSavedBacktests(ruleId: string): Promise<SavedBacktestSummary[]> {
  const res = await fetch(`${API_BASE_URL}/rules/${ruleId}/saved-backtests`);
  return asJson(res, "GET /rules/{id}/saved-backtests");
}

export async function createSavedBacktest(ruleId: string, payload: SavedBacktestCreate): Promise<SavedBacktestOut> {
  const res = await fetch(`${API_BASE_URL}/rules/${ruleId}/saved-backtests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "POST /rules/{id}/saved-backtests");
}

export async function getSavedBacktest(id: string): Promise<SavedBacktestOut> {
  const res = await fetch(`${API_BASE_URL}/saved-backtests/${id}`);
  return asJson(res, "GET /saved-backtests/{id}");
}

export async function deleteSavedBacktest(id: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/saved-backtests/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`DELETE /saved-backtests/{id} failed: ${await extractErrorDetail(res)}`);
  }
}

// Sweeps the rule's referenced indicator's params (e.g. RSI's period/
// sma_period) over candidate value lists and reports naive P&L per
// combination - does NOT mutate the underlying Indicator, see api docstring.
export async function backtestRuleGrid(
  id: string,
  from: string,
  to: string,
  paramGrid: Record<string, number[]>,
  overrides: Omit<RuleBacktestGridRequest, "param_grid"> = {},
): Promise<GridBacktestResult> {
  const params = new URLSearchParams({ from, to });
  const res = await fetch(`${API_BASE_URL}/rules/${id}/backtest/grid?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...overrides, param_grid: paramGrid }),
  });
  return asJson(res, "POST /rules/{id}/backtest/grid");
}

export async function fetchStrategies(sourceType?: SourceType): Promise<Strategy[]> {
  const params = sourceType ? `?source_type=${sourceType}` : "";
  const res = await fetch(`${API_BASE_URL}/strategies${params}`);
  return asJson(res, "GET /strategies");
}

export async function createStrategy(payload: StrategyCreate): Promise<Strategy> {
  const res = await fetch(`${API_BASE_URL}/strategies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "POST /strategies");
}

export async function updateStrategy(id: string, payload: StrategyEdit): Promise<Strategy> {
  const res = await fetch(`${API_BASE_URL}/strategies/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "PATCH /strategies/{id}");
}

export async function deleteStrategy(id: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/strategies/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`DELETE /strategies/{id} failed: ${await extractErrorDetail(res)}`);
  }
}

// POST /strategies/{id}/backtest-signals - backtests an externally-
// supplied (symbol, timestamp) signal list (e.g. a Chartink alert-history
// CSV export, which has no price/action columns of its own) against a
// GRID of exit configurations, to find which stop-loss/target/trailing
// setup would have worked best - the opposite of /rules/{id}/backtest
// (which derives entries from a Rule's own condition and holds exit
// config fixed). See systems/signal-engine/backend's
// app/domain/generation/external_backtest.py.
export type ExternalBacktestSignal = {
  symbol: string;
  timestamp: string; // ISO
};

// StopLossInterval (above) deliberately excludes 'daily' - it's shared
// with LIVE stop-loss checking, which polls an intraday-only candle feed
// that can never serve a daily bar. This backtest reads HISTORICAL
// candles instead (same as `interval` already does for entries), so
// 'daily' works fine here - excluding it would make backtesting a swing/
// positional CSV against a daily-chart indicator impossible.
export type BacktestStopLossInterval = StopLossInterval | "daily";

export type ExternalBacktestRequest = {
  signals: ExternalBacktestSignal[];
  direction: "bullish" | "bearish";
  interval: Interval;
  // Only one of these three is ever populated per request - which one
  // matches stop_loss_method. 'previous_candle' has no per-combo value to
  // sweep at all (stop_loss_interval alone decides it).
  stop_loss_method?: "previous_candle" | "percent" | "indicator";
  stop_loss_interval?: BacktestStopLossInterval;
  stop_loss_percent_grid?: number[];
  stop_loss_indicator_type?: string;
  stop_loss_indicator_param_grid?: Record<string, number[]>;
  // null alongside real values means "also try no target at all" - a
  // real grid point, not an omitted field.
  target_percent_grid?: (number | null)[];
  trailing_grid?: boolean[];
  square_off_time?: string;
};

export type ExternalBacktestCombo = {
  stop_loss_value: number | Record<string, number> | null;
  target_percent: number | null;
  trailing_stop_enabled: boolean;
  trade_count: number;
  hypothetical_pnl: number;
  win_rate: number;
  max_drawdown: number;
};

// One symbol market-data couldn't resolve or fetch candle history for -
// `reason` distinguishes a too-wide date range (this symbol's own earliest
// CSV signal is older than the data provider's intraday-history window)
// from a resolve failure or an empty result, rather than every skip
// looking the same.
export type ExternalBacktestSkippedSymbol = {
  symbol: string;
  reason: string;
};

export type ExternalBacktestResponse = {
  signal_count: number;
  symbols_tested: number;
  symbols_skipped: ExternalBacktestSkippedSymbol[];
  results: ExternalBacktestCombo[];
};

export async function backtestStrategySignals(
  strategyId: string,
  payload: ExternalBacktestRequest,
  to?: string,
): Promise<ExternalBacktestResponse> {
  const params = to ? `?${new URLSearchParams({ to })}` : "";
  const res = await fetch(`${API_BASE_URL}/strategies/${strategyId}/backtest-signals${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "POST /strategies/{id}/backtest-signals");
}

// POST /strategies/{id}/backtest-signals/trades - the single-exit-config
// drill-down sibling of backtestStrategySignals above: same signals/
// direction/interval, but ONE exit config (not a grid), so the individual
// simulated trades behind one ExternalBacktestCombo row can be inspected.
export type ExternalBacktestTradeRequest = {
  signals: ExternalBacktestSignal[];
  direction: "bullish" | "bearish";
  interval: Interval;
  stop_loss_method?: "previous_candle" | "percent" | "indicator";
  stop_loss_interval?: BacktestStopLossInterval;
  stop_loss_percent?: number;
  stop_loss_indicator_type?: string;
  stop_loss_indicator_params?: Record<string, number>;
  target_percent?: number | null;
  trailing_stop_enabled?: boolean;
  square_off_time?: string;
};

export type ExternalBacktestTrade = {
  symbol: string;
  entry_time: string;
  direction: string;
  entry_price: number;
  exit_time: string;
  exit_price: number;
  exit_reason: string;
  pnl: number;
};

export type ExternalBacktestTradeResponse = {
  signal_count: number;
  symbols_tested: number;
  symbols_skipped: ExternalBacktestSkippedSymbol[];
  trade_count: number;
  hypothetical_pnl: number;
  win_rate: number;
  max_drawdown: number;
  trades: ExternalBacktestTrade[];
};

export async function backtestStrategySignalsTrades(
  strategyId: string,
  payload: ExternalBacktestTradeRequest,
  to?: string,
): Promise<ExternalBacktestTradeResponse> {
  const params = to ? `?${new URLSearchParams({ to })}` : "";
  const res = await fetch(`${API_BASE_URL}/strategies/${strategyId}/backtest-signals/trades${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "POST /strategies/{id}/backtest-signals/trades");
}

export async function fetchSignalsForStrategy(strategyId: string, limit = 20): Promise<ProviderSignal[]> {
  const params = new URLSearchParams({ strategy_id: strategyId, limit: String(limit) });
  const res = await fetch(`${API_BASE_URL}/signals?${params}`);
  return asJson(res, "GET /signals?strategy_id=...");
}

// Global feed (no strategy_id filter - GET /signals's own param is
// Optional) - used by SignalNotifier.tsx to watch for a fresh signal from
// ANY strategy, not just whichever one's row happens to be expanded.
export async function fetchRecentSignals(limit = 20): Promise<ProviderSignal[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await fetch(`${API_BASE_URL}/signals?${params}`);
  return asJson(res, "GET /signals");
}

// Manually induces a signal for a strategy - a thin wrapper around
// signal-processing's own generic POST /signals (the exact same ingest
// path a real webhook/in-house-engine signal goes through, no bypass of
// resolution/conflict-policy logic). `exchange` comes from the strategy's
// own `segment` (see Strategy.rule's own segment vs a Strategy's segment
// distinction in api.ts - this uses the STRATEGY's, since that's what
// determines the actual trade). source='manual' tags it so it's always
// visibly distinguishable from a real provider/engine signal in the
// signals list.
export async function sendManualSignal(payload: {
  strategy_id: string;
  symbol: string;
  exchange: Segment;
  action: "BUY" | "SELL";
  price: number;
}): Promise<{ signal_id: string; status: string }> {
  const res = await fetch(`${API_BASE_URL}/signals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, source: "manual", source_meta: {} }),
  });
  return asJson(res, "POST /signals");
}

// Full-featured GET /signals for the Signals tab (SignalsPage.tsx) -
// date/segment filtering happens client-side there, this just supports
// the ?signal_id= deep-link mode fetchSignalsForStrategy/fetchRecentSignals
// above don't need. ProviderSignal (above) is the exact same shape
// signal-processing's own frontend used to call `ResolvedSignal` before
// the signal-engine merge (2026-08-28) - one type, not two, now that it's
// one frontend.
export async function fetchSignals(opts: { limit?: number; signalId?: string } = {}): Promise<ProviderSignal[]> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
  if (opts.signalId) params.set("signal_id", opts.signalId);
  const res = await fetch(`${API_BASE_URL}/signals?${params}`);
  return asJson(res, "GET /signals");
}

export type ClearSignalsResult = {
  signals_deleted: number;
  resolved_orders_deleted: number;
  raw_payloads_deleted: number;
};

export async function clearSignals(): Promise<ClearSignalsResult> {
  const res = await fetch(`${API_BASE_URL}/signals`, { method: "DELETE" });
  return asJson(res, "DELETE /signals");
}

// NSE index-constituent universe keys (e.g. "NIFTYBANK") - populates the
// universe picker when underlying_type='universe'. market-data owns this
// list (see its app/providers/nse_indices.py).
export async function fetchUniverses(): Promise<string[]> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/instruments/universes`);
  const data = await asJson<{ universes: string[] }>(res, "GET /instruments/universes");
  return data.universes;
}

// Every live Delta Exchange India perpetual future symbol (e.g. "BTCUSD") -
// backs the CRYPTO symbol picker on the Manual tab, so a real, currently-
// tradeable symbol is chosen instead of typed free-hand. CRYPTO-only -
// NSE/MCX symbols stay a free-text input, see ManualTab.tsx.
export async function fetchCryptoSymbols(): Promise<string[]> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/instruments/crypto-symbols`);
  const data = await asJson<{ symbols: string[] }>(res, "GET /instruments/crypto-symbols");
  return data.symbols;
}

// Current market price for a symbol - used by the manual test-signal form
// (App.tsx's handleSendSignal) when the price field is left blank, same
// direct-from-browser pattern as fetchUniverses above.
export async function fetchLtp(exchange: string, symbol: string): Promise<number> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/quotes/ltp?${new URLSearchParams({ exchange, symbol })}`);
  const data = await asJson<{ ltp: number }>(res, `GET /quotes/ltp (${exchange}/${symbol})`);
  return data.ltp;
}

// A logical underlying (e.g. "GOLDM", "BANKNIFTY", or a plain equity like
// "RELIANCE") isn't always a directly-quotable Dhan/Delta symbol on its
// own - MCX futures roll monthly and are keyed by their expiry-coded
// contract (e.g. "GOLDM-04Sep2026-FUT"), and NSE index futures resolve to
// a DIFFERENT chart vs trade symbol (chart the spot index, trade the
// active-month future). chart_symbol/chart_exchange is what to quote a
// live "underlying" price against; trade_symbol/trade_exchange (+
// lot_size) is what execution actually resolves/sizes a future order
// against server-side (position_manager.py's own open_manual_position -
// same endpoint, same reasoning, see its 2026-08-14 BANKNIFTY fix note).
export type ResolvedUnderlying = {
  chart_symbol: string;
  chart_exchange: string;
  trade_symbol: string;
  trade_exchange: string;
  lot_size: number;
  expiry: string | null;
};

export async function resolveUnderlying(segment: string, underlying: string): Promise<ResolvedUnderlying> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/instruments/resolve?${new URLSearchParams({ segment, underlying })}`);
  return asJson<ResolvedUnderlying>(res, `GET /instruments/resolve (${segment}/${underlying})`);
}

// Real per-symbol lot multiplier (1 for instruments with no lot concept;
// a real fraction for Delta Exchange India CRYPTO perpetuals, e.g.
// BTCUSD=0.001) - used by the Manual tab's order-value preview and
// "Lots" quantity field for CRYPTO futures, matching execution's own
// lot-based sizing (see docs/architecture.md).
export async function fetchLotSize(exchange: string, symbol: string): Promise<number> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/instruments/lot-size?${new URLSearchParams({ exchange, symbol })}`);
  const data = await asJson<{ lot_size: number }>(res, `GET /instruments/lot-size (${exchange}/${symbol})`);
  return data.lot_size;
}

// Available expiries for an NSE/MCX underlying, nearest first - backs the
// OI Summary page's Expiry picker. NOT used by the Manual tab (removed
// from there 2026-08-14 - see createManualOptionGroup's own comment,
// this call proved slow/unreliable enough to leave a blocking dropdown
// stuck on "Loading..." indefinitely); the OI Summary page isn't on any
// order-placement critical path, so the same slowness is just a loading
// spinner there, not a stuck trade flow.
export async function fetchOptionExpiries(exchange: string, symbol: string): Promise<string[]> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/options/expiries?${new URLSearchParams({ exchange, symbol })}`);
  const data = await asJson<{ expiries: string[] }>(res, "GET /options/expiries");
  return data.expiries;
}

// One CE or PE leg's OI-analysis figures at one strike - oi_change_5m/15m
// are null until market-data's in-memory OI history buffer has a sample
// old enough to diff against (see DhanProvider.get_oi_changes's own
// comment) - typically null for the first ~5/15 minutes after that
// backend last restarted.
export type OiBuildup = "long_buildup" | "short_buildup" | "short_covering" | "long_unwinding";

export type OiSummaryLeg = {
  oi: number;
  oi_change_5m: number | null;
  oi_change_15m: number | null;
  implied_volatility: number;
  last_price: number;
  volume: number;
  top_bid_price: number;
  top_ask_price: number;
  moneyness: "ITM" | "ATM" | "OTM";
  price_change_15m: number | null;
  buildup: OiBuildup | null;
};

export type OiSummaryStrike = {
  strike: number;
  call: OiSummaryLeg | null;
  put: OiSummaryLeg | null;
};

// GET /options/oi-summary response - PCR (total put OI / total call OI),
// chain-wide OI-change totals, ATM IV, and the full per-strike breakdown.
export type OiSummary = {
  underlying_symbol: string;
  underlying_exchange: string;
  expiry: string;
  underlying_last_price: number;
  total_call_oi: number;
  total_put_oi: number;
  pcr: number | null;
  total_call_oi_change_5m: number | null;
  total_put_oi_change_5m: number | null;
  total_call_oi_change_15m: number | null;
  total_put_oi_change_15m: number | null;
  atm_call_iv: number | null;
  atm_put_iv: number | null;
  strikes: OiSummaryStrike[];
};

export async function fetchOiSummary(exchange: string, symbol: string, expiry: string): Promise<OiSummary> {
  const res = await fetch(
    `${MARKET_DATA_BASE_URL}/options/oi-summary?${new URLSearchParams({ exchange, symbol, expiry })}`,
  );
  return asJson(res, "GET /options/oi-summary");
}

// Backs the Rules page's backtest form - what date range is actually
// usable, per market-data's GET /candles/availability. NSE/MCX (Dhan)
// report a fixed `max_days_per_request` (a hard per-call cap - real
// history goes back years, but this codebase doesn't chunk around it for
// spot/future backtests); CRYPTO (Delta) reports a live-probed
// `earliest_available_date` instead (no per-call cap, but real depth is
// shallower and grows over time) - exactly one of the two is ever set.
// See market-data's app/domain/models.py DataAvailability for the full
// rationale.
export type DataAvailability = {
  exchange: string;
  symbol: string;
  interval: string;
  max_days_per_request: number | null;
  earliest_available_date: string | null;
  note: string;
};

export async function fetchDataAvailability(exchange: string, symbol: string, interval: string): Promise<DataAvailability> {
  const res = await fetch(
    `${MARKET_DATA_BASE_URL}/candles/availability?${new URLSearchParams({ exchange, symbol, interval })}`,
  );
  return asJson<DataAvailability>(res, `GET /candles/availability (${exchange}/${symbol}/${interval})`);
}

// Whether GET /candles/history's own in-memory cache currently holds a
// live entry for this exact (exchange, symbol, interval, from, to) -
// same direct-from-browser call as fetchDataAvailability above (segment/
// underlying passed straight through, no signal-generation proxy - the
// provider resolves the symbol internally either way).
export type CandleCacheStatus = {
  cached: boolean;
  fetched_at: string | null;
};

export async function fetchCandleCacheStatus(
  exchange: string,
  symbol: string,
  interval: string,
  from: string,
  to: string,
): Promise<CandleCacheStatus> {
  const res = await fetch(
    `${MARKET_DATA_BASE_URL}/candles/cache-status?${new URLSearchParams({ exchange, symbol, interval, from, to })}`,
  );
  return asJson<CandleCacheStatus>(res, `GET /candles/cache-status (${exchange}/${symbol}/${interval})`);
}

// Evicts that one cache entry - a manual "force refresh" so the next
// backtest run for this exact symbol/interval/range genuinely re-fetches
// from the provider instead of serving the cached copy.
export async function clearCandleCache(exchange: string, symbol: string, interval: string, from: string, to: string): Promise<void> {
  const res = await fetch(
    `${MARKET_DATA_BASE_URL}/candles/cache/clear?${new URLSearchParams({ exchange, symbol, interval, from, to })}`,
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(`POST /candles/cache/clear failed: ${await extractErrorDetail(res)}`);
  }
}

// ---------------------------------------------------------------------
// Manual tab (ManualTab.tsx) - execution's own backend, read/written
// directly from the browser (CORS-enabled), same direct-from-browser
// cross-system pattern as market-data/signal-processing above - NOT
// execution's own frontend's /api proxy convention. Both spot/future
// (createManualPosition) AND option (createManualOptionGroup) orders
// bypass signal-generation/signal-processing entirely as of 2026-08-14 -
// no auto-provisioned Strategy for either anymore. Options resolve their
// own legs directly in execution (see open_manual_option_group there),
// with the user picking a real expiry via fetchExpiries below instead of
// one being auto-chosen.
// ---------------------------------------------------------------------

const EXECUTION_PORT = import.meta.env.VITE_EXECUTION_PORT ?? "8002";
const EXECUTION_BASE_URL = `http://${location.hostname}:${EXECUTION_PORT}`;

export type ManualPosition = {
  id: string;
  signal_id: string;
  // null = manually opened (Manual tab), bypassing Strategy entirely.
  strategy_id: string | null;
  symbol: string;
  exchange: string;
  segment: Segment;
  action: "BUY" | "SELL";
  horizon: string;
  instrument_type: string;
  quantity: number | null;
  entry_price: number;
  entry_time: string;
  exit_price: number | null;
  exit_time: string | null;
  pnl: number | null;
  live_price: number | null;
  unrealized_pnl: number | null;
  status: "OPEN" | "CLOSED" | "REJECTED";
  rejection_reason: string | null;
  stop_loss_price: number | null;
  target_price: number | null;
  trailing_stop_enabled: boolean;
  // Set when stop_loss_price came from a method (percent/previous_candle/
  // indicator) rather than a flat caller-supplied price - see
  // StopLossTab's own "Trail SL" checkbox. null for a fixed stop_loss_price
  // (or no stop-loss at all).
  stop_loss_method: StopLossMethod | null;
  stop_loss_interval: StopLossInterval | null;
  stop_loss_percent: number | null;
  stop_loss_indicator_type: StopLossIndicatorType | null;
  stop_loss_indicator_params: StopLossIndicatorParams | null;
  exit_reason: "square_off" | "stop_loss" | "target" | "exit_condition" | "manual" | "counter_signal" | null;
  square_off_time: string | null;
  option_group_id: string | null;
  // Trade discipline checklist (Manual tab only) - null for every
  // Strategy-driven position, see docs/architecture.md § 'Trade
  // discipline checklist'.
  plan_checklist: ChecklistAnswer[] | null;
  reviewed_at: string | null;
  review_violation: boolean | null;
  review_notes: string | null;
  review_checklist: ChecklistAnswer[] | null;
  // Which of ManualTab.tsx's two entry modes placed this trade - null for
  // every Strategy-driven position (added 2026-08-26, for future
  // performance review - see execution.positions.order_type's own comment).
  order_type: "market" | "limit" | null;
};

export type ManualOptionLeg = {
  id: string;
  symbol: string;
  action: "BUY" | "SELL";
  quantity: number | null;
  entry_price: number;
  exit_price: number | null;
  pnl: number | null;
  status: string;
  stop_loss_price: number | null;
  target_price: number | null;
  // with_live_pnl=true only (fetchOptionGroups' own withLivePnl param) -
  // this leg's own live premium/P&L, not just the group's combined
  // figure. Always null from createManualOptionGroup's response (POST
  // has no with_live_pnl concept) - populates on the next poll tick.
  live_price?: number | null;
  unrealized_pnl?: number | null;
};

export type ManualOptionGroup = {
  id: string;
  signal_id: string;
  // null = manually opened (Manual tab), bypassing Strategy entirely -
  // same as ManualPosition.strategy_id above.
  strategy_id: string | null;
  underlying_symbol: string;
  exchange: string;
  segment: Segment;
  strategy_type: string;
  action: "BUY" | "SELL";
  horizon: string;
  quantity: number | null;
  net_debit: number | null;
  combined_stop_loss_price: number | null;
  combined_target_price: number | null;
  sl_scope: OptionSlScope;
  live_combined_price: number | null;
  unrealized_pnl: number | null;
  status: "OPEN" | "CLOSED" | "REJECTED";
  rejection_reason: string | null;
  exit_reason: string | null;
  exit_time: string | null;
  pnl: number | null;
  square_off_time: string | null;
  // Trade discipline checklist (Manual tab only) - same meaning as
  // ManualPosition's own copies above.
  plan_checklist: ChecklistAnswer[] | null;
  reviewed_at: string | null;
  review_violation: boolean | null;
  review_notes: string | null;
  review_checklist: ChecklistAnswer[] | null;
  // Which of ManualTab.tsx's two entry modes placed this trade - null for
  // every Strategy-driven group, same meaning as ManualPosition's own
  // copy above.
  order_type: "market" | "limit" | null;
  legs: ManualOptionLeg[];
};

// POST /positions/manual (execution) - spot/future only, bypasses
// signal-generation/signal-processing entirely. Always returns 200 with
// whatever status resulted (OPEN or REJECTED) - a rejection is a
// legitimate persisted outcome here, not an HTTP error, same convention
// the whole resolved-order pipeline already uses.
// Two mutually exclusive ways to protect the position (see execution's own
// ManualPositionCreate): a flat stop_loss_price, OR stop_loss_method + its
// own sibling fields ("Trail SL" checkbox in the frontend) - reuses the
// same StopLossMethod/StopLossInterval/StopLossIndicatorType/
// StopLossIndicatorParams types the Strategy form's own stop-loss fields
// already use above, since it's the identical concept now reachable from
// the Manual tab too.
export type ManualStopLossConfig = {
  stop_loss_price?: number;
  stop_loss_method?: StopLossMethod;
  stop_loss_interval?: StopLossInterval;
  stop_loss_percent?: number;
  stop_loss_indicator_type?: StopLossIndicatorType;
  stop_loss_indicator_params?: StopLossIndicatorParams;
  trailing_stop_enabled?: boolean;
};

// Trade discipline checklist (Manual tab only, intraday-focused) - see
// docs/architecture.md § 'Trade discipline checklist'. ChecklistItem is
// the user-editable master list (GET/POST/PUT/DELETE /checklist-items),
// split by `phase` into 'plan' (pre-trade, gates the Add button -
// ManualTab.tsx filters to this client-side for each row's checkboxes),
// 'review' (post-trade, self-assessed in the review banner - filtered to
// that client-side too), and 'day' (once per calendar day PER SEGMENT,
// via fetchDailyChecklist/submitDailyChecklist below - e.g. "no major
// news today" doesn't need re-confirming on every single order).
// `segments`: which segment(s) this item applies to - empty = every
// segment (e.g. OI change is NSE-only, no OI data for MCX/CRYPTO on this
// platform's providers) - ManualTab.tsx filters every checklist render by
// `segments.length === 0 || segments.includes(row.segment)`.
// ChecklistAnswer is the {label, checked} snapshot sent with each manual
// order (plan_checklist) or review submission (ReviewSubmitPayload.
// checklist) and stored verbatim on the resulting position/option group.
export type ChecklistPhase = "plan" | "review" | "day";

export type ChecklistItem = {
  id: string;
  label: string;
  phase: ChecklistPhase;
  segments: Segment[];
  sort_order: number;
  active: boolean;
};

export type ChecklistAnswer = {
  label: string;
  checked: boolean;
};

export async function fetchChecklistItems(activeOnly = false): Promise<ChecklistItem[]> {
  const query = activeOnly ? "?active_only=true" : "";
  const res = await fetch(`${EXECUTION_BASE_URL}/checklist-items${query}`);
  return asJson(res, "GET /checklist-items");
}

export async function createChecklistItem(label: string, phase: ChecklistPhase, segments: Segment[] = []): Promise<ChecklistItem> {
  const res = await fetch(`${EXECUTION_BASE_URL}/checklist-items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, phase, segments }),
  });
  return asJson(res, "POST /checklist-items");
}

export async function updateChecklistItem(
  id: string,
  payload: { label?: string; phase?: ChecklistPhase; segments?: Segment[]; sort_order?: number; active?: boolean },
): Promise<ChecklistItem> {
  const res = await fetch(`${EXECUTION_BASE_URL}/checklist-items/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "PUT /checklist-items/{id}");
}

export async function deleteChecklistItem(id: string): Promise<void> {
  const res = await fetch(`${EXECUTION_BASE_URL}/checklist-items/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`DELETE /checklist-items/{id} failed: ${await extractErrorDetail(res)}`);
  }
}

// One row per segment (execution.accounts) - the Manual tab's own
// "Checklist & Risk Settings" sub-page reads/writes risk_per_trade_pct,
// min_reward_risk_ratio, and enforce_risk_based_lots from here directly
// (same cross-system pattern the rest of the Manual tab already uses to
// call execution). capital_per_trade/leverage/square_off_time also come
// back but aren't shown there - those stay execution AccountsPage.tsx's
// own concern.
export type Account = {
  segment: Segment;
  starting_balance: number;
  current_balance: number;
  capital_per_trade: number;
  risk_per_trade_pct: number;
  min_reward_risk_ratio: number;
  // Spot/future manual orders only - see ManualTab.tsx's own
  // computeRiskBasedLots/riskLotsEnforced for what this actually drives
  // (a purely client-side Lot auto-fill + lock, no server-side
  // enforcement of its own).
  enforce_risk_based_lots: boolean;
  leverage: number;
  square_off_time: string | null;
  updated_at: string;
};

export async function fetchAccounts(): Promise<Account[]> {
  const res = await fetch(`${EXECUTION_BASE_URL}/accounts`);
  return asJson(res, "GET /accounts");
}

export async function updateAccount(
  segment: Segment,
  update: Partial<Pick<Account, "risk_per_trade_pct" | "min_reward_risk_ratio" | "enforce_risk_based_lots">>,
): Promise<Account> {
  const res = await fetch(`${EXECUTION_BASE_URL}/accounts/${segment}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  return asJson(res, "PUT /accounts/{segment}");
}

// GET /daily-checklist?segment=X - answers/submitted_at are null if
// nothing's been submitted yet today for this segment (the gate is
// still active in that case - see execution's own
// find_missing_daily_checklist). `notes`: ONE free-text observation for
// the whole (day, segment) submission, not per item.
export type DailyChecklist = {
  log_date: string;
  segment: Segment;
  answers: ChecklistAnswer[] | null;
  notes: string | null;
  submitted_at: string | null;
};

export async function fetchDailyChecklist(segment: Segment): Promise<DailyChecklist> {
  const res = await fetch(`${EXECUTION_BASE_URL}/daily-checklist?${new URLSearchParams({ segment })}`);
  return asJson(res, "GET /daily-checklist");
}

// Upserts today's (server-computed date, segment) row - answered once,
// editable the rest of that same day.
export async function submitDailyChecklist(segment: Segment, answers: ChecklistAnswer[], notes?: string): Promise<DailyChecklist> {
  const res = await fetch(`${EXECUTION_BASE_URL}/daily-checklist`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segment, answers, notes }),
  });
  return asJson(res, "PUT /daily-checklist");
}

// One check-in/check-out SESSION INSTANCE - a (log_date, segment) can
// have several across a day (checked in, broke for lunch, checked in
// again). checked_out_at null means this is the currently open one for
// its (log_date, segment); check-in refuses to start a second one while
// one's already open (returns that same open row instead), check-out
// 409s if none is open.
export type TradingSession = {
  id: string;
  log_date: string;
  segment: Segment;
  checked_in_at: string;
  checked_out_at: string | null;
};

export async function fetchTradingSessions(segment?: Segment): Promise<TradingSession[]> {
  const qs = segment ? `?${new URLSearchParams({ segment })}` : "";
  const res = await fetch(`${EXECUTION_BASE_URL}/trading-sessions${qs}`);
  return asJson(res, "GET /trading-sessions");
}

export async function checkInTradingSession(segment: Segment): Promise<TradingSession> {
  const res = await fetch(`${EXECUTION_BASE_URL}/trading-sessions/check-in?${new URLSearchParams({ segment })}`, {
    method: "POST",
  });
  return asJson(res, "POST /trading-sessions/check-in");
}

export async function checkOutTradingSession(segment: Segment): Promise<TradingSession> {
  const res = await fetch(`${EXECUTION_BASE_URL}/trading-sessions/check-out?${new URLSearchParams({ segment })}`, {
    method: "POST",
  });
  return asJson(res, "POST /trading-sessions/check-out");
}

// The platform-wide post-trade review gate - non-null `pending` means
// every ManualTab.tsx row's Add button should stay disabled until the
// matching PUT .../review is submitted. See find_pending_manual_review's
// own docstring (position_manager.py) for what "earliest" means across
// positions/option_position_groups.
export type PendingReview = {
  kind: "position" | "option_group";
  id: string;
  symbol: string;
  segment: Segment;
  action: "BUY" | "SELL";
  pnl: number | null;
  exit_time: string | null;
  // Total unreviewed manual trades across both positions/option_groups,
  // not just this one (the earliest) - the frontend's own reminder
  // banner shows just this count now, see its own comment.
  pending_count: number;
};

export async function fetchPendingReview(): Promise<PendingReview | null> {
  const res = await fetch(`${EXECUTION_BASE_URL}/manual-trades/pending-review`);
  const data = await asJson<{ pending: PendingReview | null }>(res, "GET /manual-trades/pending-review");
  return data.pending;
}

export type ReviewSubmitPayload = {
  violation: boolean;
  notes?: string;
  accepted_loss?: boolean;
  // 'review'-phase items' self-assessed {label, checked} snapshot - not
  // required to be present or fully checked, see execution's own
  // ReviewSubmit.checklist comment.
  checklist?: ChecklistAnswer[];
};

export async function submitPositionReview(positionId: string, payload: ReviewSubmitPayload): Promise<ManualPosition> {
  const res = await fetch(`${EXECUTION_BASE_URL}/positions/${positionId}/review`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "PUT /positions/{id}/review");
}

export async function submitOptionGroupReview(groupId: string, payload: ReviewSubmitPayload): Promise<ManualOptionGroup> {
  const res = await fetch(`${EXECUTION_BASE_URL}/option-groups/${groupId}/review`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "PUT /option-groups/{id}/review");
}

export async function createManualPosition(
  payload: {
    segment: Segment;
    symbol: string;
    action: "BUY" | "SELL";
    instrument_type: "spot" | "future";
    price: number;
    quantity?: number;
    plan_checklist: ChecklistAnswer[];
    order_type?: "market" | "limit";
  } & ManualStopLossConfig,
): Promise<ManualPosition> {
  const res = await fetch(`${EXECUTION_BASE_URL}/positions/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "POST /positions/manual");
}

// Generically useful, not manual-only - edits SL on any already-open
// position (execution has no other route for this), including attaching
// or replacing a trailing method-based stop after the fact - at least one
// of stop_loss_price/stop_loss_method is required (unlike
// createManualPosition, where "neither" just means no stop-loss at all).
export async function updateStopLoss(positionId: string, config: ManualStopLossConfig): Promise<ManualPosition> {
  const res = await fetch(`${EXECUTION_BASE_URL}/positions/${positionId}/stop-loss`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  return asJson(res, "PUT /positions/{id}/stop-loss");
}

// Combined SL only (sl_scope='combined') - editing an individual leg's
// own SL isn't supported by this endpoint.
export async function updateOptionStopLoss(groupId: string, stopLossPrice: number): Promise<ManualOptionGroup> {
  const res = await fetch(`${EXECUTION_BASE_URL}/option-groups/${groupId}/stop-loss`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stop_loss_price: stopLossPrice }),
  });
  return asJson(res, "PUT /option-groups/{id}/stop-loss");
}

// A stop on the UNDERLYING's own spot price - independent of the
// combined-premium stop-loss above (execution's
// update_group_spot_stop_loss/_evaluate_option_group_exits), persisted
// server-side (spot_stop_loss_price column) and polled by execution's own
// exit-monitor every 30s, unlike the Manual tab's targetPrice/slLimitPrice
// client-side-only watch fields - see ManualTab.tsx's handleSave.
export async function updateOptionGroupSpotStopLoss(groupId: string, spotStopLossPrice: number): Promise<ManualOptionGroup> {
  const res = await fetch(`${EXECUTION_BASE_URL}/option-groups/${groupId}/spot-stop-loss`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spot_stop_loss_price: spotStopLossPrice }),
  });
  return asJson(res, "PUT /option-groups/{id}/spot-stop-loss");
}

export async function fetchExecPositions(
  params: {
    signalId?: string;
    withLivePnl?: boolean;
    symbol?: string;
    segment?: Segment;
    status?: "OPEN" | "CLOSED" | "REJECTED";
    manualOnly?: boolean;
    limit?: number;
  } = {},
): Promise<ManualPosition[]> {
  const query = new URLSearchParams();
  if (params.signalId) query.set("signal_id", params.signalId);
  if (params.withLivePnl) query.set("with_live_pnl", "true");
  if (params.symbol) query.set("symbol", params.symbol);
  if (params.segment) query.set("segment", params.segment);
  if (params.status) query.set("status", params.status);
  if (params.manualOnly) query.set("manual_only", "true");
  if (params.limit) query.set("limit", String(params.limit));
  const res = await fetch(`${EXECUTION_BASE_URL}/positions?${query}`);
  return asJson(res, "GET /positions");
}

export type SquareOffPositionResult = {
  status: string;
  position_id: string;
  symbol: string;
  exit_price: number;
  pnl: number;
  closed_quantity: number;
  remaining_quantity: number;
};

// quantity omitted closes everything held; a smaller amount partially
// closes - the position stays OPEN with the remainder, and the closed
// portion becomes its own separate CLOSED record (see
// position_manager.square_off_position's own docstring).
export async function squareOffManualPosition(positionId: string, quantity?: number): Promise<SquareOffPositionResult> {
  const query = quantity != null ? `?${new URLSearchParams({ quantity: String(quantity) })}` : "";
  const res = await fetch(`${EXECUTION_BASE_URL}/positions/${positionId}/square-off${query}`, { method: "POST" });
  return asJson(res, "POST /positions/{id}/square-off");
}

export async function fetchOptionGroups(
  params: {
    signalId?: string;
    withLivePnl?: boolean;
    symbol?: string;
    segment?: Segment;
    status?: "OPEN" | "CLOSED" | "REJECTED";
    manualOnly?: boolean;
    limit?: number;
  } = {},
): Promise<ManualOptionGroup[]> {
  const query = new URLSearchParams();
  if (params.signalId) query.set("signal_id", params.signalId);
  if (params.withLivePnl) query.set("with_live_pnl", "true");
  if (params.symbol) query.set("symbol", params.symbol);
  if (params.segment) query.set("segment", params.segment);
  if (params.status) query.set("status", params.status);
  if (params.manualOnly) query.set("manual_only", "true");
  if (params.limit) query.set("limit", String(params.limit));
  const res = await fetch(`${EXECUTION_BASE_URL}/option-groups?${query}`);
  return asJson(res, "GET /option-groups");
}

// Option groups are always closed in full - see docs/architecture.md's
// note on why partial close is scoped to spot/future only.
export async function squareOffOptionGroup(
  groupId: string,
): Promise<{ status: string; group_id: string; underlying_symbol: string; pnl: number }> {
  const res = await fetch(`${EXECUTION_BASE_URL}/option-groups/${groupId}/square-off`, { method: "POST" });
  return asJson(res, "POST /option-groups/{id}/square-off");
}

// POST /option-groups/manual (execution) - option orders, bypasses
// signal-generation/signal-processing entirely, same "always 200,
// rejection is a legitimate outcome" convention as createManualPosition.
// No auto-provisioned Strategy (removed 2026-08-14). No `expiry` field -
// there used to be an Expiry <select> here backed by market-data's
// GET /options/expiries, but that call proved slow/unreliable enough to
// leave the dropdown stuck on "Loading..." indefinitely; removed
// 2026-08-14 in favor of execution resolving its own legs against
// whatever the nearest currently-tradeable expiry is at open time (see
// open_manual_option_group's docstring) - no frontend dependency on that
// endpoint at all anymore.
export async function createManualOptionGroup(payload: {
  segment: Segment;
  symbol: string;
  action: "BUY" | "SELL";
  option_position_style: OptionPositionStyle;
  option_strike_moneyness: OptionStrikeMoneyness;
  sl_scope?: OptionSlScope;
  option_fixed_lots?: number;
  plan_checklist: ChecklistAnswer[];
  order_type?: "market" | "limit";
}): Promise<ManualOptionGroup> {
  const res = await fetch(`${EXECUTION_BASE_URL}/option-groups/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "POST /option-groups/manual");
}

// Screenshots/chart snapshots attached to a closed manual trade for
// future review (execution.trade_images) - image_data itself is never
// sent over this JSON API, only fetched separately via imageUrl(id) as a
// plain <img src>, same reasoning GET /images/{id} returns raw bytes
// instead of a JSON-wrapped base64 blob.
export type TradeImage = {
  id: string;
  content_type: string;
  uploaded_at: string;
};

export function tradeImageUrl(id: string): string {
  return `${EXECUTION_BASE_URL}/images/${id}`;
}

export async function fetchPositionImages(positionId: string): Promise<TradeImage[]> {
  const res = await fetch(`${EXECUTION_BASE_URL}/positions/${positionId}/images`);
  return asJson(res, "GET /positions/{id}/images");
}

export async function uploadPositionImage(positionId: string, file: File): Promise<TradeImage> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${EXECUTION_BASE_URL}/positions/${positionId}/images`, { method: "POST", body: form });
  return asJson(res, "POST /positions/{id}/images");
}

export async function fetchOptionGroupImages(groupId: string): Promise<TradeImage[]> {
  const res = await fetch(`${EXECUTION_BASE_URL}/option-groups/${groupId}/images`);
  return asJson(res, "GET /option-groups/{id}/images");
}

export async function uploadOptionGroupImage(groupId: string, file: File): Promise<TradeImage> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${EXECUTION_BASE_URL}/option-groups/${groupId}/images`, { method: "POST", body: form });
  return asJson(res, "POST /option-groups/{id}/images");
}

export async function deleteTradeImage(imageId: string): Promise<void> {
  const res = await fetch(`${EXECUTION_BASE_URL}/images/${imageId}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`DELETE /images/{id} failed: ${await extractErrorDetail(res)}`);
  }
}
