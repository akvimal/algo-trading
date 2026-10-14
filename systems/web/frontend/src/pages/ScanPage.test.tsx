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
let zones: { snapshot_date: string | null; rows: object[] };
let zonesStatus = 200;
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
let waitingOrders: any[]; // GET /pending-orders?status=pending

beforeEach(() => {
  calls = [];
  oi = { snapshot_date: "2026-09-25", rows: [oiRow("RELIANCE"), oiRow("TCS", { call_oi_change_pct: 12, call_buildup: "short_buildup" })] };
  scr = { snapshot_date: "2026-09-25", rows: [scrRow("SBIN"), scrRow("ITC", { regime: "ranging", proximity: null, pct_change_5d: -2 })] };
  oiStatus = 200;
  zones = { snapshot_date: null, rows: [] };
  zonesStatus = 200;
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
  waitingOrders = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/oi-buildup")) return oiStatus === 200 ? json(oi) : json({ detail: "boom" }, oiStatus);
      if (url.includes("/zone-scan")) return zonesStatus === 200 ? json(zones) : json({ detail: "boom" }, zonesStatus);
      if (url.includes("/candles/history")) {
        const interval = new URL(url).searchParams.get("interval") ?? "daily";
        return json(candlesFor(new URL(url).searchParams.get("symbol") ?? "", interval));
      }
      if (url.includes("/quotes/ltp")) return json({ exchange: "NSE", symbol: new URL(url).searchParams.get("symbol"), ltp: 2500, provider: "dhan" });
      if (url.endsWith("/accounts")) return json([account]);
      if (url.includes("/regime")) return json(regimeRead);
      if (url.endsWith("/positions/manual")) return placeManual(init?.body ? JSON.parse(init.body as string) : {});
      if (url.endsWith("/option-groups/manual")) return placeOption(init?.body ? JSON.parse(init.body as string) : {});
      if (url.includes("/pending-orders") && method === "GET") return json(waitingOrders);
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
    expect(first.getByText("Writing")).toBeInTheDocument();
    expect(first.getByText(/Call OI 12\.35L/)).toBeInTheDocument();
    expect(first.getByText("1.62")).toBeInTheDocument();
    expect(screen.getByText(/End-of-day snapshot for 25 Sept/)).toBeInTheDocument();
    expect(screen.getByText(/not recommendations/)).toBeInTheDocument();
  });

  it("filters by the call side and by search, and says when nothing matches", async () => {
    const user = userEvent.setup();
    renderAt("/scan");
    await screen.findByTestId("oi-list");
    await user.selectOptions(screen.getByLabelText("Call side"), "buying");
    expect(within(screen.getByTestId("oi-list")).getAllByTestId("oi-card")).toHaveLength(1);
    await user.type(screen.getByLabelText("Search a symbol"), "zzz");
    expect(await screen.findByText("No stocks match")).toBeInTheDocument();
  });

  describe("At a zone (the nightly zone scan)", () => {
    const zoneRow = (symbol: string, over: object = {}) => ({
      symbol, exchange: "NSE", close: 2500, daily_trend: "down", weekly_trend: "down", tier: "A", zone_kind: "supply", zone_position: "approaching", zone_proximal: 2560, zone_distal: 2600,
      zone_distance_pct: 2.4, zone_distance_atr: 0.8, weekly_zone: true, weekly_agrees: true, call_buildup: "short_buildup", put_buildup: "short_buildup", oi_agrees: true, ...over,
    });
    const withZones = () => {
      oi = { snapshot_date: "2026-09-25", rows: ["AAA", "BBB", "CCC", "DDD"].map((s) => oiRow(s)) };
      zones = {
        snapshot_date: "2026-09-25",
        rows: [zoneRow("BBB", { tier: "B", zone_distance_atr: 0.3 }), zoneRow("AAA"), zoneRow("CCC", { tier: "C", zone_kind: "demand", zone_position: "inside", zone_distance_pct: 0, zone_distance_atr: 0, weekly_trend: null })],
      };
    };

    it("puts a badge on a stock at a zone, saying the tier, the side, how far away and the trend on each chart", async () => {
      withZones();
      renderAt("/scan");
      const cards = await within(await screen.findByTestId("oi-list")).findAllByTestId("oi-card");
      await waitFor(() => expect(screen.getAllByTestId("zone-badge")).toHaveLength(3));
      const aaa = within(cards.find((c) => c.textContent?.includes("AAA"))!);
      expect(aaa.getByTestId("zone-badge")).toHaveTextContent("Tier A · Supply");
      expect(aaa.getByText("2.4% below a supply zone")).toBeInTheDocument();
      expect(aaa.getByText(/Daily down, weekly down/)).toBeInTheDocument();
      const ccc = within(cards.find((c) => c.textContent?.includes("CCC"))!);
      expect(ccc.getByText("Inside a demand zone")).toBeInTheDocument();
      expect(ccc.getByText(/Daily down(?!, weekly)/)).toBeInTheDocument(); // no weekly read: not shown as "range"
      expect(within(cards.find((c) => c.textContent?.includes("DDD"))!).queryByTestId("zone-badge")).not.toBeInTheDocument();
    });

    it("the shortlist keeps tiers A and B, any zone adds C, and both read best tier first", async () => {
      withZones();
      const user = userEvent.setup();
      renderAt("/scan");
      await screen.findByTestId("oi-list");
      await waitFor(() => expect(screen.getAllByTestId("zone-badge")).toHaveLength(3));
      await user.selectOptions(screen.getByLabelText("At a zone"), "shortlist");
      let cards = within(screen.getByTestId("oi-list")).getAllByTestId("oi-card");
      expect(cards.map((c) => /AAA|BBB|CCC|DDD/.exec(c.textContent ?? "")![0])).toEqual(["AAA", "BBB"]); // A before B, though B is nearer
      await user.selectOptions(screen.getByLabelText("At a zone"), "any");
      cards = within(screen.getByTestId("oi-list")).getAllByTestId("oi-card");
      expect(cards.map((c) => /AAA|BBB|CCC|DDD/.exec(c.textContent ?? "")![0])).toEqual(["AAA", "BBB", "CCC"]);
      expect(screen.getByTestId("zone-help")).toHaveTextContent(/nightly scan of 25 Sept/);
      await user.selectOptions(screen.getByLabelText("At a zone"), "all");
      expect(within(screen.getByTestId("oi-list")).getAllByTestId("oi-card")).toHaveLength(4);
    });

    it("warns when the zone scan and the OI snapshot are from different days, since the tier was set against the other day's OI", async () => {
      withZones();
      zones = { ...zones, snapshot_date: "2026-09-24" };
      const user = userEvent.setup();
      renderAt("/scan");
      await screen.findByTestId("oi-list");
      await user.selectOptions(await screen.findByLabelText("At a zone"), "any");
      expect(await screen.findByTestId("zone-help")).toHaveTextContent(/scan of 24 Sept.*open interest on the cards is from 25 Sept, so a tier may not match it/);
    });

    it("works as before without the zone scan, and says why the filter matches nothing when it could not load", async () => {
      zonesStatus = 500;
      const user = userEvent.setup();
      renderAt("/scan");
      await screen.findByTestId("oi-list");
      expect(screen.queryByTestId("zone-badge")).not.toBeInTheDocument();
      expect(within(screen.getByTestId("oi-list")).getAllByTestId("oi-card")).toHaveLength(2);
      await user.selectOptions(screen.getByLabelText("At a zone"), "any");
      expect(await screen.findByText("No stocks match")).toBeInTheDocument();
      expect(screen.getByTestId("zone-help")).toHaveTextContent(/zone scan could not be loaded/);
    });

    it("explains the tiers in the legend", async () => {
      withZones();
      renderAt("/scan");
      await screen.findByTestId("oi-list");
      expect(screen.getByText(/Tier A: a weekly zone of the same kind is also at price/)).toBeInTheDocument();
    });
  });

  describe("the five-day history", () => {
    const withHistory = () => {
      oi = {
        snapshot_date: "2026-09-25",
        rows: [
          oiRow("HISTORIC", {
            history: [
              { snapshot_date: "2026-09-18", total_call_oi: 1000, total_put_oi: 1000, spot_price: 100 },
              { snapshot_date: "2026-09-19", total_call_oi: 1100, total_put_oi: 900, spot_price: 102 },
              { snapshot_date: "2026-09-22", total_call_oi: 1210, total_put_oi: 990, spot_price: 101 },
              { snapshot_date: "2026-09-23", total_call_oi: 1089, total_put_oi: 1089, spot_price: 103 },
              { snapshot_date: "2026-09-24", total_call_oi: 1200, total_put_oi: 1100, spot_price: 104 },
              { snapshot_date: "2026-09-25", total_call_oi: 1300, total_put_oi: 1200, spot_price: 105 },
            ],
          }),
          oiRow("NEWCOMER", { history: [{ snapshot_date: "2026-09-25", total_call_oi: 1300, total_put_oi: 1200, spot_price: 105 }] }),
        ],
      };
    };

    it("opens a table of the last five days, newest first, with a badge per side", async () => {
      withHistory();
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const card = within(within(list).getAllByTestId("oi-card")[0]);
      expect(card.queryByTestId("oi-history")).not.toBeInTheDocument();
      await user.click(card.getByRole("button", { name: "History" }));
      const table = card.getByTestId("oi-history");
      const rows = within(table).getAllByRole("row").slice(1);
      expect(rows).toHaveLength(5);
      expect(rows[0]).toHaveTextContent("25 Sept"); // newest first
      expect(rows[0]).toHaveTextContent("+8.3%"); // call 1200 -> 1300
      expect(rows[0]).toHaveTextContent("+9.1%"); // put 1100 -> 1200
      expect(rows[0]).toHaveTextContent("Buying"); // price up, call OI up
      expect(rows[4]).toHaveTextContent("19 Sept");
      expect(within(table).getByText(/Since 18 Sept/)).toBeInTheDocument();
      await user.click(card.getByRole("button", { name: "Close history" }));
      expect(card.queryByTestId("oi-history")).not.toBeInTheDocument();
    });

    it("says so when a stock has only one stored day, instead of an empty table", async () => {
      withHistory();
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const cards = within(list).getAllByTestId("oi-card");
      const card = within(cards[1]);
      expect(cards[1]).toHaveTextContent("NEWCOMER");
      await user.click(card.getByRole("button", { name: "History" }));
      expect(card.getByTestId("oi-history")).toHaveTextContent(/Not enough history yet/);
      expect(card.queryByRole("table")).not.toBeInTheDocument();
    });

    it("is independent of the chart and trade toggles on the same card", async () => {
      withHistory();
      const user = userEvent.setup();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const card = within(within(list).getAllByTestId("oi-card")[0]);
      await user.click(card.getByRole("button", { name: "History" }));
      await user.click(card.getByRole("button", { name: "Chart" }));
      expect(card.getByTestId("oi-history")).toBeInTheDocument();
      expect(card.getByRole("button", { name: "Close chart" })).toBeInTheDocument();
    });
  });

  describe("the four price-against-OI boxes", () => {
    const quadrants = () => {
      const base = { total_call_oi: 1000, total_put_oi: 1000 };
      oi = {
        snapshot_date: "2026-09-25",
        rows: [
          oiRow("BIGLONG", { ...base, price_change_pct: 2, call_oi_change_pct: 40, put_oi_change_pct: 40 }),
          oiRow("SMALLLONG", { ...base, price_change_pct: 1, call_oi_change_pct: 8, put_oi_change_pct: 8 }),
          oiRow("COVERING", { ...base, price_change_pct: 1.5, call_oi_change_pct: -20, put_oi_change_pct: -20 }),
          oiRow("SHORTING", { ...base, price_change_pct: -2, call_oi_change_pct: 15, put_oi_change_pct: 15 }),
          oiRow("UNWINDING", { ...base, price_change_pct: -1, call_oi_change_pct: -10, put_oi_change_pct: -10 }),
          oiRow("NOISE", { ...base, price_change_pct: 0.1, call_oi_change_pct: 50, put_oi_change_pct: 50 }),
        ],
      };
    };
    const chip = (name: string) => within(screen.getByRole("group", { name: "Signal" })).getByRole("button", { name });

    it("has a chip per box that filters to it, biggest total OI change first, with the rule spelled out", async () => {
      quadrants();
      const user = userEvent.setup();
      renderAt("/scan");
      await screen.findByTestId("oi-list");
      await user.click(chip("Long buildup"));
      const cards = within(screen.getByTestId("oi-list")).getAllByTestId("oi-card");
      expect(cards.map((c) => c.textContent?.match(/BIGLONG|SMALLLONG/)?.[0])).toEqual(["BIGLONG", "SMALLLONG"]);
      expect(screen.getByLabelText("Sort by")).toHaveValue("oi_total");
      expect(screen.getByTestId("oi-signal-help")).toHaveTextContent(/at least 0\.5% and total open interest .* at least 5%/);
      await user.click(chip("Short covering"));
      expect(within(screen.getByTestId("oi-list")).getAllByTestId("oi-card")).toHaveLength(1);
      await user.click(chip("Short buildup"));
      expect(within(screen.getByTestId("oi-list")).getByTestId("oi-card")).toHaveTextContent("SHORTING");
      await user.click(chip("Long unwinding"));
      expect(within(screen.getByTestId("oi-list")).getByTestId("oi-card")).toHaveTextContent("UNWINDING");
    });

    it("badges a stock with its box and total OI change, and leaves a noisy day unbadged", async () => {
      quadrants();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const badges = within(list).getAllByTestId("oi-quadrant-badge").map((b) => b.textContent);
      expect(badges).toContain("Long buildup · OI +40.0%");
      expect(badges).toContain("Short covering · OI −20.0%");
      expect(badges).toHaveLength(5); // NOISE (price moved 0.1%) has none
    });
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
    const signal = (name: string) => within(screen.getByRole("group", { name: "Signal" })).getByRole("button", { name: new RegExp(`^(★ )?${name}$`) });

    it("badges a stock with a major shift in the all-stocks list, using the 10% default", async () => {
      shifted();
      renderAt("/scan");
      const list = await screen.findByTestId("oi-list");
      const badges = within(list).getAllByTestId("oi-signal-badge").map((b) => b.textContent);
      expect(badges.sort()).toEqual(["★ Strong bearish", "★ Strong bullish", "★ Strong bullish"]); // TINY (under 10%) has none
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
      // The card's trade icon goes straight to the Trade page (weekly | daily side by side), in a new tab so the scan stays where it is.
      const trade = tcs.getByRole("link", { name: "Trade" });
      expect(trade).toHaveAttribute("href", expect.stringMatching(/^\/trade\?symbol=TCS&segment=NSE&layout=side&intervals=weekly,daily&form=credit&view=(BUY|SELL)$/));
      expect(trade).toHaveAttribute("target", "_blank");
      expect(trade).toHaveAttribute("rel", expect.stringContaining("noopener"));
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
});

describe("Screener universe, liquidity and relative strength", () => {
  const swingRow = (symbol: string, over: object = {}) =>
    scrRow(symbol, { universes: ["NIFTY500", "NIFTYMIDCAP150"], is_fno: false, avg_turnover_cr: 42.5, ret_3m_pct: 9.4, mom_12_1_pct: 31, rsi3: 18, dist_ema20_pct: -3.2, atr_pct: 2.4, vol_ratio: 1.2, rs_3m_pctile: 70, rs_12m_pctile: 88, ...over });
  const cardNames = () => within(screen.getByTestId("screener-list")).getAllByTestId("screener-card").map((c) => /^[A-Z]+/.exec(c.textContent ?? "")![0]);

  beforeEach(() => {
    scr = {
      snapshot_date: "2026-10-08",
      rows: [
        swingRow("MIDCO"),
        swingRow("LARGECO", { universes: ["NIFTY500", "NIFTY100"], avg_turnover_cr: 900, rs_12m_pctile: 95 }),
        swingRow("THINCO", { universes: ["NIFTY500", "NIFTYSMALLCAP250"], avg_turnover_cr: 1.2, rs_12m_pctile: null }),
        swingRow("MICRO", { universes: [], avg_turnover_cr: 30, rs_12m_pctile: 60 }),
      ],
    };
  });

  it("opens on the Nifty 500, liquid only, with a count on each universe chip, and shows the extra line on a card", async () => {
    renderAt("/scan?tab=screener");
    await screen.findByTestId("screener-list");
    expect(screen.getByRole("button", { name: /^Nifty 500 \(2\)$/, pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Liquid only/ })).toBeChecked();
    expect(cardNames().sort()).toEqual(["LARGECO", "MIDCO"]); // THINCO is under Rs 5 Cr a day, MICRO is outside the index
    const card = within(screen.getAllByTestId("screener-card").find((c) => c.textContent?.includes("MIDCO"))!);
    expect(card.getByTestId("size-badge")).toHaveTextContent("Mid");
    const line = card.getByTestId("swing-line");
    expect(line).toHaveTextContent("₹42.5 Cr/day");
    expect(line).toHaveTextContent("RS 88");
    expect(line).toHaveTextContent("12-1m +31%");
    expect(line).toHaveTextContent("−3.2% vs 20-day EMA");
    expect(line).toHaveTextContent("RSI(3) 18");
  });

  it("switching the universe or turning liquidity off changes the list, and the outside-Nifty-500 chip finds the rest", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=screener");
    await screen.findByTestId("screener-list");
    await user.click(screen.getByRole("button", { name: /^Large/ }));
    expect(cardNames()).toEqual(["LARGECO"]);
    await user.click(screen.getByRole("button", { name: /^Outside Nifty 500/ }));
    expect(cardNames()).toEqual(["MICRO"]);
    await user.click(screen.getByRole("button", { name: /^All stocks/ }));
    await user.click(screen.getByRole("checkbox", { name: /Liquid only/ }));
    expect(cardNames()).toHaveLength(4);
  });

  it("the relative-strength cut keeps the strongest and sorts by that rank", async () => {
    const user = userEvent.setup();
    renderAt("/scan?tab=screener");
    await screen.findByTestId("screener-list");
    await user.selectOptions(screen.getByLabelText("Relative strength (12-1 month)"), "10");
    expect(cardNames()).toEqual(["LARGECO"]);
    await user.selectOptions(screen.getByLabelText("Relative strength (12-1 month)"), "40");
    expect(cardNames()).toEqual(["LARGECO", "MIDCO"]); // best rank first
    expect(screen.getByLabelText("Sort by")).toHaveValue("rs");
  });

  it("says plainly that none of it is a signal, and explains the numbers", async () => {
    renderAt("/scan?tab=screener");
    await screen.findByTestId("screener-list");
    expect(screen.getByText("About these numbers")).toBeInTheDocument();
    expect(screen.getByText(/found no reliable edge after costs/)).toBeInTheDocument();
  });

  it("before tonight's run has filled in traded value, the liquidity filter says so and hides nothing", async () => {
    scr = { snapshot_date: "2026-10-08", rows: [scrRow("OLDA"), scrRow("OLDB")] };
    renderAt("/scan?tab=screener");
    await screen.findByTestId("screener-list");
    expect(await screen.findByTestId("liquidity-pending")).toBeInTheDocument();
    expect(cardNames()).toEqual(["OLDA", "OLDB"]);
    expect(screen.queryByTestId("swing-line")).not.toBeInTheDocument();
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
    expect(sbin.getByRole("link", { name: "Trade" })).toHaveAttribute("href", "/trade?symbol=SBIN&segment=NSE&layout=side&intervals=weekly,daily");
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


describe("Scan: what you already have on a stock", () => {
  const openSpot = (symbol: string) => ({ id: `p-${symbol}`, symbol, exchange: "NSE", segment: "NSE", action: "BUY", instrument_type: "spot", status: "OPEN", option_group_id: null });
  const openGroup = (symbol: string) => ({ id: `g-${symbol}`, underlying_symbol: symbol, segment: "NSE", strategy_type: "bear_call_spread", status: "OPEN" });
  const waiting = (symbol: string) => ({ id: `w-${symbol}`, symbol, segment: "NSE", action: "BUY", strategy: "spread", status: "pending", trigger_price: 100 });

  it("marks a result that has an open trade or a waiting order", async () => {
    openPositionsFor[""] = [openSpot("RELIANCE")];
    waitingOrders = [waiting("TCS")];
    renderAt("/scan");
    const cards = within(await screen.findByTestId("oi-list")).getAllByTestId("oi-card");
    const tcs = within(cards[0]); // biggest call-OI change first
    const reliance = within(cards[1]);
    expect(await tcs.findByTestId("trade-waiting-badge")).toHaveTextContent("Waiting order");
    expect(tcs.queryByTestId("trade-open-badge")).not.toBeInTheDocument();
    expect(await reliance.findByTestId("trade-open-badge")).toHaveTextContent("Open trade");
  });

  it("counts an option group by its underlying, and an option leg only through its group", async () => {
    openGroupsFor[""] = [openGroup("TCS")];
    openPositionsFor[""] = [{ ...openSpot("TCS-OPT-LEG"), option_group_id: "g-TCS" }];
    renderAt("/scan");
    const tcs = within(within(await screen.findByTestId("oi-list")).getAllByTestId("oi-card")[0]);
    expect(await tcs.findByTestId("trade-open-badge")).toHaveTextContent(/^Open trade$/); // one, not two
  });

  it("filters to stocks with no open or waiting trade, with an open one, or with a waiting one", async () => {
    const user = userEvent.setup();
    openPositionsFor[""] = [openSpot("RELIANCE")];
    waitingOrders = [waiting("TCS")];
    renderAt("/scan");
    await screen.findByTestId("oi-list");
    await screen.findAllByTestId("trade-status");
    const filter = screen.getByLabelText("My trades");
    await user.selectOptions(filter, "none");
    expect(await screen.findByText("No stocks match")).toBeInTheDocument(); // both stocks have something on them
    await user.selectOptions(filter, "open");
    const open = within(await screen.findByTestId("oi-list"));
    expect(open.getAllByTestId("oi-card")).toHaveLength(1);
    expect(open.getByText("RELIANCE")).toBeInTheDocument();
    await user.selectOptions(filter, "waiting");
    const wait = within(screen.getByTestId("oi-list"));
    expect(wait.getAllByTestId("oi-card")).toHaveLength(1);
    expect(wait.getByText("TCS")).toBeInTheDocument();
  });

  it("has the same marker and filter on the Screener tab, and no inline order form anywhere", async () => {
    openPositionsFor[""] = [openSpot("SBIN")];
    renderAt("/scan?tab=screener");
    const list = await screen.findByTestId("screener-list");
    expect(await within(list).findByTestId("trade-open-badge")).toBeInTheDocument();
    expect(screen.getByLabelText("My trades")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trade" })).not.toBeInTheDocument(); // the trade icon is a link now
    expect(screen.queryByTestId("ticket")).not.toBeInTheDocument();
  });
});

describe("option wording on the call and put sides", () => {
  it("reads a put whose OI grew as the stock rose as writing, not as a long", async () => {
    oi = { snapshot_date: "2026-09-25", rows: [oiRow("CANBK", { call_buildup: "long_buildup", put_buildup: "long_buildup", call_oi_change_pct: 32.7, put_oi_change_pct: 28.7, price_change_pct: 3.59 })] };
    renderAt("/scan");
    const card = within((await screen.findAllByTestId("oi-card"))[0]);
    expect(card.getByText("Buying")).toBeInTheDocument(); // the call side
    expect(card.getByText("Writing")).toBeInTheDocument(); // the put side
    expect(card.queryByText("Long buildup")).not.toBeInTheDocument();
  });
});

describe("measured against worked-out readings", () => {
  it("shows what the option's own price said when it was recorded, and marks a worked-out day with a *", async () => {
    oi = {
      snapshot_date: "2026-09-25",
      rows: [
        oiRow("MEASURED", { call_buildup: "long_buildup", call_activity: "writing", put_buildup: "long_buildup", put_activity: "buying" }),
        oiRow("WORKED", { call_buildup: "long_buildup", put_buildup: "long_buildup" }),
      ],
    };
    renderAt("/scan");
    const cards = await screen.findAllByTestId("oi-card");
    const measured = within(cards.find((c) => within(c).queryByText("MEASURED")) as HTMLElement);
    expect(measured.getByText("Writing")).toBeInTheDocument(); // the call side, from the call's own price, not the stock's
    expect(measured.getByText("Buying")).toBeInTheDocument(); // the put side
    expect(measured.queryByText("*")).not.toBeInTheDocument();
    const worked = within(cards.find((c) => within(c).queryByText("WORKED")) as HTMLElement);
    expect(worked.getAllByText("*")).toHaveLength(2);
  });
});
