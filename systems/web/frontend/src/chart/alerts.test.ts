import { describe, expect, it } from "vitest";
import { SERVER_WATCHED, alertMessage, alertZone, checkAlert, levelText, serverWatches, sideOf } from "./alerts";

const line = (value: number) => ({ name: "horizontalStraightLine", points: [{ value }] });
const zone = (a: number, b: number) => ({ name: "rect", points: [{ timestamp: 1, value: a }, { timestamp: 2, value: b }] });

describe("alertZone", () => {
  it("reads a level as a band of no width and a zone as its two edges, whichever way it was drawn", () => {
    expect(alertZone(line(100))).toEqual({ lo: 100, hi: 100 });
    expect(alertZone({ name: "priceLine", points: [{ value: 55 }] })).toEqual({ lo: 55, hi: 55 });
    expect(alertZone(zone(120, 100))).toEqual({ lo: 100, hi: 120 });
  });

  it("projects a diagonal line to where it is now, and cannot for a vertical one", () => {
    const diagonal = { name: "segment", points: [{ timestamp: 0, value: 100 }, { timestamp: 1000, value: 200 }] };
    expect(alertZone(diagonal, 500)).toEqual({ lo: 150, hi: 150 });
    expect(alertZone(diagonal, 2000)).toEqual({ lo: 300, hi: 300 }); // a ray or line goes on past its second point
    expect(alertZone({ name: "rayLine", points: [{ timestamp: 5, value: 1 }, { timestamp: 5, value: 9 }] }, 7)).toBeNull();
  });

  it("gives nothing for a drawing with no price to watch, or one that is not a line or zone", () => {
    expect(alertZone({ name: "horizontalStraightLine", points: [] })).toBeNull();
    expect(alertZone({ name: "rect", points: [{ value: 1 }] })).toBeNull();
    expect(alertZone({ name: "fibonacciLine", points: [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }] })).toBeNull();
    expect(alertZone({ name: "priceLine", points: [{ value: Number.NaN }] })).toBeNull();
  });
});

describe("sideOf", () => {
  it("a line has two sides, and sitting on it is above", () => {
    expect(sideOf(101, { lo: 100, hi: 100 })).toBe("above");
    expect(sideOf(100, { lo: 100, hi: 100 })).toBe("above");
    expect(sideOf(99.99, { lo: 100, hi: 100 })).toBe("below");
  });
  it("a zone has three, and its edges are inside", () => {
    const z = { lo: 100, hi: 110 };
    expect([sideOf(111, z), sideOf(110, z), sideOf(105, z), sideOf(100, z), sideOf(99, z)]).toEqual(["above", "inside", "inside", "inside", "below"]);
  });
});

describe("checkAlert", () => {
  it("only learns the side the first time: nothing can have been crossed yet", () => {
    expect(checkAlert("NIFTY", line(100), "cross", null, 120)).toEqual({ side: "above", message: null });
  });
  it("stays quiet while the price stays on its side, and speaks when it changes", () => {
    expect(checkAlert("NIFTY", line(100), "cross", "above", 130)).toEqual({ side: "above", message: null });
    expect(checkAlert("NIFTY", line(100), "cross", "below", 101)).toEqual({ side: "above", message: "NIFTY ▲ crossed above 100" });
    expect(checkAlert("NIFTY", line(100), "cross", "above", 99)).toEqual({ side: "below", message: "NIFTY ▼ crossed below 100" });
  });
  it("words a close differently from a cross", () => {
    expect(checkAlert("NIFTY", line(100), "close", "below", 101)!.message).toBe("NIFTY ▲ closed above 100");
  });
  it("tells entering a zone, leaving it either way, and crossing it clean through", () => {
    const z = zone(100, 110);
    expect(checkAlert("X", z, "cross", "below", 105)!.message).toBe("X entered the zone 100–110");
    expect(checkAlert("X", z, "cross", "inside", 111)!.message).toBe("X left the zone ▲ 100–110");
    expect(checkAlert("X", z, "cross", "inside", 99)!.message).toBe("X left the zone ▼ 100–110");
    expect(checkAlert("X", z, "cross", "below", 120)!.message).toBe("X ▲ crossed the zone 100–110");
  });
  it("has nothing to say for a drawing it cannot read", () => {
    expect(checkAlert("X", { name: "rect", points: [] }, "cross", "above", 1)).toBeNull();
  });
});

describe("levelText and alertMessage", () => {
  it("reads a level as one price and a zone as a range", () => {
    expect(levelText(line(23140.5))).toBe("23,140.5");
    expect(levelText(zone(23100, 23200))).toBe("23,100 to 23,200");
    expect(levelText({ name: "rect", points: [] })).toBeNull();
  });
  it("uses the arrow of the side it moved to", () => {
    expect(alertMessage("X", { lo: 1, hi: 1 }, "below", "above", "cross")).toContain("▼");
  });
});

describe("serverWatches: what the server is asked to watch", () => {
  const t = 1_700_000_000_000;
  const armedZone = (a: number, b: number, alert = true) => ({ name: "rect", points: [{ timestamp: t, value: a }, { timestamp: t + 1, value: b }], ...(alert ? { alert: { trigger: "cross" as const } } : {}) });
  const armedLevel = (v: number, alert = true) => ({ name: "horizontalStraightLine", points: [{ timestamp: t, value: v }], ...(alert ? { alert: { trigger: "cross" as const } } : {}) });

  it("sends an armed zone as a band, whichever corner was drawn first, and an armed level as a band of no width", () => {
    expect(serverWatches([armedZone(1010, 990), armedZone(100, 110)])).toEqual([{ kind: "zone", lo: 990, hi: 1010 }, { kind: "zone", lo: 100, hi: 110 }]);
    expect(serverWatches([armedLevel(1015)])).toEqual([{ kind: "line", lo: 1015, hi: 1015 }]);
  });

  it("leaves out anything not armed", () => {
    expect(serverWatches([armedZone(990, 1010, false), armedLevel(1015, false)])).toEqual([]);
  });

  it("keeps a sloped line to the page: its price changes with time", () => {
    expect(serverWatches([{ name: "segment", points: [{ timestamp: t, value: 100 }, { timestamp: t + 1000, value: 120 }], alert: { trigger: "cross" } }])).toEqual([]);
    expect(SERVER_WATCHED.has("segment") || SERVER_WATCHED.has("rayLine")).toBe(false);
  });

  it("leaves out an armed drawing with no price to watch", () => {
    expect(serverWatches([{ name: "rect", points: [{ timestamp: t, value: 100 }], alert: { trigger: "cross" } }])).toEqual([]);
  });
});
