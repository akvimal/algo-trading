import { describe, expect, it } from "vitest";
import { isNakedOption, isSpreadOption, nakedMetrics, spreadMetrics } from "./positionMetrics";

describe("isNakedOption / isSpreadOption", () => {
  it("reads the strategy_type string", () => {
    expect(isNakedOption("naked_call")).toBe(true);
    expect(isNakedOption("naked_put")).toBe(true);
    expect(isNakedOption("bull_call_spread")).toBe(false);
    expect(isSpreadOption("bull_call_spread")).toBe(true);
    expect(isSpreadOption("bear_put_spread")).toBe(true);
    expect(isSpreadOption("bull_put_spread")).toBe(true);
    expect(isSpreadOption("bear_call_spread")).toBe(true);
    expect(isSpreadOption("naked_call")).toBe(false);
  });
});

describe("nakedMetrics", () => {
  it("reads % move of the underlying and % move of the premium straight off the group", () => {
    const m = nakedMetrics({ entry_spot_price: 2500, live_spot_price: 2550, net_debit: 40, live_combined_price: 52 });
    expect(m.spotPct).toBeCloseTo(2); // 2550 vs 2500
    expect(m.premiumPct).toBeCloseTo(30); // 52 vs 40
  });

  it("a losing naked position reads negative", () => {
    const m = nakedMetrics({ entry_spot_price: 2500, live_spot_price: 2450, net_debit: 40, live_combined_price: 10 });
    expect(m.spotPct).toBeCloseTo(-2);
    expect(m.premiumPct).toBeCloseTo(-75);
  });

  it("null when the live quote hasn't loaded, or the entry price is missing/zero", () => {
    expect(nakedMetrics({ entry_spot_price: 2500, live_spot_price: null, net_debit: 40, live_combined_price: null })).toEqual({ spotPct: null, premiumPct: null });
    expect(nakedMetrics({ entry_spot_price: null, live_spot_price: 2550, net_debit: null, live_combined_price: 52 })).toEqual({ spotPct: null, premiumPct: null });
    expect(nakedMetrics({ entry_spot_price: 0, live_spot_price: 2550, net_debit: 0, live_combined_price: 52 })).toEqual({ spotPct: null, premiumPct: null });
  });
});

describe("spreadMetrics", () => {
  it("a debit spread: max loss is net_debit itself, max profit is width minus it", () => {
    // Bull call spread: paid 30 net debit for a 100-wide spread -> max profit 70, max loss 30.
    // Unrealized pnl of 700 on 20 units (qty) -> maxProfitTotal 1400, fundUsedTotal 600.
    const m = spreadMetrics({ net_debit: 30, strike_width: 100, unrealized_pnl: 700, quantity: 20 });
    expect(m.maxProfitPct).toBeCloseTo(50); // 700 / 1400
    expect(m.fundUsedPct).toBeCloseTo((700 / 600) * 100);
  });

  it("a credit spread: max profit is the credit itself, max loss is width minus it", () => {
    // Bull put spread: received 75 net credit (net_debit=-75) on a 200-wide spread -> max profit
    // 75, max loss 125. Unrealized pnl of 300 on 10 units -> maxProfitTotal 750, fundUsedTotal 1250.
    const m = spreadMetrics({ net_debit: -75, strike_width: 200, unrealized_pnl: 300, quantity: 10 });
    expect(m.maxProfitPct).toBeCloseTo(40); // 300 / 750
    expect(m.fundUsedPct).toBeCloseTo(24); // 300 / 1250
  });

  it("a losing position reads negative on both", () => {
    const m = spreadMetrics({ net_debit: 30, strike_width: 100, unrealized_pnl: -15, quantity: 20 });
    expect(m.maxProfitPct).toBeLessThan(0);
    expect(m.fundUsedPct).toBeLessThan(0);
  });

  it("null when strike_width is missing (a group opened before that field existed)", () => {
    expect(spreadMetrics({ net_debit: 30, strike_width: null, unrealized_pnl: 700, quantity: 20 })).toEqual({ maxProfitPct: null, fundUsedPct: null });
  });

  it("null when the live P&L hasn't loaded, or there's no quantity", () => {
    expect(spreadMetrics({ net_debit: 30, strike_width: 100, unrealized_pnl: null, quantity: 20 })).toEqual({ maxProfitPct: null, fundUsedPct: null });
    expect(spreadMetrics({ net_debit: 30, strike_width: 100, unrealized_pnl: 700, quantity: 0 })).toEqual({ maxProfitPct: null, fundUsedPct: null });
  });
});
