import { describe, expect, it } from "vitest";
import type { ChartStructure } from "../api/types";
import { fractionalIndexToTs, floorBarIndex, pointTimestamp, toChartPoint, tsToFractionalIndex } from "./anchor";
import {
  DEFAULT_INDICATORS, EMPTY_STRUCTURE, INTERVALS, effectiveParams, intervalDef, loadDrawingDefaults, loadDrawings, loadIndicatorParams, loadIndicators, loadStructure,
  loadTools, lookbackRange, parseParamList, pricePrecision, resetStructureForInterval, saveDrawingDefault, saveDrawings, saveIndicatorParams, saveIndicators, saveStructure, saveTools, toggleStructureOn, toKLine,
} from "./config";
import { rollLiveBar, type Bar } from "./liveBar";
import { liveSetups, structureOverlays } from "./structure";

describe("anchor: drawings stay put when the interval changes", () => {
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

  describe("resetStructureForInterval", () => {
    it("drops timeframes finer than the new interval and keeps coarser ones", () => {
      expect(resetStructureForInterval(["5min", "15min", "60min"], "15min")).toEqual(["15min", "60min"]);
    });

    it("adds the new size itself if it's a valid structure timeframe and not already selected", () => {
      expect(resetStructureForInterval(["60min", "daily"], "15min")).toEqual(["15min", "60min", "daily"]);
    });

    it("does not duplicate the new size if it's already selected", () => {
      expect(resetStructureForInterval(["15min", "60min"], "15min")).toEqual(["15min", "60min"]);
    });

    it("drops every old selection once the new size is coarser than all of them, but still adds the new size itself", () => {
      expect(resetStructureForInterval(["1min", "5min"], "60min")).toEqual(["60min"]);
    });

    it("weekly has no structure-timeframe entry, so nothing is added for it - and daily (finer than a week) is dropped like anything else finer than the new size", () => {
      expect(resetStructureForInterval(["15min", "60min", "daily"], "weekly")).toEqual([]);
    });

    it("is a no-op while the structure layer is off - never turns it on by itself", () => {
      expect(resetStructureForInterval([], "60min")).toEqual([]);
    });
  });

  describe("toggleStructureOn", () => {
    it("off clears every ticked timeframe, regardless of what was selected", () => {
      expect(toggleStructureOn(false, "15min")).toEqual([]);
      expect(toggleStructureOn(false, "60min")).toEqual([]);
    });

    it("on seeds a single fresh timeframe - the active chart's own interval", () => {
      expect(toggleStructureOn(true, "60min")).toEqual(["60min"]);
    });

    it("on falls back to the coarsest structure timeframe (daily) for an interval with no structure-timeframe equivalent (weekly)", () => {
      expect(toggleStructureOn(true, "weekly")).toEqual(["daily"]);
    });
  });

  it("tool settings default off", () => {
    expect(loadTools()).toEqual({ magnet: false, drawingsHidden: false, indicatorsHidden: false, tradesOn: true, oiLevelsOn: false, priceHidden: false });
    saveTools({ magnet: true, drawingsHidden: false, indicatorsHidden: true, tradesOn: false, oiLevelsOn: true, priceHidden: true });
    expect(loadTools()).toEqual({ magnet: true, drawingsHidden: false, indicatorsHidden: true, tradesOn: false, oiLevelsOn: true, priceHidden: true });
  });

  it("drawings are kept per instrument, shared by every interval", () => {
    saveDrawings("NSE", "NIFTY", [{ name: "segment", points: [{ timestamp: 1, value: 2 }] }]);
    expect(loadDrawings("NSE", "NIFTY")).toHaveLength(1);
    expect(loadDrawings("NSE", "BANKNIFTY")).toEqual([]);
    localStorage.setItem("web.chart.drawings:NSE:NIFTY", JSON.stringify([{ nope: true }]));
    expect(loadDrawings("NSE", "NIFTY")).toEqual([]); // malformed is ignored, not crashed on
  });

  it("keeps a saved look with its drawing, cleaned: unknown or out-of-range values are dropped", () => {
    localStorage.setItem("web.chart.drawings:NSE:NIFTY", JSON.stringify([
      { name: "segment", points: [{ timestamp: 1, value: 10 }], style: { color: "#E8586A", width: 3, dash: "dashed", evil: "x" } },
      { name: "segment", points: [{ timestamp: 2, value: 11 }], style: { color: "url(x)", width: 12 } },
    ]));
    const loaded = loadDrawings("NSE", "NIFTY");
    expect(loaded[0].style).toEqual({ color: "#e8586a", width: 3, dash: "dashed" });
    expect(loaded[1]).toEqual({ name: "segment", points: [{ timestamp: 2, value: 11 }] });
  });

  it("remembers a default look per kind of drawing, and forgets it again", () => {
    expect(loadDrawingDefaults()).toEqual({});
    saveDrawingDefault("segment", { color: "#ffc83d", width: 2 });
    saveDrawingDefault("rect", { fill: 0.3 });
    expect(loadDrawingDefaults()).toEqual({ segment: { color: "#ffc83d", width: 2 }, rect: { fill: 0.3 } });
    saveDrawingDefault("segment", undefined);
    expect(loadDrawingDefaults()).toEqual({ rect: { fill: 0.3 } });
  });

  it("ignores a damaged defaults record", () => {
    localStorage.setItem("web.chart.drawingDefaults", JSON.stringify({ segment: { color: "bad" }, rect: { fill: 0.5 }, junk: 5 }));
    expect(loadDrawingDefaults()).toEqual({ rect: { fill: 0.5 } });
    localStorage.setItem("web.chart.drawingDefaults", "[1,2]");
    expect(loadDrawingDefaults()).toEqual({});
  });

  it("keeps the words of a text drawing, cut to the length a label can hold, and drops a text with no words", () => {
    localStorage.setItem("web.chart.drawings:NSE:NIFTY", JSON.stringify([
      { name: "textNote", points: [{ timestamp: 1, value: 10 }], text: "x".repeat(300) },
      { name: "textNote", points: [{ timestamp: 2, value: 11 }], text: "   " },
      { name: "textNote", points: [{ timestamp: 3, value: 12 }] },
      { name: "segment", points: [{ timestamp: 4, value: 13 }], text: "not a text drawing" },
    ]));
    const loaded = loadDrawings("NSE", "NIFTY");
    expect(loaded).toHaveLength(2);
    expect(loaded[0].text).toHaveLength(120);
    expect(loaded[1]).toEqual({ name: "segment", points: [{ timestamp: 4, value: 13 }] }); // words belong only to a text drawing
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

describe("intervals and precision", () => {
  it("knows each size, and falls back to 15 minutes for an unknown one", () => {
    expect(INTERVALS.map((i) => i.label)).toEqual(["1m", "3m", "5m", "15m", "30m", "1h", "1d", "1w"]);
    expect(intervalDef("60min").label).toBe("1h");
    expect(intervalDef("bogus").value).toBe("15min");
    expect(intervalDef("daily").source).toBe("yahoo"); // daily comes from a provider that needs no Dhan token
    expect(intervalDef("weekly").source).toBe("yahoo"); // same provider, same no-Dhan-token benefit
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

import { compactPnl, isContractOf, optionLabel, pnlTone, toChartTrades } from "./trades";

describe("trades on the chart", () => {
  const pos = (over: Record<string, unknown>) =>
    ({ id: "p", symbol: "NIFTY-Sep2026-FUT", action: "BUY", quantity: 65, entry_price: 100, entry_time: "2026-09-25T04:00:00Z", exit_price: null, exit_time: null, pnl: null, unrealized_pnl: 12, status: "OPEN", option_group_id: null, ...over }) as never;

  it("matches a contract of the instrument, not a lookalike", () => {
    expect(isContractOf("NIFTY-Sep2026-FUT", "NIFTY")).toBe(true);
    expect(isContractOf("nifty", "NIFTY")).toBe(true);
    expect(isContractOf("NIFTYBEES", "NIFTY")).toBe(false);
    expect(isContractOf("BANKNIFTY-Sep2026-FUT", "NIFTY")).toBe(false);
  });

  it("uses the live result while open and the booked one once closed", () => {
    const [open, closed] = toChartTrades("NIFTY", [pos({}), pos({ id: "c", status: "CLOSED", pnl: -40, unrealized_pnl: 999, exit_price: 90, exit_time: "2026-09-25T05:00:00Z" })], [], 0);
    expect(open.pnl).toBe(12);
    expect(closed).toMatchObject({ pnl: -40, exitPrice: 90, exitTs: Date.parse("2026-09-25T05:00:00Z") });
  });

  it("ignores rejected rows, option legs and trades before the window", () => {
    const rows = [pos({ status: "REJECTED" }), pos({ option_group_id: "g" }), pos({ id: "early", entry_time: "2026-09-01T04:00:00Z" }), pos({ id: "ok" })];
    expect(toChartTrades("NIFTY", rows, [], Date.parse("2026-09-20T00:00:00Z")).map((t) => t.id)).toEqual(["ok"]);
  });

  it("names option trades plainly", () => {
    expect(optionLabel({ strategy_type: "naked_call", action: "BUY" })).toBe("Naked Call");
    expect(optionLabel({ strategy_type: "naked_put", action: "SELL" })).toBe("Naked Put");
    expect(optionLabel({ strategy_type: "bull_call_spread", action: "BUY" })).toBe("Bull Call");
    expect(optionLabel({ strategy_type: "long_straddle", action: "BUY" })).toBe("Straddle");
  });

  it("writes results compactly, with a proper minus", () => {
    expect(compactPnl(1234)).toBe("+1.2k");
    expect(compactPnl(-450)).toBe("−450");
    expect(compactPnl(null)).toBe("–");
    expect(pnlTone(0)).toBe("flat");
    expect(pnlTone(-1)).toBe("dn");
  });
});

import { checkLevelMove, openLevels } from "./trades";

describe("open trade levels", () => {
  const level = (field: "stop" | "target", long: boolean) => ({ field, long });

  it("keeps a long's stop below the price and its target above, and the reverse for a short", () => {
    expect(checkLevelMove(level("stop", true), 99, 100)).toBeNull();
    expect(checkLevelMove(level("stop", true), 100, 100)).toMatch(/below/); // level with the price would close it at once
    expect(checkLevelMove(level("target", true), 101, 100)).toBeNull();
    expect(checkLevelMove(level("target", true), 99, 100)).toMatch(/above/);
    expect(checkLevelMove(level("stop", false), 101, 100)).toBeNull();
    expect(checkLevelMove(level("stop", false), 99, 100)).toMatch(/above/);
    expect(checkLevelMove(level("target", false), 99, 100)).toBeNull();
    expect(checkLevelMove(level("target", false), 101, 100)).toMatch(/below/);
  });

  it("will not judge without a live price, or a price that is not one", () => {
    expect(checkLevelMove(level("stop", true), 99, null)).toMatch(/no live price/);
    expect(checkLevelMove(level("stop", true), Number.NaN, 100)).toBe("That is not a price.");
    expect(checkLevelMove(level("stop", true), 0, 100)).toBe("That is not a price.");
  });

  it("makes a level of each stop and target that is set on an open trade of this instrument", () => {
    const pos = (over: object) => ({ id: "p", symbol: "NIFTY-Sep2026-FUT", action: "BUY", quantity: 65, status: "OPEN", option_group_id: null, stop_loss_price: 100, target_price: null, ...over }) as never;
    const levels = openLevels("NIFTY", [pos({}), pos({ id: "closed", status: "CLOSED" }), pos({ id: "leg", option_group_id: "g" }), pos({ id: "other", symbol: "BANKNIFTY-Sep2026-FUT" })], []);
    expect(levels.map((l) => [l.key, l.price, l.draggable])).toEqual([["position:p:stop", 100, true]]);
  });
});
