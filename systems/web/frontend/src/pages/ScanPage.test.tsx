import { render, screen, within } from "@testing-library/react";
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

beforeEach(() => {
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
      if (url.includes("/oi-buildup")) return oiStatus === 200 ? json(oi) : json({ detail: "boom" }, oiStatus);
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
  it("lists stocks biggest call-OI change first, in plain words, with a chart link", async () => {
    renderAt("/scan");
    const list = await screen.findByTestId("oi-list");
    const cards = within(list).getAllByTestId("oi-card");
    expect(cards.map((c) => within(c).getByRole("link").getAttribute("href"))).toEqual(["/trade?symbol=TCS&segment=NSE", "/trade?symbol=RELIANCE&segment=NSE"]);
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
});

describe("Custom screen", () => {
  it("disables Preview and Save, with reasons, until the form is minimally valid", async () => {
    renderAt("/scan?tab=custom");
    await screen.findByText("No saved screens yet");
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save screen" })).toBeDisabled();
    expect(screen.getByText(/Give the screen a label/)).toBeInTheDocument();
    expect(screen.getByText(/Type a condition/)).toBeInTheDocument();
  });

  it("previews an ad-hoc expression and shows the matches, with a chart link", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await screen.findByText("No saved screens yet");
    await user.type(screen.getByLabelText("Label"), "Bearish breakout");
    await user.type(screen.getByLabelText("Condition"), "close > 100");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const result = await screen.findByTestId("custom-screen-result");
    expect(within(result).getByText(/1 of 2 stocks matched/)).toBeInTheDocument();
    const match = within(screen.getByTestId("custom-screen-matches"));
    expect(match.getByText("TCS")).toBeInTheDocument();
    expect(match.getByRole("link", { name: "Chart" })).toHaveAttribute("href", "/trade?symbol=TCS&segment=NSE");
  });

  it("shows the server's own parse error in words, not a generic failure", async () => {
    previewErrorDetail = "Unknown name 'banana'. Expected one of: close, open, high, low, weekly_close, ema(N), min(x, N), max(x, N).";
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await screen.findByText("No saved screens yet");
    await user.type(screen.getByLabelText("Label"), "x");
    await user.type(screen.getByLabelText("Condition"), "banana > 100");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/Unknown name 'banana'/)).toBeInTheDocument();
    expect(screen.queryByTestId("custom-screen-result")).not.toBeInTheDocument();
  });

  it("saves a new screen, lists it, runs it, edits it, and deletes it", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await screen.findByText("No saved screens yet");
    await user.type(screen.getByLabelText("Label"), "Bearish breakout");
    await user.type(screen.getByLabelText("Condition"), "close > 100");
    await user.click(screen.getByRole("button", { name: "Save screen" }));

    const list = await screen.findByTestId("saved-screens");
    expect(within(list).getByText("Bearish breakout")).toBeInTheDocument();
    expect(within(list).getByText("close > 100")).toBeInTheDocument();
    // the form resets after a successful save
    expect(screen.getByLabelText("Label")).toHaveValue("");

    await user.click(within(screen.getByTestId("saved-screen")).getByRole("button", { name: "Run" }));
    expect(await screen.findByTestId("custom-screen-matches")).toBeInTheDocument();

    await user.click(within(screen.getByTestId("saved-screen")).getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Label")).toHaveValue("Bearish breakout");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Label"));
    await user.type(screen.getByLabelText("Label"), "Renamed");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await within(screen.getByTestId("saved-screens")).findByText("Renamed")).toBeInTheDocument();

    await user.click(within(screen.getByTestId("saved-screen")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No saved screens yet")).toBeInTheDocument();
  });

  it("Cancel leaves an edit in progress without saving anything", async () => {
    customScreens = [{ id: "s1", label: "Existing", expression: "close > 1", is_fno: null, index_membership: null, min_price: null, max_price: null, created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z" }];
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await user.click(within(await screen.findByTestId("saved-screen")).getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Label")).toHaveValue("Existing");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Label")).toHaveValue("");
    expect(within(screen.getByTestId("saved-screen")).getByText("Existing")).toBeInTheDocument(); // unchanged
  });

  it("names the active universe filters next to the results", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await screen.findByText("No saved screens yet");
    await user.type(screen.getByLabelText("Label"), "x");
    await user.type(screen.getByLabelText("Condition"), "close > 100");
    await user.selectOptions(screen.getByLabelText("F&O"), "yes");
    await user.type(screen.getByLabelText("Min price"), "100");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/F&O stocks, above ₹100/)).toBeInTheDocument();
  });
});
