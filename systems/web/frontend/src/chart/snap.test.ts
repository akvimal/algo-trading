import { describe, expect, it } from "vitest";
import { levelWithOtherEnd, snapZoneCorner } from "./snap";

const candle = { high: 110, low: 100 };

describe("a zone's corner with the magnet on", () => {
  it("snaps to the nearer of the candle's high and low, never its open or close", () => {
    expect(snapZoneCorner(108, candle, 0.5)).toBe(110); // upper half: the high
    expect(snapZoneCorner(102, candle, 0.5)).toBe(100); // lower half: the low
    expect(snapZoneCorner(105.1, candle, 0.5)).toBe(110);
    expect(snapZoneCorner(104.9, candle, 0.5)).toBe(100);
  });

  it("snaps from just beyond the wick too (the magnet's reach), but leaves a corner clearly past it alone", () => {
    expect(snapZoneCorner(110.4, candle, 0.5)).toBe(110);
    expect(snapZoneCorner(99.6, candle, 0.5)).toBe(100);
    expect(snapZoneCorner(112, candle, 0.5)).toBe(112); // a zone may extend past a candle on purpose
    expect(snapZoneCorner(97, candle, 0.5)).toBe(97);
  });

  it("does nothing for values or candles that make no sense", () => {
    expect(snapZoneCorner(NaN, candle, 0.5)).toBeNaN();
    expect(snapZoneCorner(105, { high: 100, low: 110 }, 0.5)).toBe(105);
    expect(snapZoneCorner(105, { high: NaN, low: 100 }, 0.5)).toBe(105);
    expect(snapZoneCorner(110.4, candle, 0)).toBe(110.4); // no reach: only inside the range snaps
  });
});

describe("holding Shift on a line", () => {
  it("takes the other end's price so the line is flat, whichever end is being placed or dragged", () => {
    expect(levelWithOtherEnd("segment", 1, [100, 108])).toBe(100);
    expect(levelWithOtherEnd("segment", 0, [100, 108])).toBe(108);
    expect(levelWithOtherEnd("rayLine", 1, [250.5, 260])).toBe(250.5);
  });

  it("applies only to lines that have two ends, and only when the other end has a price", () => {
    expect(levelWithOtherEnd("rect", 1, [100, 108])).toBeNull();
    expect(levelWithOtherEnd("fibonacciLine", 1, [100, 108])).toBeNull();
    expect(levelWithOtherEnd("segment", 1, [100])).toBeNull(); // the first end is still being placed
    expect(levelWithOtherEnd("segment", 1, [undefined, 108])).toBeNull();
  });
});
