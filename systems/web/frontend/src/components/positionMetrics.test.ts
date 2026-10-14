import { describe, expect, it } from "vitest";
import { legPnl, spreadDetail, spreadMetrics } from "./positionMetrics";

const leg = (action: "BUY" | "SELL", symbol: string, entry: number, live: number) => ({ id: symbol, symbol, action, quantity: 75, entry_price: entry, exit_price: null, pnl: null, status: "OPEN", live_price: live });

describe("spreadDetail", () => {
  // Sensibull's example: sold 6500 PE at 81, bought 6400 PE at 56.8 -> credit 24.2, width 100, 75 units
  const g = {
    net_debit: -24.2, strike_width: 100, quantity: 75, unrealized_pnl: 1831, live_spot_price: 6400,
    legs: [leg("BUY", "NIFTY-27Oct2026-6400-PE", 56.8, 27), leg("SELL", "NIFTY-27Oct2026-6500-PE", 81, 36.55)],
  };
  it("works out max profit, max loss, what is left and the breakeven", () => {
    const d = spreadDetail(g)!;
    expect(d.maxProfit).toBeCloseTo(1815);
    expect(d.maxLoss).toBeCloseTo(5685);
    expect(d.profitLeft).toBeCloseTo(-16);
    expect(d.lossLeft).toBeCloseTo(7516);
    expect(d.breakeven).toBeCloseTo(6475.8);
  });
  it("is null when the strike width is unknown", () => {
    expect(spreadDetail({ ...g, strike_width: null })).toBeNull();
  });
});

describe("legPnl", () => {
  it("signs a sold leg by the move against it", () => {
    expect(legPnl(leg("SELL", "X-100-PE", 81, 36.55))).toBeCloseTo(3333.75);
    expect(legPnl(leg("BUY", "X-100-PE", 56.8, 27))).toBeCloseTo(-2235);
  });
});

describe("spreadMetrics fund used", () => {
  it("is the strike gap times quantity for a credit spread, the premium paid for a debit spread", () => {
    expect(spreadMetrics({ net_debit: -24.2, strike_width: 100, quantity: 75, unrealized_pnl: 750 }).fundUsed).toBe(7500);
    expect(spreadMetrics({ net_debit: 30, strike_width: 100, quantity: 75, unrealized_pnl: 750 }).fundUsed).toBe(2250);
  });
});
