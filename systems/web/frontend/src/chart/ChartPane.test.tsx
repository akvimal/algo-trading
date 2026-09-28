import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STRUCTURE } from "./config";
import { ChartPane } from "./ChartPane";
import { FakeChart } from "../test/fakeKlinecharts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const STEP_MS = 15 * 60_000;

/** 30 quiet 15-minute candles, the newest one starting at the current (possibly faked) clock's own
 * 15-minute boundary, closing at `close`. */
function candlesFor(close: number) {
  const newest = Math.floor(Date.now() / STEP_MS) * STEP_MS;
  return Array.from({ length: 30 }, (_, i) => ({
    exchange: "NSE", symbol: "NIFTY", interval: "15min", open: close, high: close, low: close, close, volume: 1,
    timestamp: new Date(newest - (29 - i) * STEP_MS).toISOString(), provider: "dhan",
  }));
}

let closePrice: number;

beforeEach(() => {
  closePrice = 1000;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/candles/history")) return json(candlesFor(closePrice));
      if (String(url).includes("/order-blocks")) return json({ order_blocks: [], fvgs: [], trend: "up", events: [], trend_changes: [], setups: [] });
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function chartEl(price: number | null) {
  return (
    <ChartPane
      exchange="NSE"
      symbol="NIFTY"
      interval="15min"
      price={price}
      indicators={[]}
      indicatorParams={{}}
      indicatorsHidden={false}
      structure={EMPTY_STRUCTURE}
      plan={[]}
      magnet={false}
      drawingsHidden={false}
      pickField={null}
      onPick={() => {}}
    />
  );
}
function renderChart(price: number | null) {
  return render(chartEl(price));
}
const chart = () => FakeChart.instances[0];
const loaded = async () => {
  await waitFor(() => expect(chart()).toBeDefined());
  await waitFor(() => expect(chart().data.length).toBeGreaterThan(0));
  return chart();
};

describe("the live bar rolls into a fresh one at its own boundary", () => {
  /** How long until the newest (currently forming) bar's own window ends - not a full STEP_MS, since
   * "now" falls at a random point inside that window, not at its start. */
  const remainingInBar = () => STEP_MS - (Date.now() % STEP_MS);

  it("rolls forward on a timer even when the price never changes, not only on a fresh tick", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderChart(1000);
      const c = await loaded();
      const before = c.data.length;
      const lastTs = c.data[c.data.length - 1].timestamp;
      // No new price arrives at all - only time passes, past the current bar's own window.
      act(() => void vi.advanceTimersByTime(remainingInBar() + 2_000));
      await waitFor(() => expect(c.data.length).toBe(before + 1));
      const bar = c.data[c.data.length - 1];
      expect(bar.timestamp).toBe(lastTs + STEP_MS);
      expect(bar.open).toBe(1000); // opens at the previous bar's own close
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing before the boundary, and only once after it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderChart(1000);
      const c = await loaded();
      const before = c.data.length;
      const short = Math.max(0, remainingInBar() - 5_000);
      act(() => void vi.advanceTimersByTime(short)); // short of the boundary
      expect(c.data.length).toBe(before);
      act(() => void vi.advanceTimersByTime(10_000)); // now past it
      await waitFor(() => expect(c.data.length).toBe(before + 1));
      act(() => void vi.advanceTimersByTime(5_000)); // the timer keeps ticking, but the bar is already rolled
      expect(c.data.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still updates at once on a real price change, same as before", async () => {
    const { rerender } = renderChart(1000);
    const c = await loaded();
    act(() => rerender(chartEl(1012.5)));
    expect(c.data[c.data.length - 1].close).toBe(1012.5);
  });
});
