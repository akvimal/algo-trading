import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AuthProvider } from "../auth/AuthContext";
import { setToken } from "../auth/token";

function jwt(claims: object): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const oiRow = (symbol: string, over: object = {}) => ({
  symbol, exchange: "NSE", snapshot_date: "2026-09-25", spot_price: 2500, total_call_oi: 1_234_567, total_put_oi: 2_000_000, pcr: 1.62,
  call_oi_change_pct: 5, put_oi_change_pct: -3, price_change_pct: 1.25, call_buildup: "long_buildup", put_buildup: "long_unwinding", history: [], ...over,
});
const candlesFor = (symbol: string, interval: string) =>
  Array.from({ length: 10 }, (_, i) => ({
    exchange: "NSE", symbol, interval, open: 1000 + i, high: 1005 + i, low: 995 + i, close: 1002 + i, volume: 1,
    timestamp: new Date(Date.now() - (9 - i) * 86_400_000).toISOString(), provider: interval === "daily" ? "yahoo" : "dhan",
  }));
const scrRow = (symbol: string, over: object = {}) => ({
  symbol, exchange: "NSE", snapshot_date: "2026-09-25", close: 812.5, pct_change_5d: 3.2, pct_change_20d: -1.1, adx: 31, regime: "trending_up",
  high_52w: 900, low_52w: 500, pct_from_52w_high: -1, pct_from_52w_low: 60, proximity: "near_52w_high",
  history: [{ snapshot_date: "2026-09-24", close: 800 }, { snapshot_date: "2026-09-25", close: 812.5 }], ...over,
});

let oi: { snapshot_date: string; rows: object[] };
let scr: { snapshot_date: string; rows: object[] };
let oiStatus = 200;
let customScreens: any[];
let previewResult: any;
let previewErrorDetail: string | null;
let seq: number;
let calls: { url: string; method: string }[];

beforeEach(() => {
  calls = [];
  oi = { snapshot_date: "2026-09-25", rows: [oiRow("RELIANCE"), oiRow("TCS", { call_oi_change_pct: 12, call_buildup: "short_buildup" })] };
  scr = { snapshot_date: "2026-09-25", rows: [scrRow("SBIN"), scrRow("ITC", { regime: "ranging", proximity: null, pct_change_5d: -2 })] };
  oiStatus = 200;
  customScreens = [];
  previewResult = { snapshot_date: "2026-09-25", candidates: 2, matches: [{ symbol: "TCS", exchange: "NSE", close: 3500 }] };
  previewErrorDetail = null;
  seq = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/oi-buildup")) return oiStatus === 200 ? json(oi) : json({ detail: "boom" }, oiStatus);
      if (url.includes("/candles/history")) {
        const interval = new URL(url).searchParams.get("interval") ?? "daily";
        return json(candlesFor(new URL(url).searchParams.get("symbol") ?? "", interval));
      }
      if (url.includes("/quotes/ltp")) return json({ exchange: "NSE", symbol: new URL(url).searchParams.get("symbol"), ltp: 2500, provider: "dhan" });
      if (url.includes("/equity-screener")) return json(scr);
      if (url.includes("/custom-screens/preview")) return previewErrorDetail ? json({ detail: previewErrorDetail }, 422) : json(previewResult);
      if (/\/custom-screens\/[^/]+\/run$/.test(url)) return previewErrorDetail ? json({ detail: previewErrorDetail }, 422) : json(previewResult);
      if (url.endsWith("/custom-screens") && method === "GET") return json(customScreens);
      if (url.endsWith("/custom-screens") && method === "POST") {
        if (previewErrorDetail) return json({ detail: previewErrorDetail }, 422);
        const body = JSON.parse(init!.body as string);
        const row = { id: `s${++seq}`, ...body, created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z" };
        customScreens.push(row);
        return json(row, 201);
      }
      const putMatch = /\/custom-screens\/([^/]+)$/.exec(url);
      if (putMatch && method === "PUT") {
        const row = customScreens.find((s) => s.id === putMatch[1]);
        Object.assign(row, JSON.parse(init!.body as string));
        return json(row);
      }
      if (putMatch && method === "DELETE") {
        customScreens = customScreens.filter((s) => s.id !== putMatch[1]);
        return json(null, 204);
      }
      // ProfileProvider fetches this on every mount - a real response (not the 404 fallback
      // below) so it settles quickly and cleanly rather than leaving a dangling, unhandled
      // request that can resolve late, into a LATER test's own render (a real "not wrapped in
      // act(...)" warning, seen once a test does enough other async work to outlast it).
      if (url.endsWith("/auth/me")) return json({ id: "u1", email: "me@x.com", experience: "pro", onboarded_at: "2026-09-01T00:00:00Z", markets: ["NSE", "MCX", "CRYPTO"] });
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
  setToken(jwt({ sub: "u1", email: "me@x.com", exp: Math.floor(Date.now() / 1000) + 3600 }), "me@x.com");
});
afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("OI buildup", () => {
  it("lists stocks biggest call-OI change first, in plain words, with a chart toggle", async () => {
    renderAt("/scan");
    const list = await screen.findByTestId("oi-list");
    const cards = within(list).getAllByTestId("oi-card");
    expect(cards.map((c) => within(c).getByRole("button", { name: "Chart" }).getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    const first = within(cards[0]);
    expect(first.getByText("+12.0%")).toBeInTheDocument(); // signed, not colour alone
    expect(first.getByText("Short buildup")).toBeInTheDocument();
    expect(first.getByText(/Call OI 12\.35L/)).toBeInTheDocument();
    expect(first.getByText("1.62")).toBeInTheDocument();
    expect(screen.getByText(/End-of-day snapshot for 25 Sept/)).toBeInTheDocument();
    expect(screen.getByText(/not recommendations/)).toBeInTheDocument();
  });

  it("filters by the call side and by search, and says when nothing matches", async () => {
    const user = userEvent.setup();
    renderAt("/scan");
    await screen.findByTestId("oi-list");
    await user.selectOptions(screen.getByLabelText("Call side"), "long_buildup");
    expect(within(screen.getByTestId("oi-list")).getAllByTestId("oi-card")).toHaveLength(1);
    await user.type(screen.getByLabelText("Search a symbol"), "zzz");
    expect(await screen.findByText("No stocks match")).toBeInTheDocument();
  });

  it("explains the terms for a beginner", async () => {
    const user = userEvent.setup();
    renderAt("/scan");
    await screen.findByTestId("oi-list");
    await user.click(screen.getByText("What do these mean?"));
    expect(screen.getByText(/new buyers are entering/)).toBeInTheDocument();
  });

  it("says so, rather than showing a blank, before the first end-of-day run", async () => {
    oi = { snapshot_date: "2026-09-26", rows: [] };
    renderAt("/scan");
    expect(await screen.findByText("No snapshot yet")).toBeInTheDocument();
  });

  it("shows an error with a retry when the service fails", async () => {
    oiStatus = 500;
    renderAt("/scan");
    expect(await screen.findByText(/That did not load/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows a page at a time and offers the rest", async () => {
    oi = { snapshot_date: "2026-09-25", rows: Array.from({ length: 95 }, (_, i) => oiRow(`S${String(i).padStart(3, "0")}`, { call_oi_change_pct: 100 - i })) };
    const user = userEvent.setup();
    renderAt("/scan");
    const list = await screen.findByTestId("oi-list");
    expect(within(list).getAllByTestId("oi-card")).toHaveLength(40);
    await user.click(screen.getByRole("button", { name: /Show more \(55 left\)/ }));
    expect(within(screen.getByTestId("oi-list")).getAllByTestId("oi-card")).toHaveLength(80);
    // a new filter starts back at the first page rather than keeping 80 cards open
    await user.selectOptions(screen.getByLabelText("Sort by"), "symbol");
    expect(within(screen.getByTestId("oi-list")).getAllByTestId("oi-card")).toHaveLength(40);
  });

  describe("the inline chart", () => {
    it("opens in the card on Chart, defaulting to daily, with the same drawing tools the Trade page has", async () => {
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const cards = within(list).getAllByTestId("oi-card");
      const tcs = within(cards[0]); // biggest call-OI change first, see the test above
      await user.click(tcs.getByRole("button", { name: "Chart" }));
      expect(tcs.getByRole("button", { name: "Close chart" })).toHaveAttribute("aria-expanded", "true");
      expect(await tcs.findByTestId("chart-pane")).toBeInTheDocument();
      expect(tcs.getByRole("button", { name: "1d" })).toHaveAttribute("aria-pressed", "true");
      expect(tcs.getByRole("toolbar", { name: "Drawing tools" })).toBeInTheDocument();
      expect(tcs.getByRole("button", { name: "Trend line" })).toBeInTheDocument();
      expect(tcs.getByRole("button", { name: "Zone (supply or demand)" })).toBeInTheDocument();
      await waitFor(() => expect(calls.some((c) => c.url.includes("/candles/history") && c.url.includes("interval=daily") && c.url.includes("symbol=TCS"))).toBe(true));
      // Placing an order still needs the real ticket - not lost, just no longer the default action.
      expect(tcs.getByRole("link", { name: /Open in Trade/ })).toHaveAttribute("href", "/trade?symbol=TCS&segment=NSE");
    });

    it("closes again on a second click, and only one card's chart is open at a time", async () => {
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const cards = within(list).getAllByTestId("oi-card");
      const [tcs, reliance] = [within(cards[0]), within(cards[1])];
      await user.click(tcs.getByRole("button", { name: "Chart" }));
      await tcs.findByTestId("chart-pane");
      await user.click(reliance.getByRole("button", { name: "Chart" })); // opening the second closes the first
      expect(tcs.queryByTestId("chart-pane")).not.toBeInTheDocument();
      expect(tcs.getByRole("button", { name: "Chart" })).toHaveAttribute("aria-expanded", "false");
      expect(await reliance.findByTestId("chart-pane")).toBeInTheDocument();
      await user.click(reliance.getByRole("button", { name: "Close chart" }));
      expect(reliance.queryByTestId("chart-pane")).not.toBeInTheDocument();
    });

    it("switches candle size without leaving the card", async () => {
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const tcs = within(within(list).getAllByTestId("oi-card")[0]);
      await user.click(tcs.getByRole("button", { name: "Chart" }));
      await tcs.findByTestId("chart-pane");
      await user.click(tcs.getByRole("button", { name: "15m" }));
      expect(tcs.getByRole("button", { name: "15m" })).toHaveAttribute("aria-pressed", "true");
      expect(tcs.getByRole("button", { name: "1d" })).toHaveAttribute("aria-pressed", "false");
      await waitFor(() => expect(calls.some((c) => c.url.includes("/candles/history") && c.url.includes("interval=15min"))).toBe(true));
    });
  });
});

describe("Screener", () => {
  it("shows trend, momentum and 52-week proximity, and filters by trend", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=screener");
    const list = await screen.findByTestId("screener-list");
    const sbin = within(within(list).getAllByTestId("screener-card")[0]);
    expect(sbin.getByText("SBIN")).toBeInTheDocument();
    expect(sbin.getByText("+3.2%")).toBeInTheDocument();
    expect(sbin.getByText("−1.1%")).toBeInTheDocument();
    expect(sbin.getByText("Trending up")).toBeInTheDocument();
    expect(sbin.getByText("Near 52-week high")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Trend"), "ranging");
    const cards = within(screen.getByTestId("screener-list")).getAllByTestId("screener-card");
    expect(cards).toHaveLength(1);
    expect(within(cards[0]).getByText("ITC")).toBeInTheDocument();
  });

  it("switches between the two scans", async () => {
    const user = userEvent.setup();
    renderAt("/scan");
    await screen.findByTestId("oi-list");
    await user.click(screen.getByRole("tab", { name: "Screener" }));
    expect(await screen.findByTestId("screener-list")).toBeInTheDocument();
  });

  it("opens the same inline chart Chart does on OI buildup, one card at a time", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=screener");
    const list = await screen.findByTestId("screener-list");
    const cards = within(list).getAllByTestId("screener-card");
    const [sbin, itc] = [within(cards[0]), within(cards[1])];
    await user.click(sbin.getByRole("button", { name: "Chart" }));
    expect(await sbin.findByTestId("chart-pane")).toBeInTheDocument();
    expect(sbin.getByRole("button", { name: "1d" })).toHaveAttribute("aria-pressed", "true");
    expect(sbin.getByRole("link", { name: /Open in Trade/ })).toHaveAttribute("href", "/trade?symbol=SBIN&segment=NSE");
    await user.click(itc.getByRole("button", { name: "Chart" })); // opening the second closes the first
    expect(sbin.queryByTestId("chart-pane")).not.toBeInTheDocument();
    expect(await itc.findByTestId("chart-pane")).toBeInTheDocument();
  });
});

describe("Custom screen", () => {
  it("disables Preview and Save, with reasons, until the form is minimally valid", async () => {
    renderAt("/scan?tab=custom");
    await screen.findByLabelText("Condition");
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save screen" })).toBeDisabled();
    expect(screen.getByText(/Give the screen a label/)).toBeInTheDocument();
    expect(screen.getByText(/Type a condition/)).toBeInTheDocument();
  });

  it("previews an ad-hoc expression and shows the matches, with a chart toggle", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await screen.findByLabelText("Condition");
    await user.type(screen.getByLabelText("Label"), "Bearish breakout");
    await user.type(screen.getByLabelText("Condition"), "close > 100");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const result = await screen.findByTestId("custom-screen-result");
    expect(within(result).getByText(/1 of 2 stocks matched/)).toBeInTheDocument();
    const match = within(screen.getByTestId("custom-screen-matches"));
    expect(match.getByText("TCS")).toBeInTheDocument();
    expect(match.getByRole("button", { name: "Chart" })).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the same inline chart Chart does on OI buildup, and closes it again on the next Preview", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await screen.findByLabelText("Condition");
    await user.type(screen.getByLabelText("Label"), "Bearish breakout");
    await user.type(screen.getByLabelText("Condition"), "close > 100");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const match = within(await screen.findByTestId("custom-screen-matches"));
    await user.click(match.getByRole("button", { name: "Chart" }));
    expect(await match.findByTestId("chart-pane")).toBeInTheDocument();
    expect(match.getByRole("button", { name: "1d" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Preview" })); // a fresh run drops any open chart
    expect(within(await screen.findByTestId("custom-screen-matches")).queryByTestId("chart-pane")).not.toBeInTheDocument();
  });

  it("shows the server's own parse error in words, not a generic failure", async () => {
    previewErrorDetail = "Unknown name 'banana'. Expected one of: close, open, high, low, weekly_close, ema(N), min(x, N), max(x, N).";
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await screen.findByLabelText("Condition");
    await user.type(screen.getByLabelText("Label"), "x");
    await user.type(screen.getByLabelText("Condition"), "banana > 100");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/Unknown name 'banana'/)).toBeInTheDocument();
    expect(screen.queryByTestId("custom-screen-result")).not.toBeInTheDocument();
  });

  it("saves a new screen, lists it, runs it, edits it, and deletes it (with a confirm step)", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await screen.findByLabelText("Condition");
    await user.type(screen.getByLabelText("Label"), "Bearish breakout");
    await user.type(screen.getByLabelText("Condition"), "close > 100");
    await user.click(screen.getByRole("button", { name: "Save screen" }));

    // Saving switches to the Saved screens tab, where the new screen now shows.
    const list = await screen.findByTestId("saved-screens");
    expect(within(list).getByText("Bearish breakout")).toBeInTheDocument();
    expect(within(list).getByText("close > 100")).toBeInTheDocument();

    await user.click(within(screen.getByTestId("saved-screen")).getByRole("button", { name: "Run" }));
    expect(await screen.findByTestId("custom-screen-matches")).toBeInTheDocument();

    // Editing switches back to the form tab, with the screen's own values loaded.
    await user.click(within(screen.getByTestId("saved-screen")).getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Label")).toHaveValue("Bearish breakout");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Label"));
    await user.type(screen.getByLabelText("Label"), "Renamed");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await within(screen.getByTestId("saved-screens")).findByText("Renamed")).toBeInTheDocument();

    // Delete asks first - one tap alone must not remove it.
    await user.click(within(screen.getByTestId("saved-screen")).getByRole("button", { name: "Delete" }));
    expect(within(screen.getByTestId("saved-screen")).getByText("Delete this screen?")).toBeInTheDocument();
    await user.click(within(screen.getByTestId("saved-screen")).getByRole("button", { name: "Keep" }));
    expect(within(screen.getByTestId("saved-screens")).getByText("Renamed")).toBeInTheDocument(); // still there
    await user.click(within(screen.getByTestId("saved-screen")).getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByTestId("saved-screen")).getByRole("button", { name: "Confirm delete" }));
    expect(await screen.findByText("No saved screens yet")).toBeInTheDocument();
  });

  it("Cancel leaves an edit in progress without saving anything", async () => {
    customScreens = [{ id: "s1", label: "Existing", expression: "close > 1", is_fno: null, index_membership: null, min_price: null, max_price: null, created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z" }];
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await user.click(await screen.findByRole("tab", { name: /Saved screens/ }));
    await user.click(within(await screen.findByTestId("saved-screen")).getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Label")).toHaveValue("Existing"); // switched to the form tab
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Label")).toHaveValue("");
    await user.click(screen.getByRole("tab", { name: /Saved screens/ }));
    expect(within(screen.getByTestId("saved-screen")).getByText("Existing")).toBeInTheDocument(); // unchanged
  });

  it("names the active universe filters next to the results", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await screen.findByLabelText("Condition");
    await user.type(screen.getByLabelText("Label"), "x");
    await user.type(screen.getByLabelText("Condition"), "close > 100");
    await user.selectOptions(screen.getByLabelText("F&O"), "yes");
    await user.selectOptions(screen.getByLabelText("Index"), "NIFTY100");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/F&O stocks, in NIFTY100/)).toBeInTheDocument();
  });

  it("has no min/max price fields - a price range is just another condition", async () => {
    renderAt("/scan?tab=custom");
    await screen.findByLabelText("Condition");
    expect(screen.queryByLabelText("Min price")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Max price")).not.toBeInTheDocument();
  });
});
