import { describe, expect, it } from "vitest";
import type { OiRow, ScreenerRow } from "../api/types";
import { DEFAULT_MIN_SHIFT, OI_DEFAULTS, PAGE, SCREENER_DEFAULTS, compactCount, defaultViewFromOi, filterOi, filterScreener, classifyBuildup, oiDays, oiQuadrant, oiSignal, oiStrength, oiWindowChange, totalOiChangePct, tradeLink, visible } from "./scanModel";
import QUADRANT_CASES from "./fixtures/oi_quadrant_cases.json";

const oi = (symbol: string, over: Partial<OiRow> = {}): OiRow => ({
  symbol, exchange: "NSE", snapshot_date: "2026-09-25", spot_price: 100, total_call_oi: 1000, total_put_oi: 1000, pcr: 1,
  call_oi_change_pct: 0, put_oi_change_pct: 0, price_change_pct: 0, call_buildup: null, put_buildup: null, history: [], ...over,
});
const scr = (symbol: string, over: Partial<ScreenerRow> = {}): ScreenerRow => ({
  symbol, exchange: "NSE", snapshot_date: "2026-09-25", close: 100, pct_change_5d: 0, pct_change_20d: 0, adx: 20, regime: "ranging",
  high_52w: null, low_52w: null, pct_from_52w_high: null, pct_from_52w_low: null, proximity: null, history: [], ...over,
});

describe("filterOi", () => {
  const rows = [
    oi("AAA", { call_oi_change_pct: 5, call_buildup: "long_buildup", put_buildup: "short_covering" }),
    oi("BBB", { call_oi_change_pct: 20, call_buildup: "short_buildup" }),
    oi("CCC", { call_oi_change_pct: null }),
    oi("DDD", { call_oi_change_pct: -8, call_buildup: "long_unwinding" }),
  ];

  it("sorts by the chosen measure, biggest first, and always puts missing data last", () => {
    expect(filterOi(rows, OI_DEFAULTS).map((r) => r.symbol)).toEqual(["BBB", "AAA", "DDD", "CCC"]);
  });

  it("filters each side of the chain separately", () => {
    expect(filterOi(rows, { ...OI_DEFAULTS, call: "long_buildup" }).map((r) => r.symbol)).toEqual(["AAA"]);
    expect(filterOi(rows, { ...OI_DEFAULTS, put: "short_covering" }).map((r) => r.symbol)).toEqual(["AAA"]);
    expect(filterOi(rows, { ...OI_DEFAULTS, call: "long_buildup", put: "long_unwinding" })).toEqual([]);
  });

  it("searches by symbol, ignoring case and spaces", () => {
    expect(filterOi(rows, { ...OI_DEFAULTS, search: " bb " }).map((r) => r.symbol)).toEqual(["BBB"]);
  });

  it("breaks ties by symbol so the order never shuffles between renders", () => {
    const tied = [oi("ZZZ"), oi("AAA"), oi("MMM")];
    expect(filterOi(tied, OI_DEFAULTS).map((r) => r.symbol)).toEqual(["AAA", "MMM", "ZZZ"]);
  });

  it("does not modify the list it was given", () => {
    const copy = [...rows];
    filterOi(rows, OI_DEFAULTS);
    expect(rows).toEqual(copy);
  });

  it("sorts A to Z on request", () => {
    expect(filterOi(rows, { ...OI_DEFAULTS, sort: "symbol" }).map((r) => r.symbol)).toEqual(["AAA", "BBB", "CCC", "DDD"]);
  });
});

describe("defaultViewFromOi", () => {
  it("reads bullish when the call side is 'good' and the put side isn't", () => {
    expect(defaultViewFromOi(oi("AAA", { call_buildup: "long_buildup", put_buildup: "short_buildup" }))).toBe("BUY");
    expect(defaultViewFromOi(oi("AAA", { call_buildup: "short_covering", put_buildup: "long_unwinding" }))).toBe("BUY");
  });

  it("reads bearish when the put side is 'good' and the call side isn't", () => {
    expect(defaultViewFromOi(oi("AAA", { call_buildup: "short_buildup", put_buildup: "long_buildup" }))).toBe("SELL");
    expect(defaultViewFromOi(oi("AAA", { call_buildup: "long_unwinding", put_buildup: "short_covering" }))).toBe("SELL");
  });

  it("falls back to the day's own price change when both sides read the same way", () => {
    expect(defaultViewFromOi(oi("AAA", { call_buildup: "long_buildup", put_buildup: "long_buildup", price_change_pct: 2 }))).toBe("BUY");
    expect(defaultViewFromOi(oi("AAA", { call_buildup: "long_buildup", put_buildup: "long_buildup", price_change_pct: -2 }))).toBe("SELL");
    expect(defaultViewFromOi(oi("AAA", { call_buildup: null, put_buildup: null, price_change_pct: null }))).toBe("BUY"); // no signal at all - stays on the ticket's own BUY default
  });
});

describe("filterScreener", () => {
  const rows = [
    scr("UP1", { pct_change_5d: 6, regime: "trending_up", proximity: "near_52w_high", adx: 40 }),
    scr("DN1", { pct_change_5d: -4, regime: "trending_down", proximity: "near_52w_low", adx: 35 }),
    scr("RNG", { pct_change_5d: 1, regime: "ranging", adx: 12 }),
    scr("NUL", { pct_change_5d: null, regime: null, adx: null }),
  ];

  it("sorts by 5-day change with missing data last", () => {
    expect(filterScreener(rows, SCREENER_DEFAULTS).map((r) => r.symbol)).toEqual(["UP1", "RNG", "DN1", "NUL"]);
  });

  it("filters by trend and by 52-week proximity", () => {
    expect(filterScreener(rows, { ...SCREENER_DEFAULTS, regime: "trending_down" }).map((r) => r.symbol)).toEqual(["DN1"]);
    expect(filterScreener(rows, { ...SCREENER_DEFAULTS, proximity: "near_52w_high" }).map((r) => r.symbol)).toEqual(["UP1"]);
  });

  it("sorts by trend strength", () => {
    expect(filterScreener(rows, { ...SCREENER_DEFAULTS, sort: "adx" }).map((r) => r.symbol)).toEqual(["UP1", "DN1", "RNG", "NUL"]);
  });
});

describe("helpers", () => {
  it("pages a long list", () => {
    const many = Array.from({ length: 100 }, (_, i) => i);
    expect(visible(many, PAGE)).toHaveLength(PAGE);
    expect(visible(many, 500)).toHaveLength(100);
  });

  it("writes open interest in lakh and crore", () => {
    expect(compactCount(1_234_567)).toBe("12.35L");
    expect(compactCount(25_000_000)).toBe("2.50Cr");
    expect(compactCount(12_300)).toBe("12,300");
  });

  it("links a symbol to the chart, encoded", () => {
    expect(tradeLink("M&M")).toBe("/trade?symbol=M%26M&segment=NSE");
  });
});

describe("major two-sided shifts", () => {
  // The labels compare each side's OI with the UNDERLYING's price move, so "call buyers + put writers arriving" (price up) is a long
  // buildup on both sides, and "call writers + put buyers arriving" (price down) is a short buildup on both.
  const bull = (symbol: string, call: number, put: number) =>
    oi(symbol, { call_buildup: "long_buildup", put_buildup: "long_buildup", call_oi_change_pct: call, put_oi_change_pct: put });
  const bear = (symbol: string, call: number, put: number) =>
    oi(symbol, { call_buildup: "short_buildup", put_buildup: "short_buildup", call_oi_change_pct: call, put_oi_change_pct: put });

  it("defaults to a 10% shift on both sides", () => {
    expect(DEFAULT_MIN_SHIFT).toBe(10);
    expect(OI_DEFAULTS.minShift).toBe(10);
    expect(OI_DEFAULTS.signal).toBe("all");
  });

  it("reads a long buildup on both sides as strongly bullish, and a short buildup on both sides as strongly bearish", () => {
    expect(oiSignal(bull("A", 15, 12), 10)).toBe("strong_bull");
    expect(oiSignal(bear("A", 15, 12), 10)).toBe("strong_bear");
  });

  it("needs the OI to have grown by the threshold on BOTH sides", () => {
    expect(oiSignal(bull("A", 15, 9.9), 10)).toBeNull();
    expect(oiSignal(bull("A", 9.9, 15), 10)).toBeNull();
    expect(oiSignal(bull("A", 10, 10), 10)).toBe("strong_bull"); // exactly the threshold counts
    expect(oiSignal(bull("A", 5, 5), 5)).toBe("strong_bull"); // a lower threshold lets a smaller shift in
  });

  it("does not count mixed or weaker readings, or a missing OI change", () => {
    expect(oiSignal(oi("A", { call_buildup: "long_buildup", put_buildup: "short_buildup", call_oi_change_pct: 20, put_oi_change_pct: 20 }), 10)).toBeNull(); // the sides disagree
    expect(oiSignal(oi("A", { call_buildup: "short_covering", put_buildup: "long_unwinding", call_oi_change_pct: 20, put_oi_change_pct: 20 }), 10)).toBeNull();
    expect(oiSignal(oi("A", { call_buildup: "long_buildup", put_buildup: "long_buildup", call_oi_change_pct: null, put_oi_change_pct: 20 }), 10)).toBeNull();
    expect(oiSignal(oi("A"), 10)).toBeNull();
  });

  const universe = [bull("BULL1", 30, 25), bull("BULL2", 12, 11), bull("SMALL", 6, 5), bear("BEAR1", 18, 14), oi("PLAIN", { call_oi_change_pct: 40 })];

  it("filters to the bullish list at the threshold, biggest shift first when sorted by strength", () => {
    const f = { ...OI_DEFAULTS, signal: "strong_bull" as const, sort: "strength" as const };
    expect(filterOi(universe, f).map((r) => r.symbol)).toEqual(["BULL1", "BULL2"]);
    expect(filterOi(universe, { ...f, minShift: 5 }).map((r) => r.symbol)).toEqual(["BULL1", "BULL2", "SMALL"]);
    expect(filterOi(universe, { ...f, minShift: 20 }).map((r) => r.symbol)).toEqual(["BULL1"]);
  });

  it("filters to the bearish list", () => {
    expect(filterOi(universe, { ...OI_DEFAULTS, signal: "strong_bear" }).map((r) => r.symbol)).toEqual(["BEAR1"]);
  });

  it("combines with the call and put filters, and ignores the threshold when no signal is chosen", () => {
    expect(filterOi(universe, { ...OI_DEFAULTS, signal: "strong_bull", call: "short_buildup" })).toEqual([]);
    expect(filterOi(universe, { ...OI_DEFAULTS, minShift: 99 }).map((r) => r.symbol).sort()).toEqual(["BEAR1", "BULL1", "BULL2", "PLAIN", "SMALL"]);
  });

  it("measures strength as the two OI changes together, with a missing one making it unknown (sorted last)", () => {
    expect(oiStrength(bull("A", 30, 25))).toBe(55);
    expect(oiStrength(oi("A", { call_oi_change_pct: null }))).toBeNull();
    const rows = [oi("NOPE", { call_oi_change_pct: null }), bull("MID", 10, 10), bull("BIG", 30, 30)];
    expect(filterOi(rows, { ...OI_DEFAULTS, sort: "strength" }).map((r) => r.symbol)).toEqual(["BIG", "MID", "NOPE"]);
  });
});

describe("per-stock OI history", () => {
  // oldest first, the latest day last - the shape GET /oi-buildup returns
  const hist = [
    { snapshot_date: "2026-09-24", total_call_oi: 1000, total_put_oi: 2000, spot_price: 100 },
    { snapshot_date: "2026-09-25", total_call_oi: 1100, total_put_oi: 1800, spot_price: 102 }, // price up, call up, put down: calls bought, puts closed
    { snapshot_date: "2026-09-26", total_call_oi: 990, total_put_oi: 1980, spot_price: 101 }, // price down, call down, put up
    { snapshot_date: "2026-09-29", total_call_oi: 1089, total_put_oi: 2178, spot_price: 99.99 }, // price down, both up
  ];

  it("measures each day against the stored day before it, newest first", () => {
    const days = oiDays(hist);
    expect(days.map((d) => d.date)).toEqual(["2026-09-29", "2026-09-26", "2026-09-25"]);
    expect(days[2].callPct).toBeCloseTo(10, 5);
    expect(days[2].putPct).toBeCloseTo(-10, 5);
    expect(days[2].pricePct).toBeCloseTo(2, 5);
    expect(days[2].pcr).toBeCloseTo(1800 / 1100, 5);
  });

  it("reads each side with the same 2x2 the badges use", () => {
    const [latest, middle, first] = oiDays(hist);
    expect([first.callBuildup, first.putBuildup]).toEqual(["long_buildup", "short_covering"]);
    expect([middle.callBuildup, middle.putBuildup]).toEqual(["long_unwinding", "short_buildup"]);
    expect([latest.callBuildup, latest.putBuildup]).toEqual(["short_buildup", "short_buildup"]);
  });

  it("classifies like market-data: flat or unknown reads as nothing", () => {
    expect(classifyBuildup(5, 1)).toBe("long_buildup");
    expect(classifyBuildup(5, -1)).toBe("short_buildup");
    expect(classifyBuildup(-5, 1)).toBe("short_covering");
    expect(classifyBuildup(-5, -1)).toBe("long_unwinding");
    expect(classifyBuildup(0, 1)).toBeNull();
    expect(classifyBuildup(5, 0)).toBeNull();
    expect(classifyBuildup(null, 1)).toBeNull();
    expect(classifyBuildup(5, null)).toBeNull();
  });

  it("shows the last five days when there are more, and needs six points for five days", () => {
    const long = Array.from({ length: 10 }, (_, i) => ({ snapshot_date: `2026-09-${10 + i}`, total_call_oi: 1000 + i * 10, total_put_oi: 1000, spot_price: 100 + i }));
    const days = oiDays(long);
    expect(days).toHaveLength(5);
    expect(days[0].date).toBe("2026-09-19");
    expect(days[4].date).toBe("2026-09-15");
    expect(oiDays(long.slice(-6))).toHaveLength(5);
    expect(oiDays(long.slice(-5))).toHaveLength(4);
  });

  it("has nothing to show for a stock with a single stored day, or none", () => {
    expect(oiDays([hist[0]])).toEqual([]);
    expect(oiDays([])).toEqual([]);
  });

  it("leaves a figure blank rather than guessing when a total or the price is missing or zero", () => {
    const days = oiDays([
      { snapshot_date: "2026-09-24", total_call_oi: 0, total_put_oi: 500, spot_price: null },
      { snapshot_date: "2026-09-25", total_call_oi: 100, total_put_oi: 500, spot_price: 100 },
    ]);
    expect(days[0].callPct).toBeNull(); // a zero base has no percentage
    expect(days[0].callBuildup).toBe(null); // and no price change, so nothing to classify
    expect(days[0].pricePct).toBeNull();
    expect(days[0].putPct).toBeCloseTo(0, 5);
    const bare = oiDays([{ snapshot_date: "2026-09-24" }, { snapshot_date: "2026-09-25" }]);
    expect(bare[0].callPct).toBeNull();
    expect(bare[0].pcr).toBeNull();
  });

  it("gives the whole-window change for call and put, from the first day shown", () => {
    const w = oiWindowChange(hist, 5);
    expect(w.from).toBe("2026-09-24");
    expect(w.callPct).toBeCloseTo(8.9, 5);
    expect(w.putPct).toBeCloseTo(8.9, 5);
    expect(oiWindowChange([hist[0]], 5)).toEqual({ callPct: null, putPct: null, from: null });
    expect(oiWindowChange(hist, 2).from).toBe("2026-09-25"); // two days of change start from the point before them
  });
});


// The same cases market-data's tests run against its Python version (tests/fixtures/oi_quadrant_cases.json): if the two ever disagree one of them fails.
describe("the four quadrants (price against total OI), shared cases with the Telegram digest", () => {
  for (const c of QUADRANT_CASES as { name: string; row: never; oi_change_pct: number | null; quadrant: string | null; strong: boolean }[]) {
    it(c.name, () => {
      const total = totalOiChangePct(c.row);
      if (c.oi_change_pct === null) expect(total).toBeNull();
      else expect(total).toBeCloseTo(c.oi_change_pct, 1);
      expect(oiQuadrant(c.row)).toBe(c.quadrant);
      expect(oiSignal(c.row, 10) !== null).toBe(c.strong);
    });
  }

  const row = (symbol: string, price: number, oiPct: number) => oi(symbol, { total_call_oi: 1000, total_put_oi: 1000, call_oi_change_pct: oiPct, put_oi_change_pct: oiPct, price_change_pct: price });

  it("filters to one quadrant and reads the biggest total OI change first, whichever way the OI moved", () => {
    const rows = [row("SMALL", 1, 8), row("BIG", 2, 40), row("MID", 1.5, 20), row("DOWN", 1, -25), row("NOISE", 0.1, 50)];
    const lb = filterOi(rows, { ...OI_DEFAULTS, signal: "long_buildup", sort: "oi_total" });
    expect(lb.map((r) => r.symbol)).toEqual(["BIG", "MID", "SMALL"]);
    expect(filterOi(rows, { ...OI_DEFAULTS, signal: "short_covering", sort: "oi_total" }).map((r) => r.symbol)).toEqual(["DOWN"]);
    expect(filterOi(rows, { ...OI_DEFAULTS, signal: "short_buildup" })).toEqual([]);
  });

  it("sorts every stock by the size of its total OI change, up or down, with an unknown one last", () => {
    const rows = [row("UP", 1, 10), row("DOWN", 1, -30), oi("NOPE", { total_call_oi: 1000, total_put_oi: 1000, call_oi_change_pct: null, put_oi_change_pct: null })];
    expect(filterOi(rows, { ...OI_DEFAULTS, sort: "oi_total" }).map((r) => r.symbol)).toEqual(["DOWN", "UP", "NOPE"]);
  });

  it("keeps the older strong two-sided filters working beside the quadrants", () => {
    const rows = [oi("BULL", { total_call_oi: 1000, total_put_oi: 1000, call_oi_change_pct: 30, put_oi_change_pct: 30, price_change_pct: 1, call_buildup: "long_buildup", put_buildup: "long_buildup" }), oi("LONELY", { total_call_oi: 1000, total_put_oi: 1000, call_oi_change_pct: 60, put_oi_change_pct: 0, price_change_pct: 1, call_buildup: "long_buildup", put_buildup: "long_buildup" })];
    expect(filterOi(rows, { ...OI_DEFAULTS, signal: "strong_bull" }).map((r) => r.symbol)).toEqual(["BULL"]);
  });
});
