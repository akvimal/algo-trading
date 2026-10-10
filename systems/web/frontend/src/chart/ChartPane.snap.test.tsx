import { cloneElement, createRef } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STRUCTURE } from "./config";
import { ChartPane, type ChartPaneHandle } from "./ChartPane";
import { FakeChart } from "../test/fakeKlinecharts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const STEP_MS = 15 * 60_000;

function candles() {
  const newest = Math.floor(Date.now() / STEP_MS) * STEP_MS;
  return Array.from({ length: 30 }, (_, i) => ({
    exchange: "NSE", symbol: "NIFTY", interval: "15min", open: 1000, high: 1000, low: 1000, close: 1000, volume: 1,
    timestamp: new Date(newest - (29 - i) * STEP_MS).toISOString(), provider: "dhan",
  }));
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/candles/history")) return json(candles());
      if (String(url).includes("/order-blocks")) return json({ order_blocks: [], fvgs: [], trend: "up", events: [], trend_changes: [], setups: [] });
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const element = (magnet: boolean) => (
  <ChartPane exchange="NSE" symbol="NIFTY" interval="15min" price={1000} indicators={[]} indicatorParams={{}} indicatorsHidden={false} structure={EMPTY_STRUCTURE} plan={[]} magnet={magnet} drawingsHidden={false} pickField={null} onPick={() => {}} />
);

/** A chart whose bar 3 ranges 990-1010 (the others are flat at 1000), with a drawing of `tool` just started; returns that drawing's handlers. */
async function drawing(tool: "rect" | "segment", magnet: boolean) {
  const ref = createRef<ChartPaneHandle>();
  render(cloneElement(element(magnet), { ref }));
  await waitFor(() => expect(FakeChart.instances[0]?.data.length).toBeGreaterThan(0));
  const c = FakeChart.instances[0];
  c.data[3] = { ...c.data[3], high: 1010, low: 990 };
  act(() => ref.current!.startDrawing(tool));
  const ov = c.overlaysNamed(tool).filter((o) => o.points.length === 0).pop()!;
  return ov.handlers;
}

describe("a zone with the magnet on", () => {
  it("puts the corner on the candle's high or low while it is being placed", async () => {
    const h = await drawing("rect", true);
    const upper = { dataIndex: 3, value: 1007 }; // the library has already moved it under its own magnet
    h.onDrawing({ overlay: { name: "rect", points: [upper] }, figureIndex: 0 });
    expect(upper.value).toBe(1010); // upper half: the high
    const lower = { dataIndex: 3, value: 993 };
    h.onDrawing({ overlay: { name: "rect", points: [upper, lower] }, figureIndex: 1 });
    expect(lower.value).toBe(990); // lower half: the low
  });

  it("leaves a corner clearly beyond the candle's wick where it was put", async () => {
    const h = await drawing("rect", true);
    const far = { dataIndex: 3, value: 1040 };
    h.onDrawing({ overlay: { name: "rect", points: [far] }, figureIndex: 0 });
    expect(far.value).toBe(1040);
  });

  it("does nothing with the magnet off", async () => {
    const h = await drawing("rect", false);
    const p = { dataIndex: 3, value: 1007 };
    h.onDrawing({ overlay: { name: "rect", points: [p] }, figureIndex: 0 });
    expect(p.value).toBe(1007);
  });

  it("snaps a corner as it is dragged, setting the point itself", async () => {
    const h = await drawing("rect", true);
    const move = vi.fn();
    // pixel x is the bar index and y = 1000 - price in the test chart: this drag is at bar 3, price 1007
    const handled = h.onPressedMoving({ overlay: { name: "rect", points: [{ value: 995 }, { value: 1000 }], eventPressedPointMove: move }, figureIndex: 1, figureKey: "overlay_point_1", x: 3, y: -7 });
    expect(handled).toBe(true);
    expect(move).toHaveBeenCalledWith(expect.objectContaining({ dataIndex: 3, value: 1010 }), 1);
  });

  it("leaves a drag of the whole zone to the library", async () => {
    const h = await drawing("rect", true);
    const move = vi.fn();
    expect(h.onPressedMoving({ overlay: { name: "rect", points: [], eventPressedPointMove: move }, figureIndex: 0, figureKey: "overlay_rect_0", x: 3, y: 0 })).toBe(false);
    expect(move).not.toHaveBeenCalled();
  });
});

describe("holding Shift on a line", () => {
  it("makes the end being placed level with the first, and stops when Shift is let go", async () => {
    const h = await drawing("segment", false);
    const end = { dataIndex: 8, value: 1012 };
    fireEvent.keyDown(window, { key: "Shift" });
    h.onDrawing({ overlay: { name: "segment", points: [{ dataIndex: 3, value: 1000 }, end] }, figureIndex: 1 });
    expect(end.value).toBe(1000);
    fireEvent.keyUp(window, { key: "Shift" });
    const free = { dataIndex: 8, value: 1012 };
    h.onDrawing({ overlay: { name: "segment", points: [{ dataIndex: 3, value: 1000 }, free] }, figureIndex: 1 });
    expect(free.value).toBe(1012);
  });

  it("also levels an end that is dragged afterwards, and leaves other tools alone", async () => {
    const h = await drawing("segment", false);
    const move = vi.fn();
    fireEvent.keyDown(window, { key: "Shift" });
    expect(h.onPressedMoving({ overlay: { name: "segment", points: [{ value: 1000 }, { value: 1012 }], eventPressedPointMove: move }, figureIndex: 1, figureKey: "overlay_point_1", x: 8, y: -15 })).toBe(true);
    expect(move).toHaveBeenCalledWith(expect.objectContaining({ value: 1000 }), 1);
    const other = vi.fn();
    expect(h.onPressedMoving({ overlay: { name: "fibonacciLine", points: [{ value: 1000 }, { value: 1012 }], eventPressedPointMove: other }, figureIndex: 1, figureKey: "overlay_point_1", x: 8, y: -15 })).toBe(false);
    expect(other).not.toHaveBeenCalled();
    fireEvent.keyUp(window, { key: "Shift" });
  });
});
