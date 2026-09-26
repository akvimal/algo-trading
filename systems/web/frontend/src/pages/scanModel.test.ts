import { describe, expect, it } from "vitest";
import type { OiRow, ScreenerRow } from "../api/types";
import { OI_DEFAULTS, PAGE, SCREENER_DEFAULTS, compactCount, filterOi, filterScreener, tradeLink, visible } from "./scanModel";

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
