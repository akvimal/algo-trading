// Free-form: only "in_house" is reserved/special (see backend
// app/domain/models.py's SourceType) - anything else names an external
// webhook provider (chartink, tradingview, or any new one).
export type SourceType = string;
export type Horizon = "intraday" | "swing" | "positional";
export type InstrumentType = "spot" | "future" | "option";
export type StrategyStatus = "draft" | "backtesting" | "live" | "paused";
export type Interval = "1min" | "3min" | "5min" | "15min" | "30min" | "60min" | "daily";
export type StopLossMethod = "previous_candle" | "percent";
// matches Dhan's actual supported intraday-candle intervals (no "daily",
// and 25min not 30min - Dhan's charts/intraday API only supports 1/5/15/25/60)
export type StopLossInterval = "1min" | "5min" | "15min" | "25min" | "60min";
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
// future, or option strategy alike).
export type UnderlyingType = "symbol" | "universe";

// Indicators are their own entity (backend: signal_generation.indicators)
// so one definition (e.g. "RSI 14") can be reused by any number of
// rules - see docs/architecture.md. Only "rsi" exists today.
export type IndicatorType = "rsi" | "structure" | "efficiency_ratio" | "adx" | "dmi_direction" | "ema_slope";

// The 5 market-regime checks (backend's app/domain/regime.py) as
// independent Indicator types, referenced from a Rule via its own
// regime_indicator_ids (see Rule below) rather than "rsi", which is
// crossover-only (CrossoverRuleConfig.indicator_id).
export const REGIME_INDICATOR_TYPES: IndicatorType[] = ["structure", "efficiency_ratio", "adx", "dmi_direction", "ema_slope"];
export const INDICATOR_TYPE_LABELS: Record<IndicatorType, string> = {
  rsi: "RSI",
  structure: "Swing structure",
  efficiency_ratio: "Efficiency Ratio",
  adx: "ADX strength",
  dmi_direction: "DMI direction",
  ema_slope: "EMA slope",
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

export type IndicatorParams =
  | RsiParams
  | StructureParams
  | EfficiencyRatioParams
  | AdxParams
  | DmiDirectionParams
  | EmaSlopeParams;

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

export type RuleConfig = CrossoverRuleConfig | BreakoutRuleConfig | RangeBreakoutRuleConfig;

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
  target_percent: number | null;
  trailing_stop_enabled: boolean;
  // instrument_type='option' only - see OptionPositionStyle above.
  option_position_style: OptionPositionStyle;
  option_strike_moneyness: OptionStrikeMoneyness;
  option_sl_scope: OptionSlScope;
  // instrument_type='option' only, nullable. When set, execution trades
  // exactly this many lots instead of auto-sizing off capital/risk% -
  // takes precedence over stop-loss-based sizing entirely.
  option_fixed_lots: number | null;
  contract_day_filter: ContractDayFilter;
  segment: Segment;
  duplicate_signal_policy: DuplicateSignalPolicy;
  counter_signal_policy: CounterSignalPolicy;
  // Optional per-strategy signal-acceptance window (e.g. 09:15-11:00) -
  // both-or-neither, every source_type. Enforced by signal-processing's
  // resolve() against the signal's own timestamp - purely gates whether a
  // signal is accepted, unrelated to square-off (a per-segment execution
  // setting now, not a Strategy field - see docs/architecture.md).
  active_from_time: string | null; // "HH:MM:SS"
  active_to_time: string | null; // "HH:MM:SS"
  status: StrategyStatus;
  created_at: string;
  updated_at: string;
};

export type StrategyCreate = {
  name: string;
  source_type: SourceType;
  horizon: Horizon;
  instrument_type: InstrumentType;
  // Required iff source_type === 'in_house'; omit/null for external.
  rule_id?: string | null;
  stop_loss_method?: StopLossMethod;
  stop_loss_interval?: StopLossInterval;
  stop_loss_percent?: number;
  target_percent?: number;
  trailing_stop_enabled?: boolean;
  option_position_style?: OptionPositionStyle;
  option_strike_moneyness?: OptionStrikeMoneyness;
  option_sl_scope?: OptionSlScope;
  option_fixed_lots?: number;
  contract_day_filter?: ContractDayFilter;
  segment?: Segment;
  duplicate_signal_policy?: DuplicateSignalPolicy;
  counter_signal_policy?: CounterSignalPolicy;
  // Both-or-neither - see Strategy's own comment above.
  active_from_time?: string;
  active_to_time?: string;
};

// source_type/exchange aren't here - not editable after creation, see
// the backend's StrategyUpdate docstring. Same for stop_loss_method: it
// can be set/switched via PATCH but never cleared back to null (see
// backend docstring) - same limitation `rule_id` (switching from in-house
// to external) already has.
export type StrategyEdit = {
  name?: string;
  status?: StrategyStatus;
  horizon?: Horizon;
  instrument_type?: InstrumentType;
  rule_id?: string;
  stop_loss_method?: StopLossMethod;
  stop_loss_interval?: StopLossInterval;
  stop_loss_percent?: number;
  target_percent?: number;
  trailing_stop_enabled?: boolean;
  option_position_style?: OptionPositionStyle;
  option_strike_moneyness?: OptionStrikeMoneyness;
  option_sl_scope?: OptionSlScope;
  // number | null (not just optional) - unlike every other field here,
  // this one can be explicitly cleared back to auto-sizing via
  // {option_fixed_lots: null} - see the backend's update_strategy
  // (model_fields_set-based) and ManualTab.tsx, which relies on this to
  // vary an auto-provisioned strategy's lot count order-to-order.
  option_fixed_lots?: number | null;
  contract_day_filter?: ContractDayFilter;
  segment?: Segment;
  duplicate_signal_policy?: DuplicateSignalPolicy;
  counter_signal_policy?: CounterSignalPolicy;
  active_from_time?: string;
  active_to_time?: string;
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

export type BacktestResult = {
  trade_count: number;
  hypothetical_pnl: number;
  trades: BacktestTrade[];
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
  target_percent?: number;
  trailing_stop_enabled?: boolean;
  square_off_time?: string;
  option_position_style?: OptionPositionStyle;
  option_strike_moneyness?: OptionStrikeMoneyness;
};

export type RuleBacktestGridRequest = {
  param_grid: Record<string, number[]>;
  stop_loss_method?: StopLossMethod;
  stop_loss_interval?: StopLossInterval;
  stop_loss_percent?: number;
  target_percent?: number;
  trailing_stop_enabled?: boolean;
  square_off_time?: string;
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

// Ports are build-time configurable (VITE_SIGNAL_GENERATION_PORT/
// VITE_SIGNAL_PROCESSING_PORT - see Dockerfile's ARG/ENV and
// docker-compose.yml's build args) so a port-shifted container group
// (e.g. a separate local test stack) actually calls its OWN backends
// instead of a hardcoded dev port. Defaults match dev's ports, so
// `npm run dev` with no .env still works exactly as before.
const SIGNAL_GENERATION_PORT = import.meta.env.VITE_SIGNAL_GENERATION_PORT ?? "8003";
const SIGNAL_PROCESSING_PORT = import.meta.env.VITE_SIGNAL_PROCESSING_PORT ?? "8000";
const MARKET_DATA_PORT = import.meta.env.VITE_MARKET_DATA_PORT ?? "8001";

// This system's own backend - owns the strategies/rules tables.
const SIGNAL_GENERATION_BASE_URL = `http://${location.hostname}:${SIGNAL_GENERATION_PORT}`;
// signal-processing's API, read directly from the browser (CORS-enabled)
// for per-strategy signal activity - a view, not a copy of that data.
const SIGNAL_PROCESSING_BASE_URL = `http://${location.hostname}:${SIGNAL_PROCESSING_PORT}`;
// market-data's API, read directly from the browser (CORS-enabled) - just
// for the universe picker below, same pattern as signal-processing above.
const MARKET_DATA_BASE_URL = `http://${location.hostname}:${MARKET_DATA_PORT}`;

async function asJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${what} failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchIndicators(): Promise<Indicator[]> {
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/indicators`);
  return asJson(res, "GET /indicators");
}

export async function createIndicator(payload: IndicatorCreate): Promise<Indicator> {
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/indicators`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "POST /indicators");
}

export async function updateIndicator(id: string, payload: IndicatorUpdate): Promise<Indicator> {
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/indicators/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "PATCH /indicators/{id}");
}

export async function deleteIndicator(id: string): Promise<void> {
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/indicators/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`DELETE /indicators/{id} failed: ${res.status}`);
  }
}

export async function fetchRules(): Promise<Rule[]> {
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/rules`);
  return asJson(res, "GET /rules");
}

export async function createRule(payload: RuleCreate): Promise<Rule> {
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "POST /rules");
}

export async function updateRule(id: string, payload: RuleUpdate): Promise<Rule> {
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/rules/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "PATCH /rules/{id}");
}

export async function deleteRule(id: string): Promise<void> {
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/rules/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`DELETE /rules/{id} failed: ${res.status}`);
  }
}

export async function backtestRule(
  id: string,
  from: string,
  to: string,
  overrides: RuleBacktestRequest = {},
): Promise<BacktestResult | UniverseBacktestResult> {
  const params = new URLSearchParams({ from, to });
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/rules/${id}/backtest?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(overrides),
  });
  return asJson(res, "POST /rules/{id}/backtest");
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
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/rules/${id}/backtest/grid?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...overrides, param_grid: paramGrid }),
  });
  return asJson(res, "POST /rules/{id}/backtest/grid");
}

export async function fetchStrategies(sourceType?: SourceType): Promise<Strategy[]> {
  const params = sourceType ? `?source_type=${sourceType}` : "";
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/strategies${params}`);
  return asJson(res, "GET /strategies");
}

export async function createStrategy(payload: StrategyCreate): Promise<Strategy> {
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/strategies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "POST /strategies");
}

export async function updateStrategy(id: string, payload: StrategyEdit): Promise<Strategy> {
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/strategies/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "PATCH /strategies/{id}");
}

export async function deleteStrategy(id: string): Promise<void> {
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/strategies/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`DELETE /strategies/{id} failed: ${res.status}`);
  }
}

export async function fetchSignalsForStrategy(strategyId: string, limit = 20): Promise<ProviderSignal[]> {
  const params = new URLSearchParams({ strategy_id: strategyId, limit: String(limit) });
  const res = await fetch(`${SIGNAL_PROCESSING_BASE_URL}/signals?${params}`);
  return asJson(res, "GET /signals?strategy_id=...");
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
  const res = await fetch(`${SIGNAL_PROCESSING_BASE_URL}/signals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, source: "manual", source_meta: {} }),
  });
  return asJson(res, "POST /signals");
}

// NSE index-constituent universe keys (e.g. "NIFTYBANK") - populates the
// universe picker when underlying_type='universe'. market-data owns this
// list (see its app/providers/nse_indices.py).
export async function fetchUniverses(): Promise<string[]> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/instruments/universes`);
  const data = await asJson<{ universes: string[] }>(res, "GET /instruments/universes");
  return data.universes;
}

// Current market price for a symbol - used by the manual test-signal form
// (App.tsx's handleSendSignal) when the price field is left blank, same
// direct-from-browser pattern as fetchUniverses above.
export async function fetchLtp(exchange: string, symbol: string): Promise<number> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/quotes/ltp?${new URLSearchParams({ exchange, symbol })}`);
  const data = await asJson<{ ltp: number }>(res, `GET /quotes/ltp (${exchange}/${symbol})`);
  return data.ltp;
}

// ---------------------------------------------------------------------
// Manual tab (ManualTab.tsx) - execution's own backend, read/written
// directly from the browser (CORS-enabled), same direct-from-browser
// cross-system pattern as market-data/signal-processing above - NOT
// execution's own frontend's /api proxy convention. Spot/future orders
// bypass signal-generation/signal-processing entirely (see
// createManualPosition); option orders still need a real Strategy
// (strike/expiry selection lives in signal-processing's choose_strategy),
// auto-provisioned on demand - see findOrCreateManualStrategy below.
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
  exit_reason: "square_off" | "stop_loss" | "target" | "manual" | "counter_signal" | null;
  square_off_time: string | null;
  option_group_id: string | null;
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
};

export type ManualOptionGroup = {
  id: string;
  signal_id: string;
  strategy_id: string;
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
  pnl: number | null;
  square_off_time: string | null;
  legs: ManualOptionLeg[];
};

// POST /positions/manual (execution) - spot/future only, bypasses
// signal-generation/signal-processing entirely. Always returns 200 with
// whatever status resulted (OPEN or REJECTED) - a rejection is a
// legitimate persisted outcome here, not an HTTP error, same convention
// the whole resolved-order pipeline already uses.
export async function createManualPosition(payload: {
  segment: Segment;
  symbol: string;
  action: "BUY" | "SELL";
  instrument_type: "spot" | "future";
  price: number;
  quantity?: number;
  stop_loss_price?: number;
}): Promise<ManualPosition> {
  const res = await fetch(`${EXECUTION_BASE_URL}/positions/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res, "POST /positions/manual");
}

// Generically useful, not manual-only - edits SL on any already-open
// position (execution has no other route for this).
export async function updateStopLoss(positionId: string, stopLossPrice: number): Promise<ManualPosition> {
  const res = await fetch(`${EXECUTION_BASE_URL}/positions/${positionId}/stop-loss`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stop_loss_price: stopLossPrice }),
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

export async function fetchExecPositions(params: { signalId?: string; withLivePnl?: boolean } = {}): Promise<ManualPosition[]> {
  const query = new URLSearchParams();
  if (params.signalId) query.set("signal_id", params.signalId);
  if (params.withLivePnl) query.set("with_live_pnl", "true");
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

export async function fetchOptionGroups(params: { signalId?: string; withLivePnl?: boolean } = {}): Promise<ManualOptionGroup[]> {
  const query = new URLSearchParams();
  if (params.signalId) query.set("signal_id", params.signalId);
  if (params.withLivePnl) query.set("with_live_pnl", "true");
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

// Reserved pseudo-provider name for the Manual tab's auto-provisioned
// option Strategies/Rules - the in-house engine's periodic scan only ever
// evaluates source_type="in_house", and no webhook route exists for
// "manual" either, so a Strategy/Rule pair tagged this way is provably
// inert: it can only ever receive a signal via the explicit POST /signals
// call the Manual tab itself makes. See docs/architecture.md.
const MANUAL_SOURCE_TYPE = "manual";

// Options need a real Strategy (strike/expiry selection lives entirely in
// signal-processing's choose_strategy, driven by a Strategy's own
// option_position_style/option_strike_moneyness) - auto-provisioned here
// so the Manual tab still feels Strategy-free to the user. Reused across
// orders with the same (segment, style, moneyness) - each combination
// gets exactly one backing Strategy, immediately activated (status=live,
// since a draft Strategy's signals reject as "not live"). Created with no
// rule_id at all - source_type="manual" is external, Rule is in-house
// only (see Strategy above).
export async function findOrCreateManualStrategy(
  segment: Segment,
  optionStyle: OptionPositionStyle,
  moneyness: OptionStrikeMoneyness,
): Promise<Strategy> {
  const name = `[Manual] ${segment} ${optionStyle} ${moneyness}`;
  const existing = await fetchStrategies(MANUAL_SOURCE_TYPE);
  const found = existing.find(
    (s) =>
      s.segment === segment &&
      s.instrument_type === "option" &&
      s.option_position_style === optionStyle &&
      s.option_strike_moneyness === moneyness &&
      s.name === name,
  );
  if (found) return found;
  const created = await createStrategy({
    name,
    source_type: MANUAL_SOURCE_TYPE,
    horizon: "intraday",
    instrument_type: "option",
    option_position_style: optionStyle,
    option_strike_moneyness: moneyness,
    segment,
    duplicate_signal_policy: "add_position",
  });
  return updateStrategy(created.id, { status: "live" });
}
