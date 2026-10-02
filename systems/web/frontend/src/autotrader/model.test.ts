import { beforeEach, describe, expect, it } from "vitest";
import {
  ADX_PARAMS, DEFAULT_CONFIG, buildProvision, cleanConfig, configFromServer, loadAutoTraderVisible, optionEligible, sameConfig, saveAutoTraderVisible,
  strategyName, summarise, tagFor, validateConfig,
} from "./model";
import { tradeRows } from "./trades";

const cfg = (over: object = {}) => ({ ...DEFAULT_CONFIG, ...over });

describe("loadAutoTraderVisible and saveAutoTraderVisible", () => {
  beforeEach(() => localStorage.clear());

  it("is off until the person turns it on", () => {
    expect(loadAutoTraderVisible()).toBe(false);
  });
  it("remembers the choice", () => {
    saveAutoTraderVisible(true);
    expect(loadAutoTraderVisible()).toBe(true);
    saveAutoTraderVisible(false);
    expect(loadAutoTraderVisible()).toBe(false);
  });
  it("treats anything but the exact saved 'true' as off", () => {
    localStorage.setItem("web.autotrader.visible", "yes");
    expect(loadAutoTraderVisible()).toBe(false);
  });
});

describe("validateConfig", () => {
  it("accepts the defaults", () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual([]);
  });
  it("says what is wrong, in words, for each setting", () => {
    expect(validateConfig(cfg({ period: 1 }))[0]).toMatch(/2 to 100 candles/);
    expect(validateConfig(cfg({ period: 2.5 }))).toHaveLength(1);
    expect(validateConfig(cfg({ multiplier: 0.1 }))[0]).toMatch(/multiplier/);
    expect(validateConfig(cfg({ multiplier: Number.NaN }))).toHaveLength(1);
    expect(validateConfig(cfg({ lots: 0 }))[0]).toMatch(/Lots/);
    expect(validateConfig(cfg({ lots: 1.5 }))).toHaveLength(1);
    expect(validateConfig(cfg({ balance: 0 }))[0]).toMatch(/Practice money/);
  });
  it("checks each window: both times present, and the end after the start", () => {
    expect(validateConfig(cfg({ windows: [{ start: "09:15", end: "11:00" }, { start: "13:00", end: "15:15" }] }))).toEqual([]);
    expect(validateConfig(cfg({ windows: [{ start: "11:00", end: "09:15" }] }))[0]).toBe("Window 1 must end after it starts.");
    expect(validateConfig(cfg({ windows: [{ start: "09:15", end: "09:15" }] }))).toHaveLength(1);
    expect(validateConfig(cfg({ windows: [{ start: "", end: "11:00" }] }))[0]).toBe("Window 1 needs a start and an end time.");
    expect(validateConfig(cfg({ windows: [{ start: "9:15", end: "11:00" }] }))).toHaveLength(1); // not HH:MM
  });
});

describe("cleanConfig", () => {
  it("falls back to the default for anything missing or out of range, and keeps what is good", () => {
    expect(cleanConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(cleanConfig("nonsense")).toEqual(DEFAULT_CONFIG);
    const c = cleanConfig({ instrument: "option", moneyness: "OTM1", period: 14, multiplier: 2.5, interval: "15min", lots: 3, adxGate: true, balance: 250000, windows: [{ start: "09:15", end: "10:30" }] });
    expect(c).toEqual({ instrument: "option", moneyness: "OTM1", period: 14, multiplier: 2.5, interval: "15min", lots: 3, adxGate: true, balance: 250000, windows: [{ start: "09:15", end: "10:30" }] });
    expect(cleanConfig({ instrument: "swap", moneyness: "FAR", period: 1000, multiplier: -1, interval: "2min", lots: 0, adxGate: "yes", balance: -5 })).toEqual(DEFAULT_CONFIG);
  });
  it("drops a window that is malformed or ends before it starts, and keeps the rest", () => {
    expect(cleanConfig({ windows: [{ start: "10:00", end: "09:00" }, { start: "bad", end: "11:00" }, null, { start: "09:15", end: "11:00" }] }).windows).toEqual([{ start: "09:15", end: "11:00" }]);
  });
  it("rounds lots and the period to whole numbers and the multiplier to two places", () => {
    const c = cleanConfig({ period: 10.4, lots: 2.6, multiplier: 2.456 });
    expect([c.period, c.lots, c.multiplier]).toEqual([10, 3, 2.46]);
  });
});

describe("identity", () => {
  it("names a strategy by market and instrument, the way the classic app does", () => {
    expect(tagFor("NSE", " banknifty ")).toBe("NSE:BANKNIFTY");
    expect(strategyName("CRYPTO", "BTCUSD")).toBe("Auto-trade: CRYPTO:BTCUSD");
  });
  it("offers options everywhere except crypto instruments that have none", () => {
    expect(optionEligible("NSE", "NIFTY")).toBe(true);
    expect(optionEligible("MCX", "GOLDM")).toBe(true);
    expect(optionEligible("CRYPTO", "btcusd")).toBe(true);
    expect(optionEligible("CRYPTO", "SOLUSD")).toBe(false);
  });
});

describe("buildProvision", () => {
  it("watches a SuperTrend crossover on the chosen interval, and trails the same line as the stop", () => {
    const p = buildProvision(cfg({ interval: "15min", period: 12, multiplier: 2 }), "NSE", "nifty");
    expect(p.supertrend).toEqual({ name: "Auto-trade ST: NSE:NIFTY", type: "supertrend", params: { period: 12, multiplier: 2 } });
    expect(p.rule("st1", [])).toEqual({
      name: "Auto-trade: NSE:NIFTY", segment: "NSE", underlying: "NIFTY", underlying_type: "symbol", interval: "15min",
      rule_config: { type: "crossover", indicator_id: "st1" }, regime_indicator_ids: [],
    });
    expect(p.strategy("r1")).toMatchObject({
      instrument_type: "future", rule_id: "r1", stop_loss_method: "indicator", stop_loss_interval: "15min", stop_loss_indicator_type: "supertrend",
      stop_loss_indicator_params: { period: 12, multiplier: 2 }, trailing_stop_enabled: true, fixed_lots: 1, counter_signal_policy: "close_and_flip",
      duplicate_signal_policy: "skip", seed_on_activation: true, active_windows: [],
    });
  });
  it("adds the ADX and direction indicators only when the gate is on", () => {
    expect(buildProvision(cfg(), "NSE", "NIFTY").adx).toBeNull();
    const gated = buildProvision(cfg({ adxGate: true }), "NSE", "NIFTY");
    expect(gated.adx).toEqual({ name: "Auto-trade ADX: NSE:NIFTY", type: "adx", params: ADX_PARAMS });
    expect(gated.dmi?.type).toBe("dmi_direction");
  });
  it("trades a naked option at the chosen strike, and says nothing of options for a future", () => {
    const opt = buildProvision(cfg({ instrument: "option", moneyness: "OTM1" }), "NSE", "NIFTY").strategy("r");
    expect(opt).toMatchObject({ instrument_type: "option", option_position_style: "naked", option_strike_moneyness: "OTM1" });
    const fut = buildProvision(cfg({ moneyness: "OTM1" }), "NSE", "NIFTY").strategy("r");
    expect(fut.option_position_style).toBeUndefined();
    expect(fut.option_strike_moneyness).toBeUndefined();
  });
  it("passes the entry windows through", () => {
    expect(buildProvision(cfg({ windows: [{ start: "09:15", end: "11:00" }] }), "NSE", "NIFTY").strategy("r").active_windows).toEqual([{ start: "09:15", end: "11:00" }]);
  });
});

describe("configFromServer", () => {
  const server = { instrument_type: "option", option_strike_moneyness: "ITM1", stop_loss_indicator_params: { period: 7, multiplier: 2 }, fixed_lots: 4, active_windows: [{ start: "09:15", end: "10:00" }] };
  it("reads back what the server is running", () => {
    expect(configFromServer(server, { interval: "15min", regime_indicator_ids: ["a", "b"] }, 50000)).toEqual({
      instrument: "option", moneyness: "ITM1", period: 7, multiplier: 2, interval: "15min", lots: 4, adxGate: true, windows: [{ start: "09:15", end: "10:00" }], balance: 50000,
    });
  });
  it("round-trips: what is built is what is read back", () => {
    const c = cfg({ instrument: "option", moneyness: "OTM2", period: 9, multiplier: 2.5, interval: "30min", lots: 2, adxGate: true, windows: [{ start: "10:00", end: "12:00" }], balance: 75000 });
    const p = buildProvision(c, "NSE", "NIFTY");
    const back = configFromServer(p.strategy("r") as never, p.rule("s", ["x", "y"]) as never, 75000);
    expect(back).toEqual(c);
  });
  it("copes with a strategy set up elsewhere with fields missing", () => {
    expect(configFromServer({ instrument_type: "future", fixed_lots: null, active_windows: [] }, null, null)).toEqual(DEFAULT_CONFIG);
  });
});

describe("summarise and sameConfig", () => {
  it("says it in one line", () => {
    expect(summarise(DEFAULT_CONFIG)).toBe("5m SuperTrend (10, 3) · future · 1 lot");
    expect(summarise(cfg({ instrument: "option", moneyness: "ATM", lots: 3, adxGate: true, windows: [{ start: "09:15", end: "11:00" }] }))).toBe(
      "5m SuperTrend (10, 3) · naked option, at the money · 3 lots · ADX gate · 09:15–11:00",
    );
  });
  it("ignores the practice money when deciding whether a setting changed", () => {
    expect(sameConfig(cfg({ balance: 1 }), cfg({ balance: 999 }))).toBe(true);
    expect(sameConfig(cfg(), cfg({ lots: 2 }))).toBe(false);
    expect(sameConfig(cfg(), cfg({ windows: [{ start: "09:15", end: "10:00" }] }))).toBe(false);
  });
});

describe("tradeRows", () => {
  const pos = (over: object) => ({ id: "p", symbol: "NIFTY-Sep2026-FUT", action: "BUY", status: "OPEN", option_group_id: null, entry_time: "2026-09-26T04:00:00Z", exit_time: null, unrealized_pnl: 120, pnl: null, exit_reason: null, ...over }) as never;
  const grp = (over: object) => ({ id: "g", underlying_symbol: "NIFTY", strategy_type: "naked_call", action: "BUY", status: "CLOSED", entry_time: "2026-09-26T05:00:00Z", exit_time: "2026-09-26T06:00:00Z", pnl: -80, unrealized_pnl: null, exit_reason: "spot_stop_loss", ...over }) as never;

  it("lists both kinds newest first, with the live result while open and the booked one once closed", () => {
    const rows = tradeRows([pos({}), pos({ id: "c", status: "CLOSED", pnl: 300, unrealized_pnl: 5, exit_time: "2026-09-26T07:00:00Z", exit_reason: "counter_signal" })], [grp({})]);
    expect(rows.map((r) => [r.id, r.state, r.pnl])).toEqual([["c", "closed", 300], ["g", "closed", -80], ["p", "open", 120]]);
    expect(rows.find((r) => r.id === "g")!.label).toBe("NIFTY naked call");
  });
  it("leaves out option legs (they belong to their group), and anything rejected", () => {
    expect(tradeRows([pos({ id: "leg", option_group_id: "g" }), pos({ id: "rej", status: "REJECTED" })], [grp({ status: "REJECTED" })])).toEqual([]);
  });
  it("keeps only the latest few", () => {
    const many = Array.from({ length: 12 }, (_, i) => pos({ id: `p${i}`, entry_time: `2026-09-26T04:${String(i).padStart(2, "0")}:00Z` }));
    const rows = tradeRows(many, [], 5);
    expect(rows).toHaveLength(5);
    expect(rows[0].id).toBe("p11");
  });
});
