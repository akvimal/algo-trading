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

// The Scan page's option leg table (ScanOptionBias) reads a real option chain now, not a
// preview-legs round trip per click - TCS's spot is 2500 (matches the /quotes/ltp mock below),
// ATM at the 2500 strike for both sides.
const OPTION_EXPIRY = "2026-10-30";
const chainLeg = (securityId: string, lastPrice: number, moneyness: "ITM" | "ATM" | "OTM") => ({ security_id: securityId, last_price: lastPrice, oi: 5000, moneyness });
const chainStrikes = [
  { strike: 2300, ce: chainLeg("ce-2300", 300, "ITM"), pe: chainLeg("pe-2300", 25, "OTM") },
  { strike: 2400, ce: chainLeg("ce-2400", 200, "ITM"), pe: chainLeg("pe-2400", 50, "OTM") },
  { strike: 2500, ce: chainLeg("ce-2500", 100, "ATM"), pe: chainLeg("pe-2500", 100, "ATM") },
  { strike: 2600, ce: chainLeg("ce-2600", 50, "OTM"), pe: chainLeg("pe-2600", 200, "ITM") },
  { strike: 2700, ce: chainLeg("ce-2700", 25, "OTM"), pe: chainLeg("pe-2700", 300, "ITM") },
];

let oi: { snapshot_date: string; rows: object[] };
let scr: { snapshot_date: string; rows: object[] };
let oiStatus = 200;
let customScreens: any[];
let previewResult: any;
let previewErrorDetail: string | null;
let seq: number;
let calls: { url: string; method: string }[];
let account: Record<string, any>;
let regimeRead: Record<string, any>;
let placeManual: (body: any) => Response;
let placeOption: (body: any) => Response;
let openPositionsFor: Record<string, any[]>; // keyed by symbol - GET /positions?symbol=...&status=OPEN
let openGroupsFor: Record<string, any[]>; // keyed by symbol - GET /option-groups?symbol=...&status=OPEN
let squareOffFails: boolean;

beforeEach(() => {
  calls = [];
  oi = { snapshot_date: "2026-09-25", rows: [oiRow("RELIANCE"), oiRow("TCS", { call_oi_change_pct: 12, call_buildup: "short_buildup" })] };
  scr = { snapshot_date: "2026-09-25", rows: [scrRow("SBIN"), scrRow("ITC", { regime: "ranging", proximity: null, pct_change_5d: -2 })] };
  oiStatus = 200;
  customScreens = [];
  previewResult = { snapshot_date: "2026-09-25", candidates: 2, matches: [{ symbol: "TCS", exchange: "NSE", close: 3500 }] };
  previewErrorDetail = null;
  seq = 0;
  account = {
    segment: "NSE", starting_balance: 200000, current_balance: 200000, realized_pnl: 0, unrealized_pnl: 0, capital_per_trade: 100000,
    max_daily_loss: null, live_trading_enabled: false, apply_charges: false, require_stop_loss: false, square_off_time: null,
    risk_per_trade_pct: 1, min_reward_risk_ratio: 2, enforce_risk_based_lots: false, slippage_bps: 0, max_order_value: null, live_trading_consent_at: null,
  };
  regimeRead = { regime: "trending_up", trend: "up", adx: 28 };
  placeManual = () => json({ id: "p1", status: "OPEN" });
  placeOption = () => json({ id: "g1", status: "OPEN" });
  openPositionsFor = {};
  openGroupsFor = {};
  squareOffFails = false;
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
      if (url.endsWith("/accounts")) return json([account]);
      if (url.includes("/regime")) return json(regimeRead);
      if (url.endsWith("/positions/manual")) return placeManual(init?.body ? JSON.parse(init.body as string) : {});
      if (url.endsWith("/option-groups/manual")) return placeOption(init?.body ? JSON.parse(init.body as string) : {});
      if (url.includes("/positions?") && method === "GET") return json(openPositionsFor[new URL(url).searchParams.get("symbol") ?? ""] ?? []);
      if (url.includes("/option-groups?") && method === "GET") return json(openGroupsFor[new URL(url).searchParams.get("symbol") ?? ""] ?? []);
      if (/\/positions\/[^/]+\/square-off$/.test(url)) return squareOffFails ? json({ detail: "Could not reach the broker." }, 502) : json({ ok: true });
      if (/\/option-groups\/[^/]+\/square-off$/.test(url)) return squareOffFails ? json({ detail: "Could not reach the broker." }, 502) : json({ ok: true });
      if (url.includes("/options/expiries")) return json({ expiries: [OPTION_EXPIRY, "2026-11-06"] });
      if (url.includes("/options/chain")) {
        const expiry = new URL(url).searchParams.get("expiry") ?? OPTION_EXPIRY;
        return json({ underlying_symbol: "TCS", underlying_exchange: "NSE", expiry, underlying_last_price: 2500, strikes: chainStrikes });
      }
      if (url.includes("/dhan/lot-size")) return json({ lot_size: 500 });
      if (url.includes("/dhan/margin/combo")) return json({ raw: { totalMargin: 40760 } });
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

  describe("major two-sided shifts", () => {
    const shifted = () => {
      oi = {
        snapshot_date: "2026-09-25",
        rows: [
          oiRow("BULLISH", { call_buildup: "long_buildup", put_buildup: "long_buildup", call_oi_change_pct: 22, put_oi_change_pct: 18 }),
          oiRow("MILD", { call_buildup: "long_buildup", put_buildup: "long_buildup", call_oi_change_pct: 12, put_oi_change_pct: 11 }),
          oiRow("TINY", { call_buildup: "long_buildup", put_buildup: "long_buildup", call_oi_change_pct: 4, put_oi_change_pct: 3 }),
          oiRow("BEARISH", { call_buildup: "short_buildup", put_buildup: "short_buildup", call_oi_change_pct: 15, put_oi_change_pct: 14 }),
          oiRow("PLAIN"),
        ],
      };
    };
    const signal = (name: string) => within(screen.getByRole("group", { name: "Signal" })).getByRole("button", { name });

    it("badges a stock with a major shift in the all-stocks list, using the 10% default", async () => {
      shifted();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const badges = within(list).getAllByTestId("oi-signal-badge").map((b) => b.textContent);
      expect(badges.sort()).toEqual(["Strong bearish", "Strong bullish", "Strong bullish"]); // TINY (under 10%) has none
    });

    it("has a preset for each direction, sorting the biggest shift first, and the size box appears with it at 10", async () => {
      shifted();
      const user = userEvent.setup();
      renderAt("/scan");
      await screen.findByTestId("oi-list");
      expect(screen.queryByLabelText("Both sides up at least (%)")).not.toBeInTheDocument();
      await user.click(signal("Strong bullish"));
      expect(screen.getByLabelText("Both sides up at least (%)")).toHaveValue(10);
      const cards = within(screen.getByTestId("oi-list")).getAllByTestId("oi-card");
      expect(cards).toHaveLength(2);
      expect(cards[0]).toHaveTextContent("BULLISH");
      expect(cards[1]).toHaveTextContent("MILD");
      expect(screen.getByLabelText("Sort by")).toHaveValue("strength");
      expect(screen.getByTestId("oi-signal-help")).toHaveTextContent(/at least 10%/);
      await user.click(signal("Strong bearish"));
      const bearCards = within(screen.getByTestId("oi-list")).getAllByTestId("oi-card");
      expect(bearCards).toHaveLength(1);
      expect(bearCards[0]).toHaveTextContent("BEARISH");
    });

    it("lets the threshold be changed, and a lower one lets smaller shifts in", async () => {
      shifted();
      const user = userEvent.setup();
      renderAt("/scan");
      await screen.findByTestId("oi-list");
      await user.click(signal("Strong bullish"));
      const box = screen.getByLabelText("Both sides up at least (%)");
      await user.clear(box);
      await user.type(box, "3");
      expect(within(screen.getByTestId("oi-list")).getAllByTestId("oi-card")).toHaveLength(3);
      await user.clear(box);
      await user.type(box, "15");
      const cards = within(screen.getByTestId("oi-list")).getAllByTestId("oi-card");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toHaveTextContent("BULLISH");
    });

    it("says nothing matches when no stock has a major shift, and All stocks brings the list back", async () => {
      oi = { snapshot_date: "2026-09-25", rows: [oiRow("PLAIN")] };
      const user = userEvent.setup();
      renderAt("/scan");
      await screen.findByTestId("oi-list");
      await user.click(signal("Strong bullish"));
      expect(await screen.findByText("No stocks match")).toBeInTheDocument();
      await user.click(signal("All stocks"));
      expect(within(screen.getByTestId("oi-list")).getAllByTestId("oi-card")).toHaveLength(1);
      expect(screen.queryByLabelText("Both sides up at least (%)")).not.toBeInTheDocument();
    });
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
      // The full Trade page is still one tap away - not lost, just no longer the default action.
      expect(tcs.getByRole("link", { name: /Open the full Trade page/ })).toHaveAttribute("href", "/trade?symbol=TCS&segment=NSE");
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

    it("switches interval without leaving the card", async () => {
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

    it("only offers 15m/1d/1w - a scan card is an end-of-day/swing read, not an intraday one", async () => {
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const tcs = within(within(list).getAllByTestId("oi-card")[0]);
      await user.click(tcs.getByRole("button", { name: "Chart" }));
      await tcs.findByTestId("chart-pane");
      expect(tcs.getByRole("button", { name: "15m" })).toBeInTheDocument();
      expect(tcs.getByRole("button", { name: "1d" })).toBeInTheDocument();
      expect(tcs.getByRole("button", { name: "1w" })).toBeInTheDocument();
      for (const label of ["1m", "3m", "5m", "30m", "1h"]) expect(tcs.queryByRole("button", { name: label })).not.toBeInTheDocument();
    });
  });

  describe("the inline trade ticket", () => {
    it("opens the real ticket in the card on Trade, with a Spot/Option choice of its own", async () => {
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const tcs = within(within(list).getAllByTestId("oi-card")[0]); // TCS
      await user.click(tcs.getByRole("button", { name: "Trade" }));
      expect(tcs.getByRole("button", { name: "Close trade" })).toHaveAttribute("aria-expanded", "true");
      expect(await tcs.findByTestId("ticket")).toBeInTheDocument();
      // Defaults to Option, not Spot - every OI-buildup row has an option chain by definition.
      expect(tcs.getByRole("button", { name: "Option" })).toHaveAttribute("aria-pressed", "true");
      expect(tcs.getByRole("button", { name: "Spot" })).toBeInTheDocument();
      // No Future/Option/Option spread chips from TradeTicket itself - ScanTradePanel's own
      // Spot/Option choice is the only one shown (hideStrategyChips).
      expect(tcs.queryByRole("button", { name: "Option spread" })).not.toBeInTheDocument();
      await user.click(tcs.getByRole("button", { name: "Close trade" }));
      expect(tcs.queryByTestId("ticket")).not.toBeInTheDocument();
    });

    it("shows an already-open spot position with its own status and a square-off, instead of the ticket entirely", async () => {
      openPositionsFor.TCS = [
        {
          id: "ep1", symbol: "TCS", exchange: "NSE", segment: "NSE", action: "BUY", horizon: "intraday", instrument_type: "spot", quantity: 10,
          entry_price: 2400, entry_time: "2026-09-25T04:00:00Z", exit_price: null, exit_time: null, pnl: null, unrealized_pnl: 500,
          status: "OPEN", stop_loss_price: 2350, target_price: 2600, option_group_id: null, trailing_stop_enabled: false,
        },
      ];
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const tcs = within(within(list).getAllByTestId("oi-card")[0]);
      await user.click(tcs.getByRole("button", { name: "Trade" }));
      const card = await tcs.findByTestId("position-card");
      expect(within(card).getByText("TCS")).toBeInTheDocument();
      expect(within(card).getByText("+₹500")).toBeInTheDocument();
      // An active position takes over the whole panel - no Instrument toggle, no ticket, nothing
      // to place another order with (Portfolio's own positions list is still where you pyramid).
      expect(tcs.queryByTestId("ticket")).not.toBeInTheDocument();
      expect(tcs.queryByRole("group", { name: "Instrument" })).not.toBeInTheDocument();
      await user.click(within(card).getByRole("button", { name: "Square off" }));
      await user.click(within(card).getByRole("button", { name: "Confirm square off" }));
      await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.includes("/positions/ep1/square-off"))).toBe(true));
    });

    it("shows an already-open option group with its own status, economics and a square-off, instead of the ticket", async () => {
      openGroupsFor.TCS = [
        {
          id: "eg1", underlying_symbol: "TCS", action: "BUY", strategy_type: "naked_call", quantity: 500, unrealized_pnl: 1200,
          status: "OPEN", entry_spot_price: 2500, entry_time: "2026-09-25T04:00:00Z", spot_stop_loss_trailing_enabled: false,
          net_debit: 100, live_combined_price: 110,
        },
      ];
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const tcs = within(within(list).getAllByTestId("oi-card")[0]);
      await user.click(tcs.getByRole("button", { name: "Trade" }));
      const card = await tcs.findByTestId("position-card");
      expect(within(card).getByText("TCS")).toBeInTheDocument();
      expect(within(card).getByText(/naked call/)).toBeInTheDocument();
      expect(within(card).getByTestId("pos-option-metrics")).toHaveTextContent("Premium");
      expect(tcs.queryByTestId("ticket")).not.toBeInTheDocument();
      // An option position gets its own inline chart toggle, scoped to the card itself (distinct
      // from OiCard's own top-level Chart button) - so squaring off is an informed decision.
      await user.click(within(card).getByRole("button", { name: "Chart" }));
      expect(await within(card).findByTestId("chart-pane")).toBeInTheDocument();
      await user.click(within(card).getByRole("button", { name: "Hide chart" }));
      expect(within(card).queryByTestId("chart-pane")).not.toBeInTheDocument();
      await user.click(within(card).getByRole("button", { name: "Square off" }));
      await user.click(within(card).getByRole("button", { name: "Confirm square off" }));
      await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.includes("/option-groups/eg1/square-off"))).toBe(true));
    });

    it("picking Option shows a Bullish/Bearish view instead of naked/spread jargon, with the real recommended legs - not a PRESETS symbol, but every OI-buildup row has an option chain by definition", async () => {
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const tcs = within(within(list).getAllByTestId("oi-card")[0]); // TCS
      await user.click(tcs.getByRole("button", { name: "Trade" }));
      await tcs.findByTestId("ticket");
      await user.click(tcs.getByRole("button", { name: "Option" }));
      expect(tcs.getByRole("button", { name: "Bullish" })).toHaveAttribute("aria-pressed", "true"); // BUY is the ticket's own default
      expect(tcs.getByRole("button", { name: "Bearish" })).toBeInTheDocument();
      expect(tcs.queryByRole("button", { name: "Option spread" })).not.toBeInTheDocument(); // TradeTicket's own chips stay hidden
      expect(tcs.queryByText("Strike", { selector: "span.dim" })).not.toBeInTheDocument(); // TradeTicket's own moneyness dropdown stays hidden too

      // The leg table now reads a real option chain (fetched once), not a preview-legs round
      // trip per click - every strike is a real dropdown option, Lots is editable right in the
      // table, and Expiry is its own dropdown above it.
      const expirySelect = await tcs.findByRole("combobox", { name: "Expiry" });
      expect(within(expirySelect).getByRole("option", { name: "30 Oct" })).toBeInTheDocument();
      expect(within(expirySelect).getByRole("option", { name: "6 Nov" })).toBeInTheDocument();
      expect(expirySelect).toHaveValue(OPTION_EXPIRY);

      // No default_option_strategy set on this mocked profile, so ProfileContext falls back to
      // "naked" (see items 4/5) - a single row, and an unchecked "add a second leg" checkbox.
      let table = await tcs.findByTestId("option-leg-table");
      let rows = within(table).getAllByRole("row").slice(1); // drop the header row
      expect(rows).toHaveLength(2); // the primary leg's own row, plus the "add a second leg" row
      expect(within(rows[0]).getByText("Buy")).toBeInTheDocument();
      expect(within(rows[0]).getByRole("combobox", { name: "Primary leg strike" })).toHaveValue("2500"); // ATM
      expect(within(rows[0]).getByText("CE")).toBeInTheDocument();
      expect(within(rows[0]).getByText("₹100.00")).toBeInTheDocument();
      expect(tcs.getByRole("checkbox", { name: "Add a second leg to cap the risk" })).not.toBeChecked();
      expect(tcs.getByTestId("option-strategy-summary")).toHaveTextContent("Buy Call");
      expect(tcs.queryByRole("group", { name: "Debit or credit" })).not.toBeInTheDocument(); // naked - no style choice yet

      // Lots is editable right in the leg table now (hideOptionExtras dropped the standalone
      // field), and defaults to 1 (not blank/"auto") the first time the option view is entered.
      const lotsInput = within(rows[0]).getByRole("spinbutton");
      await waitFor(() => expect(lotsInput).toHaveValue(1));
      await waitFor(() => expect(tcs.getByTestId("option-economics")).toHaveTextContent("Max loss")); // fills in once lot size loads
      await user.click(tcs.getByRole("button", { name: "Check margin (Dhan)" }));
      await waitFor(() => expect(tcs.getByTestId("option-economics")).toHaveTextContent("₹40,760.00")); // the mocked Dhan combo-margin figure

      await user.clear(lotsInput);
      await user.type(lotsInput, "3");
      expect(lotsInput).toHaveValue(3);

      await user.click(tcs.getByRole("checkbox", { name: "Add a second leg to cap the risk" }));
      table = await tcs.findByTestId("option-leg-table");
      rows = within(table).getAllByRole("row").slice(1);
      expect(rows).toHaveLength(2);
      expect(within(rows[1]).getByText("Sell")).toBeInTheDocument();
      expect(within(rows[1]).getByRole("combobox", { name: "Second leg strike" })).toHaveValue("2700"); // default: 2 strikes OTM from the 2500 ATM primary
      expect(within(rows[1]).getByText("₹25.00")).toBeInTheDocument();
      expect(tcs.getByRole("checkbox", { name: "Remove the second leg (buy the option outright)" })).toBeChecked();
      expect(tcs.getByTestId("option-strategy-summary")).toHaveTextContent("Bull Call Spread");
      expect(tcs.getByTestId("option-strategy-summary")).toHaveTextContent("Net debit ₹75.00 per lot"); // 100 - 25
      expect(tcs.getByRole("button", { name: "Pay premium (debit)" })).toHaveAttribute("aria-pressed", "true");
      // Combined stop-loss %/target % only appear for a two-leg position, defaulting 50/70.
      expect(tcs.getByLabelText("Stop-loss (% of max loss)")).toHaveValue(50);
      expect(tcs.getByLabelText("Target (% of max profit)")).toHaveValue(70);

      // Picking any strike directly - not just stepping through a fixed ITM/OTM ladder - and no
      // network round trip: the chain's already in hand, so this re-renders instantly.
      await user.selectOptions(within(rows[0]).getByRole("combobox", { name: "Primary leg strike" }), "2400");
      expect(within(rows[0]).getByText("₹200.00")).toBeInTheDocument();
      expect(tcs.getByTestId("option-strategy-summary")).toHaveTextContent("Net debit ₹175.00 per lot"); // 200 - 25
      expect(within(rows[1]).getByRole("combobox", { name: "Second leg strike" })).toHaveValue("2700"); // untouched by the primary leg's own pick

      await user.selectOptions(within(rows[1]).getByRole("combobox", { name: "Second leg strike" }), "2600");
      expect(within(rows[1]).getByText("₹50.00")).toBeInTheDocument();
      expect(tcs.getByTestId("option-strategy-summary")).toHaveTextContent("Net debit ₹150.00 per lot"); // 200 - 50

      // Switching to Credit swaps in bull_put_spread - the SELL leg is now primary, and picking
      // it up flips to the PE column (fresh ATM/width-2 defaults, since a CE strike means nothing
      // on the put side).
      await user.click(tcs.getByRole("button", { name: "Receive premium (credit)" }));
      await waitFor(() => expect(tcs.getByTestId("option-strategy-summary")).toHaveTextContent("Bull Put Spread"));
      table = await tcs.findByTestId("option-leg-table");
      rows = within(table).getAllByRole("row").slice(1);
      expect(within(rows[0]).getByText("Sell")).toBeInTheDocument();
      expect(within(rows[0]).getByText("PE")).toBeInTheDocument();
      expect(within(rows[1]).getByText("Buy")).toBeInTheDocument();
      expect(tcs.getByTestId("option-strategy-summary")).toHaveTextContent("Net credit ₹75.00 per lot"); // 100 (SELL 2500 PE) - 25 (BUY 2300 PE)
      // Max loss/profit are real totals now (per-unit x lots x the contract's own real lot size,
      // fetched from Dhan - see getLotSizeForSecurity) - lots is 3 here (typed earlier), lot size
      // 500 per the mock -> quantity 1500. Per-unit max loss = width 200 - credit 75 = 125.
      expect(tcs.getByTestId("option-economics")).toHaveTextContent("Max loss");
      await waitFor(() => expect(tcs.getByTestId("option-economics")).toHaveTextContent("₹1,87,500.00"));

      await user.click(tcs.getByRole("button", { name: "Bearish" }));
      await waitFor(() => expect(tcs.getByTestId("option-strategy-summary")).toHaveTextContent("Bear Call Spread")); // credit_spread + Bearish
      table = await tcs.findByTestId("option-leg-table");
      rows = within(table).getAllByRole("row").slice(1);
      expect(within(rows[0]).getByText("CE")).toBeInTheDocument();
    });

    it("Chart and Trade are independent - both can be open on the same card, and different cards can each have one open", async () => {
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const [tcs, reliance] = [within(within(list).getAllByTestId("oi-card")[0]), within(within(list).getAllByTestId("oi-card")[1])];
      await user.click(tcs.getByRole("button", { name: "Chart" }));
      await user.click(tcs.getByRole("button", { name: "Trade" }));
      expect(await tcs.findByTestId("chart-pane")).toBeInTheDocument();
      expect(tcs.getByTestId("ticket")).toBeInTheDocument();
      await user.click(reliance.getByRole("button", { name: "Trade" })); // a different card's Trade closes TCS's, not its chart
      expect(tcs.queryByTestId("ticket")).not.toBeInTheDocument();
      expect(tcs.getByTestId("chart-pane")).toBeInTheDocument();
      expect(await reliance.findByTestId("ticket")).toBeInTheDocument();
    });

    it("places a spot order straight from the card", async () => {
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const tcs = within(within(list).getAllByTestId("oi-card")[0]);
      await user.click(tcs.getByRole("button", { name: "Trade" }));
      await tcs.findByTestId("ticket");
      await user.click(tcs.getByRole("button", { name: "Spot" })); // defaults to Option now - every OI-buildup row has an option chain
      await user.type(tcs.getByLabelText("Stop-loss"), "2400");
      await user.click(tcs.getByRole("button", { name: /Buy TCS, paper order/ }));
      await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/positions/manual"))).toBe(true));
      const posted = calls.find((c) => c.method === "POST" && c.url.endsWith("/positions/manual"))!;
      expect(posted).toBeDefined();
    });

    it("places an option order straight from the card - defaults to Option, no spot-oriented chrome at all", async () => {
      // Defaults to Option (no click needed) - and no Order type/Stop-loss/Target/Lots/checks/
      // Confidence for an option trade here (hideOptionExtras): every option position this
      // platform can place is already risk-capped by construction, so analyzeTicket never
      // requires a stop-loss for one regardless of the account's own require_stop_loss setting.
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const tcs = within(within(list).getAllByTestId("oi-card")[0]);
      await user.click(tcs.getByRole("button", { name: "Trade" }));
      await tcs.findByTestId("ticket");
      expect(tcs.queryByRole("group", { name: "Order type" })).not.toBeInTheDocument();
      expect(tcs.queryByLabelText("Stop-loss")).not.toBeInTheDocument();
      expect(tcs.queryByTestId("checks")).not.toBeInTheDocument();
      expect(tcs.getByLabelText("Why this trade? (helps your review later)")).toBeInTheDocument(); // kept, unlike the rest
      await user.click(tcs.getByRole("button", { name: /Buy TCS, paper order/ }));
      await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/option-groups/manual"))).toBe(true));
    });

    it("hides Stop-loss/Order type for an option trade even when the account requires a stop-loss", async () => {
      account.require_stop_loss = true;
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const tcs = within(within(list).getAllByTestId("oi-card")[0]);
      await user.click(tcs.getByRole("button", { name: "Trade" }));
      await tcs.findByTestId("ticket");
      expect(tcs.queryByLabelText(/Stop-loss/)).not.toBeInTheDocument();
      expect(tcs.queryByRole("group", { name: "Order type" })).not.toBeInTheDocument();
      // Not blocked by the account's own requirement either - placing still works.
      await user.click(tcs.getByRole("button", { name: /Buy TCS, paper order/ }));
      await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/option-groups/manual"))).toBe(true));
    });

    it("shows the live-trading notice instead of a ticket when the account is set to live", async () => {
      account.live_trading_enabled = true;
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const tcs = within(within(list).getAllByTestId("oi-card")[0]);
      await user.click(tcs.getByRole("button", { name: "Trade" }));
      expect(await tcs.findByText(/set to live trading/)).toBeInTheDocument();
      expect(tcs.queryByTestId("ticket")).not.toBeInTheDocument();
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
    expect(sbin.getByRole("link", { name: /Open the full Trade page/ })).toHaveAttribute("href", "/trade?symbol=SBIN&segment=NSE");
    await user.click(itc.getByRole("button", { name: "Chart" })); // opening the second closes the first
    expect(sbin.queryByTestId("chart-pane")).not.toBeInTheDocument();
    expect(await itc.findByTestId("chart-pane")).toBeInTheDocument();
  });

  it("also has its own Trade panel now, independent of Chart - a non-F&O stock gets Spot/Buy only, no toggle to switch either away", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=screener");
    const list = await screen.findByTestId("screener-list");
    const sbin = within(within(list).getAllByTestId("screener-card")[0]);
    await user.click(sbin.getByRole("button", { name: "Trade" }));
    expect(await sbin.findByTestId("ticket")).toBeInTheDocument();
    // SBIN isn't a PRESETS symbol (no F&O here) - the Instrument (Spot/Option) toggle and the
    // Side (Buy/Sell) chips both stay hidden: a cash-equity stock can only ever be a long spot buy.
    expect(sbin.queryByRole("group", { name: "Instrument" })).not.toBeInTheDocument();
    expect(sbin.queryByRole("group", { name: "Side" })).not.toBeInTheDocument();
    await user.click(sbin.getByRole("button", { name: "Chart" }));
    expect(await sbin.findByTestId("chart-pane")).toBeInTheDocument();
    expect(sbin.getByTestId("ticket")).toBeInTheDocument(); // Chart and Trade are independent here too
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

  it("offers example conditions that fill the box, including intraday ones and prev()", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await screen.findByLabelText("Condition");
    const examples = within(screen.getByRole("group", { name: "Example conditions" }));
    await user.click(examples.getByRole("button", { name: "15m EMA cross" }));
    expect(screen.getByLabelText("Condition")).toHaveValue("m15_ema(5) crosses_above m15_ema(20)");
    await user.click(examples.getByRole("button", { name: "Above previous 15m high" }));
    expect(screen.getByLabelText("Condition")).toHaveValue("m15_close > prev(m15_high)");
  });

  it("says the intraday bars are read live, and shows why some stocks were not checked", async () => {
    previewResult = { snapshot_date: "2026-09-25", candidates: 80, matches: [{ symbol: "TCS", exchange: "NSE", close: 3500 }], intraday_skipped: 20, intraday_note: "20 of 80 stocks were not checked: intraday bars are fetched live, so a run covers at most 60 stocks." };
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await screen.findByLabelText("Condition");
    await user.type(screen.getByLabelText("Label"), "15m");
    await user.click(screen.getByRole("button", { name: "15m EMA cross" }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const result = await screen.findByTestId("custom-screen-result");
    expect(within(result).getByText(/intraday bars read live/)).toBeInTheDocument();
    expect(within(result).getByTestId("intraday-note")).toHaveTextContent("20 of 80 stocks were not checked");
  });

  it("shows no intraday line for a daily condition", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await screen.findByLabelText("Condition");
    await user.type(screen.getByLabelText("Label"), "x");
    await user.type(screen.getByLabelText("Condition"), "close > 100");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const result = await screen.findByTestId("custom-screen-result");
    expect(within(result).queryByText(/intraday bars read live/)).not.toBeInTheDocument();
    expect(within(result).queryByTestId("intraday-note")).not.toBeInTheDocument();
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

  it("also has its own Trade panel now, independent of Chart", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=custom");
    await screen.findByLabelText("Condition");
    await user.type(screen.getByLabelText("Label"), "Bearish breakout");
    await user.type(screen.getByLabelText("Condition"), "close > 100");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const match = within(await screen.findByTestId("custom-screen-matches"));
    await user.click(match.getByRole("button", { name: "Trade" }));
    expect(await match.findByTestId("ticket")).toBeInTheDocument();
    await user.click(match.getByRole("button", { name: "Chart" }));
    expect(await match.findByTestId("chart-pane")).toBeInTheDocument();
    expect(match.getByTestId("ticket")).toBeInTheDocument(); // still open - Chart and Trade are independent
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
