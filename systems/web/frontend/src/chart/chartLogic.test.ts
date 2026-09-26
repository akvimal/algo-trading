import { describe, expect, it } from "vitest";
import type { ChartStructure } from "../api/types";
import { fractionalIndexToTs, floorBarIndex, pointTimestamp, toChartPoint, tsToFractionalIndex } from "./anchor";
import {
  DEFAULT_INDICATORS, EMPTY_STRUCTURE, INTERVALS, effectiveParams, intervalDef, loadDrawings, loadIndicatorParams, loadIndicators, loadStructure,
  loadTools, lookbackRange, parseParamList, pricePrecision, saveDrawings, saveIndicatorParams, saveIndicators, saveStructure, saveTools, toKLine,
} from "./config";
import { rollLiveBar, type Bar } from "./liveBar";
import { liveSetups, structureOverlays } from "./structure";

describe("anchor: drawings stay put when the candle size changes", () => {
  // Market hours only: a gap from 15:15 to 09:15 next day, not evenly spaced.
  const t = [1000, 2000, 3000, 10_000, 11_000];

  it("finds the last bar at or before a time", () => {
    expect(floorBarIndex(500, t)).toBe(-1);
    expect(floorBarIndex(1000, t)).toBe(0);
    expect(floorBarIndex(2500, t)).toBe(1);
    expect(floorBarIndex(99_999, t)).toBe(4);
  });

  it("interpolates between the real bars either side, not across calendar time", () => {
    expect(tsToFractionalIndex(1500, { timestamps: t })).toBe(0.5);
    expect(tsToFractionalIndex(3000, { timestamps: t })).toBe(2);
    // Halfway through the overnight gap is halfway between bar 2 and bar 3, however long the gap
    expect(tsToFractionalIndex(6500, { timestamps: t })).toBe(2.5);
  });

  it("extrapolates a time before the first bar and after the last", () => {
    expect(tsToFractionalIndex(0, { timestamps: t })).toBe(-1);
    expect(tsToFractionalIndex(12_000, { timestamps: t })).toBe(5);
    expect(tsToFractionalIndex(5, { timestamps: [] })).toBeNull();
    expect(tsToFractionalIndex(Number.NaN, { timestamps: t })).toBeNull();
  });

  it("goes back from an index to a time, and the two are inverses on real and fractional positions", () => {
    for (const ts of [1000, 1500, 2500, 6500, 10_500, 11_000]) {
      const idx = tsToFractionalIndex(ts, { timestamps: t })!;
      expect(fractionalIndexToTs(idx, { timestamps: t })).toBeCloseTo(ts, 6);
    }
  });

  it("hands the library an index OR a timestamp, never both", () => {
    expect(toChartPoint({ timestamp: 1500, value: 7 }, { timestamps: t })).toEqual({ dataIndex: 0.5, value: 7 });
    expect(toChartPoint({ timestamp: 1500, value: 7 }, null)).toEqual({ timestamp: 1500, value: 7 });
    expect(toChartPoint({ value: 7 }, { timestamps: t })).toEqual({ timestamp: undefined, value: 7 });
  });

  it("recovers the real time of a dragged point that only carries an index", () => {
    expect(pointTimestamp({ dataIndex: 0.5, value: 1 }, { timestamps: t })).toBe(1500);
    expect(pointTimestamp({ timestamp: 42, dataIndex: 0.5 }, { timestamps: t })).toBe(42);
    expect(pointTimestamp({ dataIndex: 1 }, null)).toBeUndefined();
  });
});

describe("live bar", () => {
  const bar: Bar = { timestamp: 0, open: 100, high: 105, low: 95, close: 102, volume: 1 };
  const MIN = 60_000;

  it("moves the close and stretches the range while the bar's window is open", () => {
    expect(rollLiveBar(bar, 110, 30_000, MIN)).toMatchObject({ close: 110, high: 110, low: 95, open: 100 });
    expect(rollLiveBar(bar, 90, 30_000, MIN)).toMatchObject({ close: 90, high: 105, low: 90 });
  });

  it("does nothing when nothing would change, or when there is no usable price", () => {
    expect(rollLiveBar(bar, 102, 30_000, MIN)).toBeNull();
    expect(rollLiveBar(bar, null, 30_000, MIN)).toBeNull();
    expect(rollLiveBar(bar, Number.NaN, 30_000, MIN)).toBeNull();
    expect(rollLiveBar(null, 100, 0, MIN)).toBeNull();
  });

  it("starts the next bar once the window has ended, while the market is plausibly open", () => {
    expect(rollLiveBar(bar, 103, MIN + 5_000, MIN)).toEqual({ timestamp: MIN, open: 102, high: 103, low: 102, close: 103, volume: 0 });
  });

  it("leaves a stale series alone: no phantom bars after the market closes", () => {
    expect(rollLiveBar(bar, 103, 5 * MIN, MIN)).toBeNull();
  });

  it("never starts a bar on the daily chart (a Saturday would get one)", () => {
    const DAY = 86_400_000;
    expect(rollLiveBar(bar, 103, DAY + 3_600_000, DAY, false)).toBeNull();
    expect(rollLiveBar(bar, 103, DAY - 1, DAY, false)).toMatchObject({ close: 103 });
  });
});

describe("saved chart settings", () => {
  it("indicators default, save and survive garbage", () => {
    expect(loadIndicators()).toEqual(DEFAULT_INDICATORS);
    saveIndicators(["EMA", "RSI"]);
    expect(loadIndicators()).toEqual(["EMA", "RSI"]);
    localStorage.setItem("web.chart.indicators", "not json");
    expect(loadIndicators()).toEqual(DEFAULT_INDICATORS);
    localStorage.setItem("web.chart.indicators", JSON.stringify(["MA", "NOPE"]));
    expect(loadIndicators()).toEqual(["MA"]); // an unknown name is dropped
  });

  it("keeps an emptied parameter list: 'no lines' is a choice, not a missing value", () => {
    saveIndicatorParams({ MA: [], EMA: [9, 21] });
    expect(loadIndicatorParams()).toEqual({ MA: [], EMA: [9, 21] });
    expect(effectiveParams("MA", loadIndicatorParams())).toEqual([]);
    expect(effectiveParams("VOL", {})).toEqual([5, 10, 20]);
    expect(effectiveParams("BOLL", {})).toBeUndefined();
  });

  it("drops saved parameters for an indicator that has none to edit", () => {
    saveIndicatorParams({ BOLL: [1, 2] });
    expect(loadIndicatorParams()).toEqual({});
  });

  it("reads a comma list, allowing fractions and refusing nonsense", () => {
    expect(parseParamList("5, 10 ,20")).toEqual([5, 10, 20]);
    expect(parseParamList("10, 2.5")).toEqual([10, 2.5]);
    expect(parseParamList("")).toEqual([]);
    expect(parseParamList("0, -3, abc, 501, 14")).toEqual([14]);
  });

  it("the structure layer is off until asked, and only valid timeframes load", () => {
    expect(loadStructure()).toEqual(EMPTY_STRUCTURE);
    saveStructure({ tfs: ["15min", "60min"], breakers: true, fvg: false, breaks: true, trendMarks: false, setups: true });
    expect(loadStructure()).toMatchObject({ tfs: ["15min", "60min"], breakers: true, breaks: true, setups: true });
    localStorage.setItem("web.chart.structure", JSON.stringify({ tfs: ["15min", "7min", 3] }));
    expect(loadStructure().tfs).toEqual(["15min"]);
  });

  it("tool settings default off", () => {
    expect(loadTools()).toEqual({ magnet: false, drawingsHidden: false, indicatorsHidden: false });
    saveTools({ magnet: true, drawingsHidden: false, indicatorsHidden: true });
    expect(loadTools()).toEqual({ magnet: true, drawingsHidden: false, indicatorsHidden: true });
  });

  it("drawings are kept per instrument, shared by every candle size", () => {
    saveDrawings("NSE", "NIFTY", [{ name: "segment", points: [{ timestamp: 1, value: 2 }] }]);
    expect(loadDrawings("NSE", "NIFTY")).toHaveLength(1);
    expect(loadDrawings("NSE", "BANKNIFTY")).toEqual([]);
    localStorage.setItem("web.chart.drawings:NSE:NIFTY", JSON.stringify([{ nope: true }]));
    expect(loadDrawings("NSE", "NIFTY")).toEqual([]); // malformed is ignored, not crashed on
  });

  it("does not throw when storage is blocked", () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(() => saveIndicators(["MA"])).not.toThrow();
    } finally {
      Storage.prototype.setItem = orig;
    }
  });
});

describe("candle sizes and precision", () => {
  it("knows each size, and falls back to 15 minutes for an unknown one", () => {
    expect(INTERVALS.map((i) => i.label)).toEqual(["1m", "3m", "5m", "15m", "30m", "1h", "1d"]);
    expect(intervalDef("60min").label).toBe("1h");
    expect(intervalDef("bogus").value).toBe("15min");
    expect(intervalDef("daily").source).toBe("yahoo"); // daily comes from a provider that needs no Dhan token
  });

  it("uses the decimals that tell adjacent ticks apart", () => {
    expect(pricePrecision(23140)).toBe(2);
    expect(pricePrecision(12.5)).toBe(3);
    expect(pricePrecision(0.4)).toBe(6);
  });

  it("converts a candle to the library's shape, with millisecond time", () => {
    expect(toKLine({ exchange: "NSE", symbol: "X", interval: "15min", open: 1, high: 2, low: 0.5, close: 1.5, volume: 9, timestamp: "1970-01-01T00:00:01Z" })).toEqual({
      timestamp: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9,
    });
  });

  it("works out the download range ending today", () => {
    expect(lookbackRange(3, new Date("2026-09-26T10:00:00Z"))).toEqual({ from: "2026-09-23", to: "2026-09-26" });
  });
});

describe("structure overlays", () => {
  const data: ChartStructure = {
    trend: "up",
    order_blocks: [
      { kind: "demand", role: "orderblock", proximal: 100, distal: 95, origin_timestamp: "2026-09-25T09:15:00+05:30", mitigated: false, counter_trend: false },
      { kind: "supply", role: "breaker", proximal: 120, distal: 125, origin_timestamp: "not a date", mitigated: true, counter_trend: true },
    ],
    fvgs: [{ kind: "bullish", top: 110, bottom: 108, origin_timestamp: "2026-09-25T10:00:00+05:30", filled: false }],
    events: [{ kind: "choch", direction: "up", price: 105, timestamp: "2026-09-25T11:00:00+05:30", from_timestamp: "2026-09-25T10:15:00+05:30" }],
    trend_changes: [{ timestamp: "2026-09-25T11:00:00+05:30", price: 105, trend: "up" }],
    setups: [
      { direction: "long", status: "triggered", entry: 106, stop_loss: 103, target: 112, risk_reward: 2, zone_proximal: 100, zone_distal: 95, confirmed_timestamp: "2026-09-25T11:30:00+05:30", resolved_timestamp: null },
      { direction: "short", status: "hit_target", entry: 118, stop_loss: 121, target: 112, risk_reward: 2, zone_proximal: 120, zone_distal: 125, confirmed_timestamp: "2026-09-25T09:30:00+05:30", resolved_timestamp: "2026-09-25T10:30:00+05:30" },
    ],
  };
  const all = { ...EMPTY_STRUCTURE, tfs: ["15min"], breaks: true, trendMarks: true, setups: true };

  it("draws zones and gaps always, and the optional layers only when asked", () => {
    expect(structureOverlays("15m", data, EMPTY_STRUCTURE).map((o) => o.name).sort()).toEqual(["htfFvg", "htfOrderBlock"]);
    const names = structureOverlays("15m", data, all).map((o) => o.name).sort();
    expect(names).toEqual(["htfFvg", "htfOrderBlock", "htfSetup", "htfSetup", "htfStructureBreak", "htfTrendMark"]);
  });

  it("skips anything whose time cannot be read, rather than drawing it at NaN", () => {
    const blocks = structureOverlays("15m", data, EMPTY_STRUCTURE).filter((o) => o.name === "htfOrderBlock");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].points[0].value).toBe(100);
  });

  it("anchors a live setup once (it extends itself to the edge) and a resolved one twice", () => {
    const setups = structureOverlays("15m", data, all).filter((o) => o.name === "htfSetup");
    expect(setups[0].points).toHaveLength(1);
    expect(setups[1].points).toHaveLength(2);
    expect(setups[1].points[1].timestamp).toBeGreaterThan(setups[1].points[0].timestamp);
  });

  it("labels each with its timeframe and carries the counter-trend flag", () => {
    const ob = structureOverlays("1h", data, EMPTY_STRUCTURE).find((o) => o.name === "htfOrderBlock")!;
    expect(ob.extendData).toMatchObject({ tf: "1h", kind: "demand", counterTrend: false });
  });

  it("lists only setups still in play, triggered first, capped", () => {
    const live = liveSetups([{ label: "15m", data }, { label: "5m", data: { ...data, setups: [{ ...data.setups[0], status: "confirmed" }] } }]);
    expect(live.map((s) => `${s.tf} ${s.status}`)).toEqual(["15m triggered", "5m confirmed"]);
    expect(liveSetups([{ label: "15m", data }], 0)).toEqual([]);
  });
});
