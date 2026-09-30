import { api } from "./http";
import type { Segment } from "./types";

// signal-engine's Strategy/Rule/Indicator/Watchlist/Signal entities: a hand-written mirror of that
// backend's domain models (systems/signal-engine/backend/app/domain/generation/{models,rule,watchlist}.py),
// same convention every other frontend's own copy already follows there being no codegen wiring them
// together yet.

export type IndicatorType = "rsi" | "structure" | "efficiency_ratio" | "adx" | "dmi_direction" | "ema_slope" | "supertrend";
/** Which IndicatorTypes a Rule.regime_indicator_ids slot accepts ("rsi" is crossover-only). */
export const REGIME_INDICATOR_TYPES: IndicatorType[] = ["structure", "efficiency_ratio", "adx", "dmi_direction", "ema_slope", "supertrend"];
/** Which IndicatorTypes a crossover rule's own indicator_id accepts. */
export const CROSSOVER_INDICATOR_TYPES: IndicatorType[] = ["rsi", "supertrend"];

export type Indicator = { id: string; name: string; type: IndicatorType; params: Record<string, number>; created_at: string; updated_at: string };
export type IndicatorCreate = { name: string; type: IndicatorType; params: Record<string, number> };
export type IndicatorUpdate = { name?: string; params?: Record<string, number> };

export const listIndicators = () => api<Indicator[]>("signalEngine", "/indicators");
export const createIndicator = (body: IndicatorCreate) => api<Indicator>("signalEngine", "/indicators", { method: "POST", json: body });
export const updateIndicator = (id: string, body: IndicatorUpdate) => api<Indicator>("signalEngine", `/indicators/${id}`, { method: "PATCH", json: body });
export const deleteIndicator = (id: string) => api<void>("signalEngine", `/indicators/${id}`, { method: "DELETE" });

export type Interval = "1min" | "3min" | "5min" | "15min" | "30min" | "60min" | "daily";
export type UnderlyingType = "symbol" | "universe" | "symbol_list" | "watchlist";

export type CrossoverRuleConfig = { type: "crossover"; indicator_id: string };
export type BreakoutRuleConfig = {
  type: "breakout"; htf_interval: Interval; htf_breakout_period: number; ltf_interval: Interval; ltf_breakout_period: number;
  ema_filter_enabled: boolean; ema_period: number;
};
export type RangeBreakoutRuleConfig = { type: "range_breakout"; breakout_period: number };
/** The 4th rule type, an AND-combined multi-timeframe condition list: viewable but not yet editable here
 * (its term/condition builder is a screen of its own) — edit it in the classic app. */
export type MultiConditionRuleConfig = { type: "multi_condition"; direction: "bullish" | "bearish"; conditions: unknown[] };
export type RuleConfig = CrossoverRuleConfig | BreakoutRuleConfig | RangeBreakoutRuleConfig | MultiConditionRuleConfig;

export type Rule = {
  id: string; name: string; description: string | null; segment: Segment; underlying: string | null; underlying_type: UnderlyingType;
  interval: Interval | null; rule_config: RuleConfig | null; regime_indicator_ids: string[]; created_at: string; updated_at: string;
};
export type RuleFields = {
  name: string; description?: string | null; segment: Segment; underlying: string; underlying_type: UnderlyingType; interval: Interval;
  rule_config: RuleConfig; regime_indicator_ids: string[];
};
export type RuleSummary = { id: string; name: string; segment: Segment };

export const listRules = () => api<Rule[]>("signalEngine", "/rules");
export const createRule = (body: RuleFields) => api<Rule>("signalEngine", "/rules", { method: "POST", json: body });
export const updateRule = (id: string, body: Partial<RuleFields>) => api<Rule>("signalEngine", `/rules/${id}`, { method: "PATCH", json: body });
export const deleteRule = (id: string) => api<void>("signalEngine", `/rules/${id}`, { method: "DELETE" });

export type Watchlist = { id: string; name: string; symbols: string; symbol_count: number; created_at: string; updated_at: string };
export const listWatchlists = () => api<Watchlist[]>("signalEngine", "/watchlists");
export const createWatchlist = (name: string, symbols: string) => api<Watchlist>("signalEngine", "/watchlists", { method: "POST", json: { name, symbols } });
export const updateWatchlist = (id: string, symbols: string) => api<Watchlist>("signalEngine", `/watchlists/${id}`, { method: "PUT", json: { symbols } });
export const deleteWatchlist = (id: string) => api<void>("signalEngine", `/watchlists/${id}`, { method: "DELETE" });

export type Horizon = "intraday" | "positional";
export type InstrumentType = "spot" | "future" | "option";
export type OptionPositionStyle = "spread" | "naked";
export type OptionStrikeMoneyness = "ITM2" | "ITM1" | "ATM" | "OTM1" | "OTM2";
export type OptionSlScope = "combined" | "individual";
export type ContractDayFilter = "any" | "start" | "expiry";
export type StopLossMethod = "previous_candle" | "percent" | "indicator" | "breakeven";
export type StopLossInterval = "1min" | "3min" | "5min" | "15min" | "25min" | "30min" | "60min";
export type DuplicateSignalPolicy = "skip" | "add_position";
export type CounterSignalPolicy = "skip" | "close_and_flip";
export type StrategyStatus = "draft" | "backtesting" | "live" | "paused";
export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
export type ActiveWindow = { start: string; end: string };
/** A single left/operator/right comparison, e.g. "close < 200" — Strategy.exit_condition's shape. Not
 * yet editable here (the same term builder multi_condition rules need) — shown read-only. */
export type Condition = unknown;

export type Strategy = {
  id: string; name: string; source_type: string; source_rule_name: string | null; exchange: string; horizon: Horizon;
  instrument_type: InstrumentType; rule_id: string | null; rule: RuleSummary | null;
  stop_loss_method: StopLossMethod | null; stop_loss_interval: StopLossInterval | null; stop_loss_percent: number | null;
  stop_loss_indicator_type: string | null; stop_loss_indicator_params: Record<string, number> | null;
  target_percent: number | null; trailing_stop_enabled: boolean; exit_condition: Condition | null;
  option_position_style: OptionPositionStyle; option_strike_moneyness: OptionStrikeMoneyness; option_sl_scope: OptionSlScope;
  fixed_lots: number | null; use_margin: boolean; contract_day_filter: ContractDayFilter; segment: Segment;
  duplicate_signal_policy: DuplicateSignalPolicy; counter_signal_policy: CounterSignalPolicy;
  active_windows: ActiveWindow[]; active_weekdays: Weekday[]; seed_on_activation: boolean; status: StrategyStatus;
  last_scan_at: string | null; last_signal_at: string | null; created_by: string | null; created_at: string; updated_at: string;
};

/** The fields this editor writes. `exit_condition` is deliberately absent: creating or clearing one here
 * would need the term builder this screen does not have yet, so an existing one is left untouched. */
export type StrategyFields = {
  name: string; source_type: string; source_rule_name?: string | null; horizon: Horizon; instrument_type: InstrumentType;
  rule_id?: string | null; stop_loss_method?: StopLossMethod | null; stop_loss_interval?: StopLossInterval | null;
  stop_loss_percent?: number | null; stop_loss_indicator_type?: string | null; stop_loss_indicator_params?: Record<string, number> | null;
  target_percent?: number | null; trailing_stop_enabled?: boolean; option_position_style?: OptionPositionStyle;
  option_strike_moneyness?: OptionStrikeMoneyness; option_sl_scope?: OptionSlScope; fixed_lots?: number | null; use_margin?: boolean;
  contract_day_filter?: ContractDayFilter; segment: Segment; duplicate_signal_policy?: DuplicateSignalPolicy;
  counter_signal_policy?: CounterSignalPolicy; active_windows?: ActiveWindow[]; active_weekdays?: Weekday[]; seed_on_activation?: boolean;
};

export const listStrategies = () => api<Strategy[]>("signalEngine", "/strategies");
export const createStrategy = (body: StrategyFields) => api<Strategy>("signalEngine", "/strategies", { method: "POST", json: body });
export const updateStrategy = (id: string, body: Partial<StrategyFields> & { status?: StrategyStatus; reset_engine_run?: boolean }) =>
  api<Strategy>("signalEngine", `/strategies/${id}`, { method: "PATCH", json: body });
export const deleteStrategy = (id: string) => api<void>("signalEngine", `/strategies/${id}`, { method: "DELETE" });

export type Signal = {
  signal_id: string; strategy_id: string; symbol: string; exchange: string; action: "BUY" | "SELL"; price: number; source: string;
  received_at: string; horizon: string | null; instrument_type: string | null; status: string | null; rejection_reason: string | null;
};
export const listSignals = (strategyId?: string, limit = 50) =>
  api<Signal[]>("signalEngine", `/signals?limit=${limit}${strategyId ? `&strategy_id=${strategyId}` : ""}`);
