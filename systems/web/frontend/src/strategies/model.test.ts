import { describe, expect, it } from "vitest";
import type { Indicator, Strategy } from "../api/strategies";
import {
  crossoverEligible, defaultRuleConfig, regimeEligible, ruleConfigSummary, strategySummary, underlyingSummary,
  validateParams, validateRuleConfig, validateStopLoss, validateStrategyCore, validateUnderlying, validateWindows,
} from "./model";

const indicator = (over: Partial<Indicator> = {}): Indicator => ({ id: "i1", name: "RSI 14", type: "rsi", params: { period: 14, sma_period: 9 }, created_at: "", updated_at: "", ...over });

describe("validateParams", () => {
  it("accepts sensible defaults for every type", () => {
    expect(validateParams("rsi", { period: 14, sma_period: 9 })).toEqual([]);
    expect(validateParams("adx", { period: 14, trend_threshold: 20 })).toEqual([]);
    expect(validateParams("ema_slope", { ema_period: 20, slope_lookback: 5, slope_threshold: 0.1, atr_period: 14 })).toEqual([]);
  });
  it("catches a missing or non-numeric field", () => {
    expect(validateParams("rsi", { period: 14, sma_period: Number.NaN })).toHaveLength(1);
    expect(validateParams("dmi_direction", {})[0]).toMatch(/Period needs a number/);
  });
  it("catches a period that is not a whole number, and one that is too small", () => {
    expect(validateParams("rsi", { period: 1, sma_period: 9 })[0]).toMatch(/more than 2/);
    expect(validateParams("rsi", { period: 2.5, sma_period: 9 })).toContainEqual(expect.stringMatching(/whole number/));
  });
  it("bounds a threshold between 0 and 1 for efficiency ratio", () => {
    expect(validateParams("efficiency_ratio", { period: 10, trend_threshold: 1.5 })[0]).toMatch(/at most 1/);
    expect(validateParams("efficiency_ratio", { period: 10, trend_threshold: -0.1 })[0]).toMatch(/not be negative/);
  });
});

describe("regimeEligible and crossoverEligible", () => {
  it("keeps every non-RSI type for a regime gate, and only RSI/SuperTrend for a crossover trigger", () => {
    const all = ["rsi", "structure", "efficiency_ratio", "adx", "dmi_direction", "ema_slope", "supertrend"].map((type) => indicator({ id: type, type: type as never }));
    expect(regimeEligible(all).map((i) => i.id)).toEqual(["structure", "efficiency_ratio", "adx", "dmi_direction", "ema_slope", "supertrend"]);
    expect(crossoverEligible(all).map((i) => i.id)).toEqual(["rsi", "supertrend"]);
  });
});

describe("ruleConfigSummary and underlyingSummary", () => {
  const base = { id: "r1", name: "x", description: null, segment: "NSE" as const, underlying: "NIFTY", underlying_type: "symbol" as const, interval: "5min" as const, regime_indicator_ids: [], created_at: "", updated_at: "" };

  it("words each rule type plainly", () => {
    expect(ruleConfigSummary({ ...base, rule_config: { type: "crossover", indicator_id: "i1" } })).toMatch(/signal line/);
    expect(ruleConfigSummary({ ...base, rule_config: { type: "breakout", htf_interval: "60min", htf_breakout_period: 20, ltf_interval: "5min", ltf_breakout_period: 5, ema_filter_enabled: false, ema_period: 20 } })).toBe(
      "5min breaks its own 5-bar range after a 60min 20-bar breakout",
    );
    expect(ruleConfigSummary({ ...base, rule_config: { type: "range_breakout", breakout_period: 20 } })).toMatch(/last 20 candles/);
    expect(ruleConfigSummary({ ...base, rule_config: { type: "multi_condition", direction: "bearish", conditions: [{}, {}] } })).toMatch(/Bearish multi-condition scan \(2 conditions\)/);
    expect(ruleConfigSummary({ ...base, rule_config: null })).toBe("Not configured yet");
  });

  it("describes where a rule scans", () => {
    expect(underlyingSummary({ underlying_type: "symbol", underlying: "NIFTY", segment: "NSE" })).toBe("NIFTY");
    expect(underlyingSummary({ underlying_type: "universe", underlying: "NIFTYBANK", segment: "NSE" })).toBe("Every constituent of NIFTYBANK");
    expect(underlyingSummary({ underlying_type: "watchlist", underlying: "My picks", segment: "NSE" })).toBe('Watchlist "My picks"');
    expect(underlyingSummary({ underlying_type: "symbol_list", underlying: "GOLDM, SILVER,CRUDEOIL", segment: "MCX" })).toBe("GOLDM, SILVER, CRUDEOIL");
    expect(underlyingSummary({ underlying_type: "symbol", underlying: null, segment: "NSE" })).toBe("Not set");
  });
});

describe("validateRuleConfig", () => {
  it("wants an indicator for a crossover rule", () => {
    expect(validateRuleConfig({ type: "crossover", indicator_id: "" })[0]).toMatch(/Pick which indicator/);
    expect(validateRuleConfig({ type: "crossover", indicator_id: "i1" })).toEqual([]);
  });
  it("wants both breakout periods above 1, and the EMA period only when the filter is on", () => {
    const base = { type: "breakout" as const, htf_interval: "60min" as const, htf_breakout_period: 1, ltf_interval: "5min" as const, ltf_breakout_period: 1, ema_filter_enabled: false, ema_period: 1 };
    expect(validateRuleConfig(base)).toHaveLength(2);
    expect(validateRuleConfig({ ...base, ema_filter_enabled: true })).toHaveLength(3);
    expect(validateRuleConfig({ ...base, htf_breakout_period: 20, ltf_breakout_period: 5 })).toEqual([]);
  });
  it("wants a range-breakout period above 1", () => {
    expect(validateRuleConfig({ type: "range_breakout", breakout_period: 1 })).toHaveLength(1);
    expect(validateRuleConfig({ type: "range_breakout", breakout_period: 20 })).toEqual([]);
  });
});

describe("validateUnderlying", () => {
  it("wants something entered, worded for the underlying type", () => {
    expect(validateUnderlying("watchlist", "", "NSE")[0]).toMatch(/Pick a watchlist/);
    expect(validateUnderlying("universe", "", "NSE")[0]).toMatch(/Pick an index/);
    expect(validateUnderlying("symbol", "", "NSE")[0]).toMatch(/Enter a symbol/);
  });
  it("refuses a universe scan outside NSE", () => {
    expect(validateUnderlying("universe", "NIFTYBANK", "MCX")[0]).toMatch(/only works on NSE/);
    expect(validateUnderlying("universe", "NIFTYBANK", "NSE")).toEqual([]);
  });
  it("wants a real symbol in a symbol list, not just commas", () => {
    expect(validateUnderlying("symbol_list", ",, ,", "MCX")).toHaveLength(1);
    expect(validateUnderlying("symbol_list", "GOLDM", "MCX")).toEqual([]);
  });
});

describe("defaultRuleConfig", () => {
  it("gives each type a sensible starting shape", () => {
    expect(defaultRuleConfig("crossover", "i1")).toEqual({ type: "crossover", indicator_id: "i1" });
    expect((defaultRuleConfig("range_breakout") as { breakout_period: number }).breakout_period).toBeGreaterThan(1);
    expect((defaultRuleConfig("breakout") as { ltf_breakout_period: number }).ltf_breakout_period).toBeGreaterThan(1);
  });
});

describe("validateStopLoss", () => {
  it("needs nothing extra when no method is set", () => {
    expect(validateStopLoss({ method: null, interval: null, percent: null, trailing: false, indicatorType: null })).toEqual([]);
  });
  it("previous_candle needs an interval", () => {
    expect(validateStopLoss({ method: "previous_candle", interval: null, percent: null, trailing: false, indicatorType: null })).toHaveLength(1);
    expect(validateStopLoss({ method: "previous_candle", interval: "5min", percent: null, trailing: false, indicatorType: null })).toEqual([]);
  });
  it("percent needs a percent between 0 and 100", () => {
    expect(validateStopLoss({ method: "percent", interval: null, percent: null, trailing: false, indicatorType: null })).toHaveLength(1);
    expect(validateStopLoss({ method: "percent", interval: null, percent: 150, trailing: false, indicatorType: null })).toHaveLength(1);
    expect(validateStopLoss({ method: "percent", interval: null, percent: 1.5, trailing: false, indicatorType: null })).toEqual([]);
  });
  it("breakeven also needs trailing switched on", () => {
    expect(validateStopLoss({ method: "breakeven", interval: null, percent: 1, trailing: false, indicatorType: null })[0]).toMatch(/trailing switched on/);
    expect(validateStopLoss({ method: "breakeven", interval: null, percent: 1, trailing: true, indicatorType: null })).toEqual([]);
  });
  it("indicator needs both an interval and an indicator type", () => {
    expect(validateStopLoss({ method: "indicator", interval: "5min", percent: null, trailing: false, indicatorType: null })).toHaveLength(1);
    expect(validateStopLoss({ method: "indicator", interval: "5min", percent: null, trailing: false, indicatorType: "supertrend" })).toEqual([]);
  });
});

describe("validateWindows", () => {
  it("wants both times, and the end strictly after the start", () => {
    expect(validateWindows([{ start: "09:15", end: "11:00" }])).toEqual([]);
    expect(validateWindows([{ start: "", end: "11:00" }])[0]).toMatch(/Window 1 needs/);
    expect(validateWindows([{ start: "11:00", end: "09:15" }])[0]).toMatch(/must end after/);
  });
});

describe("validateStrategyCore", () => {
  it("wants a name and a source", () => {
    expect(validateStrategyCore({ name: "", source_type: "chartink", instrument_type: "spot", segment: "NSE" })).toHaveLength(1);
    expect(validateStrategyCore({ name: "x", source_type: "", instrument_type: "spot", segment: "NSE" })).toHaveLength(1);
  });
  it("refuses spot on a segment with no spot market", () => {
    expect(validateStrategyCore({ name: "x", source_type: "in_house", instrument_type: "spot", segment: "CRYPTO" })[0]).toMatch(/no spot market/);
    expect(validateStrategyCore({ name: "x", source_type: "in_house", instrument_type: "future", segment: "CRYPTO" })).toEqual([]);
  });
});

describe("strategySummary", () => {
  const s = (over: Partial<Strategy> = {}): Strategy =>
    ({
      id: "s1", name: "x", source_type: "in_house", source_rule_name: null, exchange: "NSE", horizon: "intraday", instrument_type: "future",
      rule_id: "r1", rule: { id: "r1", name: "r", segment: "NSE" }, stop_loss_method: null, stop_loss_interval: null, stop_loss_percent: null,
      stop_loss_indicator_type: null, stop_loss_indicator_params: null, target_percent: null, trailing_stop_enabled: false, exit_condition: null,
      option_position_style: "spread", option_strike_moneyness: "ATM", option_sl_scope: "combined", fixed_lots: null, use_margin: false,
      contract_day_filter: "any", segment: "NSE", duplicate_signal_policy: "skip", counter_signal_policy: "close_and_flip", active_windows: [],
      active_weekdays: [], seed_on_activation: false, status: "draft", last_scan_at: null, last_signal_at: null, created_by: null, created_at: "", updated_at: "", ...over,
    }) as Strategy;

  it("names what it trades, its stop, target and fixed size", () => {
    expect(strategySummary(s({ stop_loss_method: "percent", target_percent: 2, fixed_lots: 1 }))).toBe("future · NSE · SL: a flat percent from entry · target 2% · 1 lot fixed");
    expect(strategySummary(s({}))).toBe("future · NSE");
  });
});
