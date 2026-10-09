import { describe, expect, it } from "vitest";
import { inRupees } from "./rupees";
import { applyLivePrices } from "../pages/liveModel";
import { openLevels } from "../chart/trades";
import type { Position } from "./types";

const base = { id: "p1", symbol: "BTCUSD", exchange: "CRYPTO", segment: "CRYPTO", action: "BUY", horizon: "intraday", instrument_type: "future", quantity: 0.1, entry_price: 80000, entry_time: "2026-10-09T10:00:00Z", exit_price: null, exit_time: null, status: "OPEN", stop_loss_price: 79000, target_price: 82000, option_group_id: null } as unknown as Position;

describe("inRupees", () => {
  it("replaces a crypto trade's dollar P&L with the server's rupee figure, keeping the dollars aside", () => {
    const [p] = inRupees([{ ...base, pnl: null, unrealized_pnl: 50, unrealized_pnl_inr: 4500, currency: "USD", fx: 90 } as Position]);
    expect(p.unrealized_pnl).toBe(4500);
    expect(p.unrealized_pnl_native).toBe(50);
  });
  it("leaves an Indian trade alone", () => {
    const row = { ...base, segment: "NSE", pnl: 100, unrealized_pnl: 50, currency: "INR", fx: 1 } as Position;
    expect(inRupees([row])[0]).toBe(row);
  });
  it("has no figure rather than dollars called rupees when the server had no rate", () => {
    const [p] = inRupees([{ ...base, pnl: 20, unrealized_pnl: 50, pnl_inr: null, unrealized_pnl_inr: null, currency: "USD", fx: null } as Position]);
    expect(p.pnl).toBeNull();
    expect(p.unrealized_pnl).toBeNull();
  });
});

describe("live results of a crypto position", () => {
  const live = { ...base, pnl: null, unrealized_pnl: 0, currency: "USD", fx: 90 } as Position;
  it("are worked out in dollars and shown in rupees", () => {
    const { positions } = applyLivePrices([live], { "CRYPTO:BTCUSD": 80500 });
    expect(positions[0].unrealized_pnl).toBeCloseTo(0.1 * 500 * 90); // $50 = ₹4,500
  });
  it("keep the server's figure when there is no rate", () => {
    const { positions } = applyLivePrices([{ ...live, fx: null, unrealized_pnl: 7 }], { "CRYPTO:BTCUSD": 80500 });
    expect(positions[0].unrealized_pnl).toBe(7);
  });
});

describe("stop and target tags on the chart", () => {
  it("carry rupees for a crypto trade", () => {
    const levels = openLevels("BTCUSD", [{ ...live(), } as Position], []);
    const stop = levels.find((l) => l.field === "stop");
    expect(stop?.label).toContain("₹9,000"); // $1,000 x 0.1 BTC = $100 = ₹9,000
  });
  it("carry no money without a rate", () => {
    const levels = openLevels("BTCUSD", [{ ...live(), fx: null } as Position], []);
    expect(levels.find((l) => l.field === "stop")?.label).not.toMatch(/₹/);
  });
});

function live(): Position {
  return { ...base, pnl: null, unrealized_pnl: 0, currency: "USD", fx: 90 } as Position;
}
