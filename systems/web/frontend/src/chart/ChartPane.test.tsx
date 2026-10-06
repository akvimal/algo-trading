import { cloneElement, createRef } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STRUCTURE } from "./config";
import { ChartPane, type ChartPaneHandle } from "./ChartPane";
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


// ---- zones and levels armed on the chart are also sent to the server -----------------------------------------------------------------------
// (kept here, in a small file of their own: the server watches them with every tab closed, so what the chart SENDS is what matters)

describe("armed zones are sent to the server", () => {
  const KEY = "web.chart.drawings:NSE:NIFTY";
  type Sent = { url: string; body: { interval: string; watches: { kind: string; lo: number; hi: number }[] } };
  let sent: Sent[];

  beforeEach(() => {
    sent = [];
    localStorage.clear();
    const base = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/zone-watches/") && init?.method === "PUT") {
          sent.push({ url: String(url), body: JSON.parse(init.body as string) });
          return json([]);
        }
        return base(url, init);
      }),
    );
  });

  const withRef = () => {
    const ref = createRef<ChartPaneHandle>();
    render(cloneElement(chartEl(1000), { ref }));
    return ref;
  };
  const lastWatches = () => sent[sent.length - 1].body.watches;
  const sentSomething = async () => {
    const n = sent.length;
    await waitFor(() => expect(sent.length).toBeGreaterThan(n), { timeout: 3000 });
  };
  const draw = async (ref: React.RefObject<ChartPaneHandle>, tool: "rect" | "horizontalStraightLine", points: { timestamp?: number; value: number }[]) => {
    const c = await loaded();
    act(() => ref.current!.startDrawing(tool));
    const ov = c.overlaysNamed(tool).filter((o) => o.points.length === 0).pop()!;
    act(() => c.finishDrawing(ov.id, points.map((p, i) => ({ timestamp: p.timestamp ?? c.data[3 + i].timestamp, value: p.value }))));
    return { c, id: ov.id };
  };

  it("arms a zone the moment it is drawn and sends it, to the instrument's own address with the chart's candle size", async () => {
    const ref = withRef();
    await draw(ref, "rect", [{ value: 1010 }, { value: 990 }]);
    expect(JSON.parse(localStorage.getItem(KEY)!)[0].alert).toEqual({ trigger: "cross" }); // armed without being asked
    await sentSomething();
    expect(sent[0].url).toMatch(/\/zone-watches\/NSE\/NIFTY$/);
    expect(sent[0].body).toEqual({ interval: "15min", watches: [{ kind: "zone", lo: 990, hi: 1010 }] });
  });

  it("does not arm a level by itself, and sends it only once it is armed", async () => {
    const ref = withRef();
    const { c, id } = await draw(ref, "horizontalStraightLine", [{ value: 1015 }]);
    expect(JSON.parse(localStorage.getItem(KEY)!)[0].alert).toBeUndefined();
    await sentSomething();
    expect(lastWatches()).toEqual([]); // drawn but not armed: nothing for the server to watch
    act(() => c.select(id));
    act(() => ref.current!.setSelectedAlert("cross"));
    await sentSomething();
    expect(lastWatches()).toEqual([{ kind: "line", lo: 1015, hi: 1015 }]);
  });

  it("sends an empty set when the last armed zone is deleted, so the server stops watching it", async () => {
    const ref = withRef();
    const { c, id } = await draw(ref, "rect", [{ value: 1010 }, { value: 990 }]);
    await sentSomething();
    act(() => c.select(id));
    act(() => ref.current!.removeSelected());
    await sentSomething();
    expect(lastWatches()).toEqual([]);
  });

  it("keeps a sloped line to the page: the server cannot follow a price that moves with time", async () => {
    const ref = withRef();
    const { c, id } = await draw(ref, "segment" as never, [{ value: 1000 }, { value: 1040 }]);
    act(() => c.select(id));
    act(() => ref.current!.setSelectedAlert("cross"));
    await sentSomething();
    expect(lastWatches()).toEqual([]); // armed on the page, not sent
  });

  it("sends the zones armed before this existed when the chart loads", async () => {
    const t = Date.now();
    localStorage.setItem(KEY, JSON.stringify([
      { name: "rect", points: [{ timestamp: t - 3_600_000, value: 980 }, { timestamp: t - 1_800_000, value: 990 }], alert: { trigger: "cross" } },
      { name: "rect", points: [{ timestamp: t - 3_600_000, value: 1100 }, { timestamp: t - 1_800_000, value: 1110 }] },
    ]));
    withRef();
    await loaded();
    await sentSomething();
    expect(lastWatches()).toEqual([{ kind: "zone", lo: 980, hi: 990 }]); // the armed one only
  });

  it("sends nothing on load when no zone is armed, so a browser with no drawings cannot wipe the server's copy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = Date.now();
      localStorage.setItem(KEY, JSON.stringify([{ name: "rect", points: [{ timestamp: t - 3_600_000, value: 1100 }, { timestamp: t - 1_800_000, value: 1110 }] }]));
      withRef();
      const c = await loaded();
      await waitFor(() => expect(c.overlaysNamed("rect").length).toBeGreaterThan(0));
      act(() => void vi.advanceTimersByTime(3_000));
      expect(sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends one request for a burst of edits, not one per change", async () => {
    const ref = withRef();
    const { c, id } = await draw(ref, "rect", [{ value: 1010 }, { value: 990 }]);
    for (let i = 0; i < 5; i++) {
      act(() => c.select(id));
      act(() => ref.current!.setSelectedAlert(i % 2 ? "cross" : "close"));
    }
    await sentSomething();
    await new Promise((r) => setTimeout(r, 1000));
    expect(sent).toHaveLength(1);
  });
});
