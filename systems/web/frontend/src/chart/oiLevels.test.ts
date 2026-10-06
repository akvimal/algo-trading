import { describe, expect, it } from "vitest";
import type { OiSummary } from "../api/types";
import { compactIndian, computeOiLevels, closestOiLevels, hasOiChain, oiCount, oiLevelLines } from "./oiLevels";

const leg = (oi: number, change15: number | null = null) => ({ oi, oi_change_5m: null, oi_change_15m: change15, volume: 0 });

/** A chain around 24,500: call walls above, put walls below. */
const chain = (over: Partial<OiSummary> = {}): OiSummary => ({
  underlying_symbol: "NIFTY", underlying_exchange: "NSE", expiry: "2026-09-29", underlying_last_price: 24500, total_call_oi: 0, total_put_oi: 0, pcr: 1,
  total_call_oi_change_5m: null, total_put_oi_change_5m: null, total_call_oi_change_15m: null, total_put_oi_change_15m: null, total_call_buildup: null, total_put_buildup: null,
  strikes: [
    { strike: 24200, call: leg(9_000_000), put: leg(2_000_000, 50_000) },
    { strike: 24300, call: leg(1_000_000), put: leg(5_000_000, 10_000) },
    { strike: 24400, call: leg(800_000), put: leg(3_000_000, 90_000) },
    { strike: 24500, call: leg(4_000_000, 20_000), put: leg(4_500_000) },
    { strike: 24600, call: leg(6_000_000, 200_000), put: leg(500_000) },
    { strike: 24700, call: leg(7_000_000), put: leg(400_000) },
    { strike: 24800, call: leg(5_000_000), put: leg(300_000) },
  ],
  ...over,
});

describe("computeOiLevels", () => {
  it("takes resistance from call open interest at or above the price and support from puts at or below", () => {
    const levels = computeOiLevels(chain());
    const solid = levels.filter((l) => !l.forming);
    expect(solid.filter((l) => l.kind === "resistance").map((l) => [l.rank, l.strike])).toEqual([[1, 24700], [2, 24600]]);
    expect(solid.filter((l) => l.kind === "support").map((l) => [l.rank, l.strike])).toEqual([[1, 24300], [2, 24500]]);
  });

  it("ignores a big call wall the price has already gone through", () => {
    // 24,200 carries the most call open interest, but it is below the price: broken, not resistance.
    const resistance = computeOiLevels(chain()).filter((l) => l.kind === "resistance");
    expect(resistance.some((l) => l.strike === 24200)).toBe(false);
  });

  it("adds the fastest-building strike on a side when it is not already one of the two walls", () => {
    const forming = computeOiLevels(chain()).filter((l) => l.forming);
    // Puts: the most added in 15 minutes is 24,400 (+90K), which is not one of the two biggest put walls.
    expect(forming).toEqual([{ kind: "support", rank: 2, forming: true, strike: 24400, oi: 0, oiChange: 90_000 }]);
  });

  it("does not repeat a strike that is already a wall as a forming level", () => {
    const c = chain();
    c.strikes.find((s) => s.strike === 24600)!.call = leg(6_000_000, 200_000); // already resistance 2
    expect(computeOiLevels(c).filter((l) => l.forming && l.kind === "resistance")).toEqual([]);
  });

  it("gives nothing for an empty chain, and no forming level before the change data has warmed up", () => {
    expect(computeOiLevels(chain({ strikes: [] }))).toEqual([]);
    const cold = chain();
    for (const s of cold.strikes) {
      if (s.call) s.call.oi_change_15m = null;
      if (s.put) s.put.oi_change_15m = null;
    }
    expect(computeOiLevels(cold).some((l) => l.forming)).toBe(false);
  });
});

describe("oiLevelLines", () => {
  it("words each tag: rank, strike and how much is there, or how fast it is building", () => {
    const lines = oiLevelLines(chain());
    expect(lines.find((l) => l.kind === "resistance" && l.rank === 1)).toMatchObject({ price: 24700, label: "R1 24700 · 70.00L OI" });
    expect(lines.find((l) => l.kind === "support" && l.rank === 1)!.label).toBe("S1 24300 · 50.00L OI");
    expect(lines.find((l) => l.forming)).toMatchObject({ price: 24400, label: "S forming 24400 · +90.0K/15m" });
  });

  it("counts crypto open interest as contracts, not in lakhs and crores", () => {
    const lines = oiLevelLines(chain({ underlying_exchange: "CRYPTO", underlying_symbol: "BTCUSD" }));
    expect(lines.find((l) => l.kind === "resistance" && l.rank === 1)!.label).toBe("R1 24700 · 7,000,000 OI");
  });
});

describe("formatting and which instruments have a chain", () => {
  it("writes Indian compact numbers", () => {
    expect(compactIndian(950)).toBe("950");
    expect(compactIndian(85_000)).toBe("85.0K");
    expect(compactIndian(1_200_000)).toBe("12.00L");
    expect(compactIndian(3_20_00_000)).toBe("3.20Cr");
    expect(oiCount(1_200_000, true)).toBe("1,200,000");
  });

  it("knows the instruments with an option chain, whatever the case", () => {
    for (const s of ["NIFTY", "banknifty", " GOLDM ", "CRUDEOILM", "BTCUSD", "ETHUSD"]) expect(hasOiChain(s)).toBe(true);
    for (const s of ["RELIANCE", "SENSEX", ""]) expect(hasOiChain(s)).toBe(false);
  });
});

describe("closestOiLevels", () => {
  const L = (kind: "resistance" | "support", price: number, rank: 1 | 2 = 1, forming = false) => ({ kind, rank, forming, price, label: `${kind}${price}` });
  const levels = [L("resistance", 24500), L("resistance", 24800, 2), L("support", 24300), L("support", 24000, 2), L("resistance", 24450, 1, true)];
  it("keeps the nearest wall on each side of the price and ignores forming ones", () => {
    expect(closestOiLevels(levels, 24400).map((l) => l.price)).toEqual([24500, 24300]);
  });
  it("falls back to the nearest of a side when price is past all its walls", () => {
    expect(closestOiLevels(levels, 25000).map((l) => l.price)).toEqual([24800, 24300]);
  });
  it("takes the biggest wall (rank 1) of each side without a price", () => {
    expect(closestOiLevels(levels, null).map((l) => l.price)).toEqual([24500, 24300]);
  });
});
