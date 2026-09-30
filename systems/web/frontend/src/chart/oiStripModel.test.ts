import { describe, expect, it } from "vitest";
import type { SentimentHistoryPoint } from "../api/types";
import {
  buildupTone, classifyPcr, deltaPct, flowSkew, hasSentimentTrend, isStaleAt, pcrDiverges, sentimentSteps, volumePcr,
} from "./oiStripModel";

const leg = (over: Partial<{ oi: number; volume: number }> = {}) => ({ oi: 0, oi_change_5m: null, oi_change_15m: null, volume: 0, ...over });

describe("volumePcr", () => {
  it("divides today's put volume by call volume across the whole chain", () => {
    const strikes = [
      { strike: 100, call: leg({ volume: 100 }), put: leg({ volume: 50 }) },
      { strike: 110, call: leg({ volume: 50 }), put: leg({ volume: 150 }) },
    ];
    expect(volumePcr(strikes)).toBeCloseTo(200 / 150, 5);
  });
  it("is null with no call volume, rather than infinite", () => {
    expect(volumePcr([{ strike: 100, call: leg({ volume: 0 }), put: leg({ volume: 10 }) }])).toBeNull();
    expect(volumePcr([])).toBeNull();
  });
});

describe("classifyPcr and pcrDiverges", () => {
  it("buckets a PCR bullish, bearish or neutral", () => {
    expect(classifyPcr(1.2)).toBe("bullish");
    expect(classifyPcr(0.8)).toBe("bearish");
    expect(classifyPcr(1)).toBe("neutral");
    expect(classifyPcr(null)).toBeNull();
  });
  it("flags a disagreement between the OI-based and volume-based reads, not a shared bucket", () => {
    expect(pcrDiverges(1.2, 0.8)).toBe(true);
    expect(pcrDiverges(1.2, 1.25)).toBe(false);
    expect(pcrDiverges(null, 1.2)).toBe(false);
  });
});

describe("flowSkew", () => {
  it("nets each side's own 5m change as a percent of its own total", () => {
    expect(flowSkew(6000, 1_000_000, 15000, 1_000_000)).toEqual({ pct: 0.9, leader: "PE" });
    expect(flowSkew(15000, 1_000_000, 6000, 1_000_000)).toEqual({ pct: 0.9, leader: "CE" });
  });
  it("is null without both sides's change data, or a zero total", () => {
    expect(flowSkew(null, 1_000_000, 6000, 1_000_000)).toBeNull();
    expect(flowSkew(6000, 0, 6000, 1_000_000)).toBeNull();
  });
  it("is null on an exact tie", () => {
    expect(flowSkew(6000, 1_000_000, 6000, 1_000_000)).toBeNull();
  });
});

describe("buildupTone", () => {
  it("reads long buildup and short covering as bullish for calls, bearish for puts", () => {
    expect(buildupTone("long_buildup", "CE")).toBe("up");
    expect(buildupTone("short_covering", "CE")).toBe("up");
    expect(buildupTone("long_buildup", "PE")).toBe("dn");
  });
  it("reads short buildup and long unwinding the other way", () => {
    expect(buildupTone("short_buildup", "CE")).toBe("dn");
    expect(buildupTone("short_buildup", "PE")).toBe("up");
    expect(buildupTone("long_unwinding", "PE")).toBe("up");
  });
});

describe("deltaPct", () => {
  it("signs the change as a share of the total", () => {
    expect(deltaPct(8000, 1_000_000)).toEqual({ pct: 0.8, up: true });
    expect(deltaPct(-8000, 1_000_000)).toEqual({ pct: 0.8, up: false });
  });
  it("is null without a change reading, or with nothing to divide by", () => {
    expect(deltaPct(null, 1_000_000)).toBeNull();
    expect(deltaPct(8000, 0)).toBeNull();
  });
});

describe("sentimentSteps", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 8, 27, 4, m)).toISOString();
  const pt = (m: number, s5: number | null, s15: number | null = null): SentimentHistoryPoint => ({ recorded_at: at(m), score_5m: s5, score_15m: s15 });

  it("reads each window's own score column", () => {
    const points = [pt(0, 0.1, 0.2), pt(5, 0.15, 0.25), pt(15, 0.16, 0.3)];
    expect(sentimentSteps(points, "5m").map((s) => s.score)).toEqual([0.1, 0.15, 0.16]);
    expect(sentimentSteps(points, "15m").map((s) => s.score)).toEqual([0.25, 0.3]); // minutes 0 and 5 share the 0-15 slot
  });

  it("snaps drifting timestamps to clean slots, keeping only the latest reading per slot", () => {
    const points = [pt(2, 0.1), pt(4, 0.12), pt(7, 0.2)]; // minutes 2 and 4 both fall in the 0-5 slot
    const steps = sentimentSteps(points, "5m");
    expect(steps).toHaveLength(2);
    expect(steps[0].score).toBe(0.12); // the later of the two readings in that slot
    expect(steps[1].score).toBe(0.2);
  });

  it("keeps only the most recent 10 slots", () => {
    const points = Array.from({ length: 20 }, (_, i) => pt(i * 5, i / 100));
    expect(sentimentSteps(points, "5m")).toHaveLength(10);
    expect(sentimentSteps(points, "5m")[0].score).toBeCloseTo(0.1, 5); // the 10th-from-last reading
  });

  it("flags a sign flip as a major move", () => {
    const steps = sentimentSteps([pt(0, 0.1), pt(5, -0.1)], "5m");
    expect(steps[1].major).toBe(true);
  });

  it("does not flag a flip across a near-zero score as major (both sides must clear the noise floor)", () => {
    const steps = sentimentSteps([pt(0, 0.01), pt(5, -0.01)], "5m");
    expect(steps[1].major).toBe(false);
  });

  it("flags a jump well past the recent typical step as major", () => {
    const steps = sentimentSteps([pt(0, 0.1), pt(5, 0.11), pt(10, 0.12), pt(15, 0.6)], "5m");
    expect(steps[3].major).toBe(true);
    expect(steps[1].major).toBe(false);
  });

  it("ignores a window with no score at all", () => {
    expect(sentimentSteps([pt(0, null)], "5m")).toEqual([]);
  });
});

describe("hasSentimentTrend and isStaleAt", () => {
  it("needs at least 2 points in either window", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 8, 27, 4, m)).toISOString();
    expect(hasSentimentTrend([{ recorded_at: at(0), score_5m: 0.1, score_15m: null }])).toBe(false);
    expect(hasSentimentTrend([{ recorded_at: at(0), score_5m: 0.1, score_15m: null }, { recorded_at: at(5), score_5m: 0.2, score_15m: null }])).toBe(true);
  });
  it("is stale past 2 recording cycles (12 minutes)", () => {
    const now = Date.now();
    expect(isStaleAt(new Date(now - 10 * 60_000).toISOString(), now)).toBe(false);
    expect(isStaleAt(new Date(now - 13 * 60_000).toISOString(), now)).toBe(true);
  });
});
