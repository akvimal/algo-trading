import type {
  ActiveWindow, BreakoutRuleConfig, CrossoverRuleConfig, Indicator, IndicatorType, Interval, RangeBreakoutRuleConfig, Rule, RuleConfig,
  Strategy, StrategyFields, Watchlist, Weekday,
} from "../api/strategies";

// Plain helpers for the strategy-authoring screens: labels, indicator param shapes, and the light
// validation that saves a round trip (the server has the last word — see its own model_validators).
// No requests, no screen, so it can be tested without either.

export const INTERVALS: { value: Interval; label: string }[] = [
  { value: "1min", label: "1m" }, { value: "3min", label: "3m" }, { value: "5min", label: "5m" }, { value: "15min", label: "15m" },
  { value: "30min", label: "30m" }, { value: "60min", label: "1h" }, { value: "daily", label: "Daily" },
];
export const WEEKDAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** One field of an indicator type's params, for a generic form: min/step mirror the server's own bounds. */
export type ParamField = { key: string; label: string; min?: number; max?: number; step?: number; integer?: boolean };

export const INDICATOR_TYPE_LABEL: Record<IndicatorType, string> = {
  rsi: "RSI", structure: "Structure (swing highs/lows)", efficiency_ratio: "Efficiency ratio", adx: "ADX (trend strength)",
  dmi_direction: "DMI direction", ema_slope: "EMA slope", supertrend: "SuperTrend",
};

/** Field lists for each indicator type's `params`, in the order the server's own model declares them. */
export const INDICATOR_PARAM_FIELDS: Record<IndicatorType, ParamField[]> = {
  rsi: [{ key: "period", label: "Period", min: 2, integer: true }, { key: "sma_period", label: "Signal line (SMA of RSI) period", min: 2, integer: true }],
  structure: [{ key: "swing_lookback", label: "Swing lookback (bars each side)", min: 2, integer: true }],
  efficiency_ratio: [{ key: "period", label: "Period", min: 2, integer: true }, { key: "trend_threshold", label: "Trend threshold (0–1)", min: 0, max: 1, step: 0.01 }],
  adx: [{ key: "period", label: "Period", min: 2, integer: true }, { key: "trend_threshold", label: "Trend threshold", min: 0, step: 0.1 }],
  dmi_direction: [{ key: "period", label: "Period", min: 2, integer: true }],
  ema_slope: [
    { key: "ema_period", label: "EMA period", min: 2, integer: true }, { key: "slope_lookback", label: "Slope lookback (bars)", min: 1, integer: true },
    { key: "slope_threshold", label: "Slope threshold", min: 0, step: 0.01 }, { key: "atr_period", label: "ATR period (normalising)", min: 2, integer: true },
  ],
  supertrend: [{ key: "period", label: "ATR period", min: 2, integer: true }, { key: "multiplier", label: "Band multiplier", min: 0, step: 0.1 }],
};

export const DEFAULT_PARAMS: Record<IndicatorType, Record<string, number>> = {
  rsi: { period: 14, sma_period: 9 }, structure: { swing_lookback: 3 }, efficiency_ratio: { period: 10, trend_threshold: 0.3 },
  adx: { period: 14, trend_threshold: 20 }, dmi_direction: { period: 14 },
  ema_slope: { ema_period: 20, slope_lookback: 5, slope_threshold: 0.1, atr_period: 14 }, supertrend: { period: 10, multiplier: 3 },
};

/** What is wrong with a set of params for `type`, in words, or an empty list. */
export function validateParams(type: IndicatorType, params: Record<string, number>): string[] {
  const errors: string[] = [];
  for (const f of INDICATOR_PARAM_FIELDS[type]) {
    const v = params[f.key];
    if (!Number.isFinite(v)) {
      errors.push(`${f.label} needs a number.`);
      continue;
    }
    if (f.integer && !Number.isInteger(v)) errors.push(`${f.label} must be a whole number.`);
    if (f.min != null && v <= f.min && f.key !== "slope_lookback" && f.key !== "trend_threshold") errors.push(`${f.label} must be more than ${f.min}.`);
    if (f.min != null && (f.key === "slope_lookback") && v < f.min) errors.push(`${f.label} must be at least ${f.min}.`);
    if (f.min === 0 && v < 0) errors.push(`${f.label} must not be negative.`);
    if (f.max != null && v > f.max) errors.push(`${f.label} must be at most ${f.max}.`);
  }
  return errors;
}

const isRegimeType = (t: IndicatorType) => t !== "rsi";

/** Indicators eligible for a rule's regime gate (every type except RSI, which is crossover-only). */
export const regimeEligible = (indicators: Indicator[]): Indicator[] => indicators.filter((i) => isRegimeType(i.type));
/** Indicators eligible for a crossover rule's own trigger (RSI or SuperTrend — the two with a signal line). */
export const crossoverEligible = (indicators: Indicator[]): Indicator[] => indicators.filter((i) => i.type === "rsi" || i.type === "supertrend");

/** A short, plain description of what a rule fires on. */
export function ruleConfigSummary(rule: Rule): string {
  const c = rule.rule_config;
  if (!c) return "Not configured yet";
  if (c.type === "crossover") return "Crosses its indicator's signal line";
  if (c.type === "breakout") return `${c.ltf_interval} breaks its own ${c.ltf_breakout_period}-bar range after a ${c.htf_interval} ${c.htf_breakout_period}-bar breakout`;
  if (c.type === "range_breakout") return `Breaks the last ${c.breakout_period} candles' high or low on ${rule.interval ?? "its own interval"}`;
  return `${c.direction === "bullish" ? "Bullish" : "Bearish"} multi-condition scan (${c.conditions.length} condition${c.conditions.length === 1 ? "" : "s"}) — not editable here yet`;
}

export const UNDERLYING_TYPE_LABEL: Record<Rule["underlying_type"], string> = {
  symbol: "One symbol", universe: "Index constituents", symbol_list: "A list of symbols", watchlist: "A saved watchlist",
};

/** Where a rule scans, in words. */
export function underlyingSummary(rule: Pick<Rule, "underlying_type" | "underlying" | "segment">): string {
  if (!rule.underlying) return "Not set";
  if (rule.underlying_type === "universe") return `Every constituent of ${rule.underlying}`;
  if (rule.underlying_type === "watchlist") return `Watchlist "${rule.underlying}"`;
  if (rule.underlying_type === "symbol_list") return rule.underlying.split(",").map((s) => s.trim()).filter(Boolean).join(", ");
  return rule.underlying;
}

/** What is wrong with a rule's own fields, in words, or an empty list — mirrors the server's shape checks
 * (not the indicator-existence or watchlist-existence ones, which need a request). */
export function validateRuleConfig(config: RuleConfig): string[] {
  const errors: string[] = [];
  if (config.type === "crossover" && !config.indicator_id) errors.push("Pick which indicator this crosses.");
  if (config.type === "breakout") {
    if (!(config.htf_breakout_period > 1)) errors.push("The higher-timeframe breakout period must be more than 1.");
    if (!(config.ltf_breakout_period > 1)) errors.push("The lower-timeframe breakout period must be more than 1.");
    if (config.ema_filter_enabled && !(config.ema_period > 1)) errors.push("The EMA period must be more than 1.");
  }
  if (config.type === "range_breakout" && !(config.breakout_period > 1)) errors.push("The breakout period must be more than 1.");
  return errors;
}

export function validateUnderlying(underlyingType: Rule["underlying_type"], underlying: string, segment: string): string[] {
  const errors: string[] = [];
  if (!underlying.trim()) errors.push(underlyingType === "watchlist" ? "Pick a watchlist." : underlyingType === "universe" ? "Pick an index." : "Enter a symbol.");
  if (underlyingType === "universe" && segment !== "NSE") errors.push("An index scan only works on NSE.");
  if (underlyingType === "symbol_list" && underlying.trim() && !underlying.split(",").some((s) => s.trim())) errors.push("Enter at least one symbol.");
  return errors;
}

export const defaultRuleConfig = (type: RuleConfig["type"], indicatorId = ""): RuleConfig =>
  type === "crossover"
    ? { type, indicator_id: indicatorId }
    : type === "breakout"
      ? { type, htf_interval: "60min", htf_breakout_period: 20, ltf_interval: "5min", ltf_breakout_period: 5, ema_filter_enabled: false, ema_period: 20 }
      : type === "range_breakout"
        ? { type, breakout_period: 20 }
        : { type: "multi_condition", direction: "bullish", conditions: [] };

export const isCrossover = (c: RuleConfig): c is CrossoverRuleConfig => c.type === "crossover";
export const isBreakout = (c: RuleConfig): c is BreakoutRuleConfig => c.type === "breakout";
export const isRangeBreakout = (c: RuleConfig): c is RangeBreakoutRuleConfig => c.type === "range_breakout";

// ---- Strategy ----

export const STOP_LOSS_METHOD_LABEL: Record<NonNullable<Strategy["stop_loss_method"]>, string> = {
  previous_candle: "Previous candle's high/low", percent: "A flat percent from entry", indicator: "An indicator (trailing)", breakeven: "Breakeven once favourable (trailing)",
};

/** What is wrong with a strategy's stop-loss field group, mirroring the server's own mutual-exclusion
 * rule (validate_stop_loss_fields): each method needs exactly its own siblings, no others. */
export function validateStopLoss(f: {
  method: Strategy["stop_loss_method"]; interval: string | null; percent: number | null; trailing: boolean; indicatorType: string | null;
}): string[] {
  const { method, interval, percent, trailing, indicatorType } = f;
  if (method == null) return [];
  if (method === "previous_candle") return interval ? [] : ["Pick an interval for the previous candle's high/low."];
  if (method === "percent" || method === "breakeven") {
    const errors: string[] = [];
    if (percent == null || !(percent > 0 && percent < 100)) errors.push("Enter a stop percent between 0 and 100.");
    if (method === "breakeven" && !trailing) errors.push("Breakeven needs trailing switched on — otherwise it never moves to entry.");
    return errors;
  }
  if (method === "indicator") return interval && indicatorType ? [] : ["Pick an interval and an indicator for the trailing stop."];
  return [];
}

export function validateWindows(windows: ActiveWindow[]): string[] {
  return windows.flatMap((w, i) => (!w.start || !w.end ? [`Window ${i + 1} needs a start and an end time.`] : w.end <= w.start ? [`Window ${i + 1} must end after it starts.`] : []));
}

/** What is wrong with the core strategy fields, or an empty list. Options-only and stop-loss checks are
 * separate (validateStopLoss above), since they depend on which fields are even shown. */
export function validateStrategyCore(f: Pick<StrategyFields, "name" | "source_type" | "instrument_type" | "segment">): string[] {
  const errors: string[] = [];
  if (!f.name.trim()) errors.push("Give it a name.");
  if (!f.source_type.trim()) errors.push("Say where its signals come from.");
  if ((f.segment === "CRYPTO" || f.segment === "MCX") && f.instrument_type === "spot") errors.push(`${f.segment} has no spot market — use a future or an option.`);
  return errors;
}

/** One line describing a strategy: what it trades and how, for the list. */
export function strategySummary(s: Strategy): string {
  const parts: string[] = [s.instrument_type, s.segment];
  if (s.stop_loss_method) parts.push(`SL: ${STOP_LOSS_METHOD_LABEL[s.stop_loss_method].toLowerCase()}`);
  if (s.target_percent != null) parts.push(`target ${s.target_percent}%`);
  if (s.fixed_lots != null) parts.push(`${s.fixed_lots} lot${s.fixed_lots === 1 ? "" : "s"} fixed`);
  return parts.join(" · ");
}

export const isInHouse = (s: Pick<Strategy, "source_type">) => s.source_type === "in_house";

/** Watchlists sorted for a picker, plus a lookup from name to symbol count. */
export const watchlistNames = (watchlists: Watchlist[]) => watchlists.map((w) => w.name);
