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
// match). Only drives the square_off_time default; MCX/CRYPTO can be
// recorded as intent even though nothing downstream trades them yet.
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

// The 5 sub-conditions the backend's app/domain/regime.py classify_regime
// combines - mirrors regime.REGIME_CHECK_NAMES exactly. When
// regime_filter_enabled, only the checks named here must agree to confirm
// a signal's direction.
export type RegimeCheckName = "structure" | "efficiency_ratio" | "adx" | "dmi_direction" | "ema_slope";
export const ALL_REGIME_CHECKS: RegimeCheckName[] = ["structure", "efficiency_ratio", "adx", "dmi_direction", "ema_slope"];
export const REGIME_CHECK_LABELS: Record<RegimeCheckName, string> = {
  structure: "Swing structure",
  efficiency_ratio: "Efficiency Ratio",
  adx: "ADX strength",
  dmi_direction: "DMI direction",
  ema_slope: "EMA slope",
};

// Mirrors the backend's default_square_off_time (app/domain/models.py) -
// used here to preview/pre-fill the suggested value client-side; the
// backend re-derives and enforces this itself, this is just UX.
const DEFAULT_SQUARE_OFF_TIME: Record<Segment, string> = {
  NSE: "15:00",
  MCX: "22:00",
  CRYPTO: "17:25",
};

export function defaultSquareOffTime(horizon: Horizon, segment: Segment): string | null {
  if (horizon !== "intraday") return null;
  return DEFAULT_SQUARE_OFF_TIME[segment] ?? null;
}

// Indicators are their own entity (backend: signal_generation.indicators)
// so one definition (e.g. "RSI 14") can be reused by any number of
// rules - see docs/architecture.md. Only "rsi" exists today.
export type IndicatorType = "rsi";

// sma_period is RSI's own signal line (SMA of RSI) - bundled into the
// indicator's own definition, matching how TradingView's RSI script
// bundles "RSI Length" and "MA Length" into one indicator's settings.
export type RsiParams = { period: number; sma_period: number };
export type IndicatorParams = RsiParams;

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
export type Rule = {
  id: string;
  name: string;
  description: string | null;
  source_type: SourceType;
  // source_type != 'in_house' only - the scan's own name on the
  // provider's side, if `name` renames it locally.
  provider_rule_name: string | null;
  segment: Segment;
  // in_house only - the logical underlying to watch (e.g. "GOLDM",
  // "NIFTY") and its rule config. Null for external (webhook) rules.
  underlying: string | null;
  underlying_type: UnderlyingType;
  interval: Interval | null;
  rule_config: RuleConfig | null;
  created_at: string;
  updated_at: string;
};

export type RuleCreate = {
  name: string;
  description?: string;
  source_type: SourceType;
  provider_rule_name?: string;
  segment?: Segment;
  underlying?: string;
  underlying_type?: UnderlyingType;
  interval?: Interval;
  rule_config?: RuleConfig;
};

// source_type isn't here - not editable after creation (see backend's
// RuleUpdate docstring) - delete+recreate if it's genuinely wrong.
export type RuleUpdate = {
  name?: string;
  description?: string;
  provider_rule_name?: string;
  segment?: Segment;
  underlying?: string;
  underlying_type?: UnderlyingType;
  interval?: Interval;
  rule_config?: RuleConfig;
};

// Lightweight embed on Strategy (see below) - which rule backs it, without
// an extra fetch per row in the strategy table.
export type RuleSummary = {
  id: string;
  name: string;
  source_type: SourceType;
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
  // Which saved Rule decides when this strategy's signals fire - required
  // for every strategy, in-house or external. See Rule above.
  rule_id: string;
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
  contract_day_filter: ContractDayFilter;
  segment: Segment;
  // Required for horizon='intraday' only (auto-defaulted server-side from
  // horizon+segment when omitted on create - see defaultSquareOffTime
  // above); null for swing/positional, since square-off doesn't apply
  // there. execution has no platform-wide default.
  square_off_time: string | null; // "HH:MM:SS"
  // in_house only (harmlessly ignored for webhook strategies) - gates a
  // crossover signal on a single-timeframe market regime classification
  // (see the backend's app/domain/regime.py). Default false preserves
  // today's behavior exactly.
  regime_filter_enabled: boolean;
  // Which of the 5 sub-conditions must agree when regime_filter_enabled -
  // defaults to all 5 (ALL_REGIME_CHECKS) server-side.
  regime_filter_checks: RegimeCheckName[];
  duplicate_signal_policy: DuplicateSignalPolicy;
  counter_signal_policy: CounterSignalPolicy;
  // Optional per-strategy signal-acceptance window (e.g. 09:15-11:00) -
  // both-or-neither, every source_type. Enforced by signal-processing's
  // resolve() against the signal's own timestamp; active_to_time also
  // bounds how long a position stays open (folded into the resolved
  // order's square_off_time, the earlier of the two) - see
  // docs/architecture.md.
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
  rule_id: string;
  stop_loss_method?: StopLossMethod;
  stop_loss_interval?: StopLossInterval;
  stop_loss_percent?: number;
  target_percent?: number;
  trailing_stop_enabled?: boolean;
  option_position_style?: OptionPositionStyle;
  option_strike_moneyness?: OptionStrikeMoneyness;
  option_sl_scope?: OptionSlScope;
  contract_day_filter?: ContractDayFilter;
  segment?: Segment;
  // Optional - the backend auto-fills it from horizon+segment when
  // horizon='intraday'; required explicitly for other horizons.
  square_off_time?: string;
  regime_filter_enabled?: boolean;
  regime_filter_checks?: RegimeCheckName[];
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
  contract_day_filter?: ContractDayFilter;
  segment?: Segment;
  square_off_time?: string;
  regime_filter_enabled?: boolean;
  regime_filter_checks?: RegimeCheckName[];
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

export async function fetchRules(sourceType?: SourceType): Promise<Rule[]> {
  const params = sourceType ? `?source_type=${sourceType}` : "";
  const res = await fetch(`${SIGNAL_GENERATION_BASE_URL}/rules${params}`);
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

// NSE index-constituent universe keys (e.g. "NIFTYBANK") - populates the
// universe picker when underlying_type='universe'. market-data owns this
// list (see its app/providers/nse_indices.py).
export async function fetchUniverses(): Promise<string[]> {
  const res = await fetch(`${MARKET_DATA_BASE_URL}/instruments/universes`);
  const data = await asJson<{ universes: string[] }>(res, "GET /instruments/universes");
  return data.universes;
}
