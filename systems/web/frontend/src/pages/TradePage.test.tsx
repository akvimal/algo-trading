import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AuthProvider } from "../auth/AuthContext";
import { setToken } from "../auth/token";
import { FakeChart } from "../test/fakeKlinecharts";
import { FakeWebSocket } from "../test/fakeSocket";

function jwt(claims: object): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { url: string; method: string; body: any };
let calls: Call[];
let account: Record<string, any>;
let regimes: Record<string, Record<string, any>>;
let prices: Record<string, number>;
let placeManual: (body: any) => Response;
let placeOption: (body: any) => Response;
let waiting: Record<string, any>[];
let lotSize: number;
let attachFails: boolean;
let candleFailures: number;
let structure: Record<string, any>;
let structureFails: boolean;
let ltpFails: boolean;
let positionRows: Record<string, any>[];
let groupRows: Record<string, any>[];
let tradeCallsFail: boolean;
let oiFails: boolean;
let oiSummaryPcr: number | null;
let oiBuildups: { call: string | null; put: string | null } | null;
let sentHistPoints: any[];
let levelFails: string | null;
// Unset (null) for most tests - /auth/me then falls through to the generic 404 below, same as
// before this existed; OnboardingGate opens the app anyway on a failed profile read, and the
// ticket's defaults (future/naked) match what an unset preference already produced.
let profilePrefs: { default_instrument: "future" | "option"; default_option_strategy: "naked" | "spread" } | null;

// The newest candle is the one being formed right now, as during market hours, so a price tick lands on it (and never starts a new bar, whatever minute of the quarter hour the test runs in).
const candlesFor = (symbol: string) => {
  const step = 15 * 60_000;
  const newest = Math.floor(Date.now() / step) * step;
  return Array.from({ length: 30 }, (_, i) => ({
    exchange: "NSE", symbol, interval: "15min", open: 1000 + i, high: 1005 + i, low: 995 + i, close: 1002 + i, volume: 1,
    timestamp: new Date(newest - (29 - i) * step).toISOString(), provider: "dhan",
  }));
};

const emptyStructure = { order_blocks: [], fvgs: [], trend: "up", events: [], trend_changes: [], setups: [] };

/** A screen wide enough for the workstation (tool strip, side-by-side charts), or a phone. */
function screenIs(wide: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: wide && q.includes("min-width"), media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

beforeEach(() => {
  calls = [];
  lotSize = 1;
  attachFails = false;
  candleFailures = 0;
  structureFails = false;
  ltpFails = false;
  positionRows = [];
  groupRows = [];
  tradeCallsFail = false;
  oiFails = false;
  oiSummaryPcr = 1;
  oiBuildups = null;
  sentHistPoints = [];
  levelFails = null;
  profilePrefs = null;
  structure = { ...emptyStructure };
  waiting = [];
  screenIs(false);
  account = {
    segment: "NSE", starting_balance: 200000, current_balance: 200000, realized_pnl: 0, unrealized_pnl: 0, capital_per_trade: 100000,
    max_daily_loss: null, live_trading_enabled: false, apply_charges: false, require_stop_loss: false, square_off_time: null,
    risk_per_trade_pct: 1, min_reward_risk_ratio: 2, enforce_risk_based_lots: false, slippage_bps: 0, max_order_value: null, live_trading_consent_at: null,
  };
  const up = { regime: "trending_up", adx: 30, atr_percentile: 40, trend: "up", advice: "x" };
  regimes = { default: up };
  prices = { default: 1000 };
  placeManual = () => json({ id: "p1", status: "OPEN" });
  placeOption = () => json({ id: "g1", status: "OPEN" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      const q = (name: string) => new URL(url).searchParams.get(name) ?? "";
      if (url.includes("/instruments/resolve")) {
        const u = q("underlying");
        return json({ chart_symbol: u, chart_exchange: "NSE", trade_symbol: u, trade_exchange: "NSE", lot_size: lotSize, expiry: null });
      }
      if (url.includes("/quotes/ltp") && ltpFails) return json({ detail: "no quote" }, 503);
      if (url.includes("/quotes/ltp")) return json({ exchange: "NSE", symbol: q("symbol"), ltp: prices[q("symbol")] ?? prices.default, provider: "dhan" });
      if (url.includes("/candles/history")) {
        if (candleFailures > 0) {
          candleFailures -= 1;
          return json({ detail: "Dhan candle queue is backed up (6.0s wait) - try again shortly" }, 503);
        }
        return json(candlesFor(q("symbol")));
      }
      if (url.includes("/order-blocks")) {
        if (structureFails) return json({ detail: "boom" }, 500);
        // Like the real server: gaps, breakers and setups only when asked for.
        return json({
          ...structure,
          fvgs: q("fvg") === "true" ? structure.fvgs : [],
          setups: q("setups") === "true" ? structure.setups : [],
          order_blocks: (structure.order_blocks as any[]).filter((z) => z.role === "orderblock" || q("breakers") === "true"),
        });
      }
      if (url.includes("/options/expiries")) return json({ expiries: ["2026-09-29", "2026-10-06"] });
      if (url.includes("/options/sentiment-history")) return json({ exchange: "NSE", session_start: "09:15", session_end: "15:30", points: sentHistPoints });
      if (url.includes("/options/oi-summary")) {
        if (oiFails) return json({ detail: "chain unavailable" }, 502);
        const leg = (oi: number, c: number | null = null, vol = 0) => ({ oi, oi_change_5m: null, oi_change_15m: c, volume: vol });
        return json({
          underlying_symbol: q("symbol"), underlying_exchange: "NSE", expiry: q("expiry"), underlying_last_price: 1000, total_call_oi: 1, total_put_oi: 1, pcr: oiSummaryPcr,
          total_call_oi_change_5m: null, total_put_oi_change_5m: null, total_call_oi_change_15m: null, total_put_oi_change_15m: null,
          total_call_buildup: oiBuildups?.call ?? null, total_put_buildup: oiBuildups?.put ?? null,
          strikes: [
            { strike: 960, call: null, put: leg(9_000_000) },
            { strike: 980, call: null, put: leg(4_000_000) },
            { strike: 990, call: null, put: leg(500_000, 300_000) },
            { strike: 1020, call: leg(8_000_000), put: null },
            { strike: 1040, call: leg(2_000_000, 100_000), put: null },
          ],
        });
      }
      // signal-engine: the auto-trader looks for its strategy (there is none unless a test says so)
      if (url.includes("/indicators") || url.includes("/rules") || url.includes("/strategies?")) return json([]);
      if (url.includes("/regime")) return json(regimes[q("symbol")] ?? regimes.default);
      if (url.endsWith("/accounts")) return json([account]);
      if (url.includes("/study-notes") && method === "POST") return json({ id: "note1", segment: body.segment, symbol: body.symbol, interval: body.interval, text: body.text, tag: body.tag ?? null, context: body.context ?? null, position_id: null, option_group_id: null, has_snapshot: false, created_at: new Date().toISOString() }, 201);
      if (url.includes("/study-notes")) return json([]);
      if (url.includes("/pending-orders") && method === "POST")
        return json({ id: "w1", segment: "NSE", symbol: body.symbol, action: body.action, strategy: body.strategy, trigger_price: body.trigger_price, stop_loss_price: body.stop_loss_price ?? null, target_price: body.target_price ?? null, status: "pending", status_reason: null, expires_at: "2026-09-27T00:00:00Z", last_price: null }, 201);
      if (url.includes("/pending-orders") && method === "DELETE") {
        waiting = [];
        return json({ id: "w1", status: "cancelled" });
      }
      if (url.includes("/pending-orders")) return json(waiting);
      if (url.endsWith("/positions/manual")) return placeManual(body);
      if (url.endsWith("/option-groups/manual")) return placeOption(body);
      if (url.includes("/spot-stop-loss") || url.includes("/spot-target")) return attachFails ? json({ detail: "no" }, 409) : json({ ok: true });
      // moving the stop or target of an open trade
      const moved = /\/(positions|option-groups)\/([^/?]+)\/(stop-loss|target|spot-stop-loss|spot-target)/.exec(url);
      if (method === "PUT" && moved) {
        if (levelFails) return json({ detail: levelFails }, 422);
        const row = (moved[1] === "positions" ? positionRows : groupRows).find((r) => r.id === moved[2]);
        if (row) {
          const field = { "stop-loss": "stop_loss_price", target: "target_price", "spot-stop-loss": "spot_stop_loss_price", "spot-target": "spot_target_price" }[moved[3]]!;
          row[field] = Object.values(body)[0];
        }
        return json(row ?? {});
      }
      if (url.includes("/positions") || url.includes("/option-groups")) {
        if (tradeCallsFail && q("with_live_pnl") === "true") return json({ detail: "quotes down" }, 503);
        const rows = url.includes("/positions") ? positionRows : groupRows;
        return json(rows.filter((r) => (!q("status") || r.status === q("status")) && (!q("segment") || (r.segment ?? "NSE") === q("segment"))));
      }
      if (url.endsWith("/auth/me") && profilePrefs) {
        return json({
          id: "u1", email: "me@x.com", name: "Me", is_admin: false, experience: "guided", onboarded_at: "2026-09-01T00:00:00Z",
          markets: ["NSE", "MCX", "CRYPTO"], default_instrument: profilePrefs.default_instrument, default_option_strategy: profilePrefs.default_option_strategy,
        });
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
const posts = (part: string) => calls.filter((c) => c.method === "POST" && c.url.includes(part));
const puts = (part: string) => calls.filter((c) => c.method === "PUT" && c.url.includes(part));
const chart = (i = 0) => FakeChart.instances[i];
const loaded = async (i = 0) => {
  await waitFor(() => expect(chart(i)).toBeDefined());
  await waitFor(() => expect(chart(i).data.length).toBeGreaterThan(0));
  return chart(i);
};

async function ticket() {
  // The live price arrives after the account; a ticket used before it would (rightly) refuse to place.
  await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
  return within(await screen.findByTestId("ticket"));
}

describe("the page", () => {
  it("shows the price, a chart holding the candles with a written summary, and the guided ticket", async () => {
    renderAt("/trade?symbol=RELIANCE&segment=NSE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    const c = await loaded();
    expect(c.data).toHaveLength(30);
    expect(c.precision).toEqual([2, 0]);
    expect(screen.getByTestId("chart-summary")).toHaveTextContent("RELIANCE, 15m candles. Last price 1,000.");
    const t = await ticket();
    expect(t.getByText("Paper order")).toBeInTheDocument();
    expect(t.getByText("Before you place")).toBeInTheDocument();
    expect(t.getByLabelText("Number of shares")).toBeInTheDocument(); // a stock: shares, not lots
    expect(t.queryByRole("button", { name: "Option" })).not.toBeInTheDocument(); // no options on a stock
  });

  it("shows today's realized and unrealized result for the account, in the ticket", async () => {
    positionRows = [
      { id: "closed", symbol: "TCS", segment: "NSE", action: "BUY", instrument_type: "spot", quantity: 5, entry_price: 3000, entry_time: new Date().toISOString(), exit_time: new Date().toISOString(), status: "CLOSED", pnl: 500, option_group_id: null },
      { id: "open", symbol: "INFY", segment: "NSE", action: "BUY", instrument_type: "spot", quantity: 10, entry_price: 1500, entry_time: new Date().toISOString(), status: "OPEN", unrealized_pnl: -120, option_group_id: null },
    ];
    renderAt("/trade?symbol=RELIANCE&segment=NSE");
    const p = await screen.findByTestId("ws-today-pnl");
    expect(p).toHaveTextContent("Today on NSE:");
    expect(p).toHaveTextContent("+₹380"); // 500 realized − 120 open
    expect(p).toHaveTextContent("+₹500 booked from 1 closed, −₹120 open");
  });

  it("offers futures and options on an index, in lots", async () => {
    lotSize = 65;
    renderAt("/trade?symbol=NIFTY");
    const t = await ticket();
    expect(await t.findByLabelText("Number of lots")).toBeInTheDocument();
    expect(t.getByRole("button", { name: "Option spread" })).toBeInTheDocument();
  });

  it("starts the ticket on Future without a saved preference, same as before preferences existed", async () => {
    renderAt("/trade?symbol=NIFTY");
    const t = await ticket();
    expect(t.getByRole("button", { name: "Future" })).toHaveAttribute("aria-pressed", "true");
  });

  it("starts the ticket on the person's preferred option style, on a symbol that has options", async () => {
    profilePrefs = { default_instrument: "option", default_option_strategy: "spread" };
    renderAt("/trade?symbol=NIFTY");
    const t = await ticket();
    await waitFor(() => expect(t.getByRole("button", { name: "Option spread" })).toHaveAttribute("aria-pressed", "true"));
    expect(t.getByRole("button", { name: "Future" })).toHaveAttribute("aria-pressed", "false");
    expect(t.getByLabelText("Strike")).toBeInTheDocument(); // the option-only strike field follows
  });

  it("falls back to Future for an Option preference on a stock - there is nothing to pick naked/spread of", async () => {
    profilePrefs = { default_instrument: "option", default_option_strategy: "naked" };
    renderAt("/trade?symbol=RELIANCE&segment=NSE");
    const t = await ticket();
    expect(t.queryByRole("button", { name: "Option" })).not.toBeInTheDocument();
  });

  it("goes back to the preferred instrument, not a bare Future, after placing an order", async () => {
    profilePrefs = { default_instrument: "option", default_option_strategy: "naked" };
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    let t = await ticket();
    await waitFor(() => expect(t.getByRole("button", { name: "Option" })).toHaveAttribute("aria-pressed", "true"));
    await user.type(t.getByLabelText("Stop-loss"), "900");
    await user.click(t.getByRole("button", { name: /Buy NIFTY, paper order/ }));
    await waitFor(() => expect(posts("/option-groups/manual")).toHaveLength(1));
    t = within(await screen.findByTestId("ticket"));
    expect(t.getByRole("button", { name: "Option" })).toHaveAttribute("aria-pressed", "true");
  });

  it("marks the plan on the chart and shows the risk in rupees as you type", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    const c = await loaded();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.type(t.getByLabelText("Target"), "1030");
    const summary = within(t.getByTestId("summary"));
    expect(summary.getByText("100 (auto)")).toBeInTheDocument();
    expect(summary.getByText("₹1,000")).toBeInTheDocument(); // risk
    expect(summary.getByText("₹3,000")).toBeInTheDocument(); // reward
    expect(summary.getByText("3.0 : 1")).toBeInTheDocument();
    await waitFor(() => expect(c.overlaysNamed("planLine").map((o) => [o.extendData.label, o.points[0].value]).sort()).toEqual([["Stop", 990], ["Target", 1030]]));
    expect(screen.getByTestId("chart-summary")).toHaveTextContent(/Marked levels: Stop 990, Target 1,030/);
  });

  it("scores the setup: with the trend is in favour, against it is not", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.type(t.getByLabelText("Target"), "1030");
    const checks = within(await t.findByTestId("checks"));
    await waitFor(() => expect(checks.getByText("Regime: trending up")).toBeInTheDocument());
    expect(checks.getByText(/4 of 4 in favour/)).toBeInTheDocument();
    await user.click(t.getByRole("button", { name: "Sell" }));
    await user.clear(t.getByLabelText("Stop-loss"));
    await user.clear(t.getByLabelText("Target"));
    await user.type(t.getByLabelText("Stop-loss"), "1010");
    await user.type(t.getByLabelText("Target"), "970");
    expect(await checks.findByText("You are trading against the trend.")).toBeInTheDocument();
    expect(checks.getByRole("img", { name: "Against" })).toBeInTheDocument();
  });
});

describe("placing", () => {
  it("places a market order at the live price, sized by the server from the stop, and links to Portfolio", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.type(t.getByLabelText("Target"), "1030");
    await user.selectOptions(t.getByLabelText(/Why this trade/), "Breakout");
    await user.type(t.getByLabelText(/Reason/), "Retested the daily OB and held.");
    await user.click(t.getByRole("button", { name: "4" }));
    await user.click(t.getByRole("button", { name: /Buy RELIANCE, paper order/ }));
    await waitFor(() => expect(posts("/positions/manual")).toHaveLength(1));
    expect(posts("/positions/manual")[0].body).toMatchObject({
      segment: "NSE", symbol: "RELIANCE", action: "BUY", instrument_type: "spot", price: 1000, order_type: "market",
      stop_loss_price: 990, target_price: 1030, setup_tag: "Breakout", confidence: 4, risk_managed: true, trend_followed: true, entry_interval: "15min",
      notes: "Retested the daily OB and held.",
    });
    expect("quantity" in posts("/positions/manual")[0].body).toBe(false);
    expect(await t.findByText("Paper order placed.")).toBeInTheDocument();
    expect(t.getByRole("link", { name: "See it in Portfolio" })).toHaveAttribute("href", "/portfolio?tab=positions");
  });

  it("clears the draft's plan lines off the chart once the order is placed", async () => {
    // Otherwise the chart kept showing the just-placed stop/target forever - the ticket draft
    // that drives those lines was never reset by a successful placement, only by switching
    // symbol/segment.
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.type(t.getByLabelText("Target"), "1030");
    expect(screen.getByTestId("chart-summary")).toHaveTextContent(/Marked levels: Stop 990, Target 1,030/);
    await user.click(t.getByRole("button", { name: /Buy RELIANCE, paper order/ }));
    await waitFor(() => expect(posts("/positions/manual")).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("chart-summary")).not.toHaveTextContent(/Marked levels/));
  });

  it("shows the resulting position in the same ticket once it is placed, with its stop editable right there", async () => {
    // A real server persists the new row - the mock does the same, so the ticket's own reload (onPlaced)
    // picks it up from the next GET /positions, same as the real app.
    placeManual = (body) => {
      const row = { id: "p1", symbol: body.symbol, segment: "NSE", action: body.action, instrument_type: "spot", quantity: 10, entry_price: 1000, entry_time: new Date().toISOString(), status: "OPEN", stop_loss_price: body.stop_loss_price ?? null, target_price: body.target_price ?? null, option_group_id: null, unrealized_pnl: 0 };
      positionRows.push(row);
      return json(row);
    };
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.click(t.getByRole("button", { name: /Buy RELIANCE, paper order/ }));
    await waitFor(() => expect(posts("/positions/manual")).toHaveLength(1));

    const list = within(await screen.findByTestId("ticket-positions"));
    expect(list.getByText("RELIANCE")).toBeInTheDocument();
    expect(list.getByRole("button", { name: "Edit sl" })).toHaveTextContent("SL 990");

    // ...and its stop can be moved right there, without leaving the ticket.
    await user.click(list.getByRole("button", { name: "Edit sl" }));
    await user.clear(list.getByLabelText("SL"));
    await user.type(list.getByLabelText("SL"), "985");
    await user.click(list.getByRole("button", { name: "Save sl" }));
    await waitFor(() => expect(puts("/positions/p1/stop-loss")).toHaveLength(1));
    expect(puts("/positions/p1/stop-loss")[0].body).toEqual({ stop_loss_price: 985 });
  });

  it("fetches positions for the ticket even with 'My trades' off on the chart", async () => {
    localStorage.setItem("web.chart.tools", JSON.stringify({ magnet: false, drawingsHidden: false, indicatorsHidden: false, tradesOn: false, oiLevelsOn: false }));
    positionRows = [{ id: "p1", symbol: "RELIANCE", segment: "NSE", action: "BUY", instrument_type: "spot", quantity: 10, entry_price: 1000, entry_time: new Date().toISOString(), status: "OPEN", stop_loss_price: 990, target_price: null, option_group_id: null, unrealized_pnl: 0 }];
    renderAt("/trade?symbol=RELIANCE");
    // The order form is hidden with a position already open (see below), so this waits directly
    // rather than through the ticket() helper, which expects the form itself to be present.
    const list = within(await screen.findByTestId("ticket-positions"));
    expect(list.getByText("RELIANCE")).toBeInTheDocument();
  });

  it("says nothing about open positions when there are none for this instrument", async () => {
    renderAt("/trade?symbol=RELIANCE");
    await ticket();
    expect(screen.queryByTestId("ticket-positions")).not.toBeInTheDocument();
    expect(screen.queryByText("Open positions")).not.toBeInTheDocument();
  });

  it("lists only the active instrument's own positions, not another symbol's", async () => {
    positionRows = [{ id: "other", symbol: "TCS", segment: "NSE", action: "BUY", instrument_type: "spot", quantity: 5, entry_price: 4000, entry_time: new Date().toISOString(), status: "OPEN", stop_loss_price: null, target_price: null, option_group_id: null, unrealized_pnl: 10 }];
    renderAt("/trade?symbol=RELIANCE");
    await ticket();
    await waitFor(() => expect(calls.some((c) => c.url.includes("/positions?segment=NSE"))).toBe(true));
    expect(screen.queryByTestId("ticket-positions")).not.toBeInTheDocument();
  });

  it("hides the order form once something is open on this instrument, showing only the position", async () => {
    positionRows = [{ id: "p1", symbol: "RELIANCE", segment: "NSE", action: "BUY", instrument_type: "spot", quantity: 10, entry_price: 1000, entry_time: new Date().toISOString(), status: "OPEN", stop_loss_price: 990, target_price: null, option_group_id: null, unrealized_pnl: 0 }];
    renderAt("/trade?symbol=RELIANCE");
    await screen.findByTestId("ticket-positions");
    expect(screen.queryByTestId("ticket")).not.toBeInTheDocument();
  });

  it("'+ Place another order' brings the form back for a deliberate second entry, and resets on a symbol change", async () => {
    positionRows = [{ id: "p1", symbol: "RELIANCE", segment: "NSE", action: "BUY", instrument_type: "spot", quantity: 10, entry_price: 1000, entry_time: new Date().toISOString(), status: "OPEN", stop_loss_price: 990, target_price: null, option_group_id: null, unrealized_pnl: 0 }];
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    await screen.findByTestId("ticket-positions");
    await user.click(screen.getByRole("button", { name: "+ Place another order" }));
    expect(await screen.findByTestId("ticket")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-positions")).toBeInTheDocument(); // still shown too, not replaced

    await user.click(screen.getByRole("button", { name: "Bank Nifty" })); // BANKNIFTY has nothing open
    await waitFor(() => expect(screen.getByTestId("ticket")).toBeInTheDocument());
    expect(screen.queryByTestId("ticket-positions")).not.toBeInTheDocument();
  });


  describe("placing on top of something already open", () => {
    const held = () => [{ id: "p1", symbol: "RELIANCE", segment: "NSE", action: "BUY", instrument_type: "spot", quantity: 10, entry_price: 1000, entry_time: new Date().toISOString(), status: "OPEN", stop_loss_price: 990, target_price: null, option_group_id: null, unrealized_pnl: 0 }];

    it("warns that a market order would open a second position, and has no allow-adding switch for it", async () => {
      positionRows = held();
      const user = userEvent.setup();
      renderAt("/trade?symbol=RELIANCE");
      await screen.findByTestId("ticket-positions");
      await user.click(screen.getByRole("button", { name: "+ Place another order" }));
      const t = within(await screen.findByTestId("ticket"));
      expect(t.getByTestId("stacking-notice")).toHaveTextContent("You already hold 1 open RELIANCE position.");
      expect(t.getByTestId("stacking-notice")).toHaveTextContent("opens a second position on top of it");
      expect(t.queryByRole("checkbox", { name: /Allow adding/ })).not.toBeInTheDocument();
    });

    it("says a waiting order will be skipped, and sends allow_stacking only when the person ticks the box", async () => {
      positionRows = held();
      const user = userEvent.setup();
      renderAt("/trade?symbol=RELIANCE");
      await screen.findByTestId("ticket-positions");
      await user.click(screen.getByRole("button", { name: "+ Place another order" }));
      const t = within(await screen.findByTestId("ticket"));
      await user.click(t.getByRole("button", { name: "Wait for a price" }));
      expect(t.getByTestId("stacking-notice")).toHaveTextContent("will be skipped when its price is hit");
      const box = t.getByRole("checkbox", { name: /Allow adding to my open position/ });
      expect(box).not.toBeChecked();
      await user.type(t.getByLabelText("Enter when the price reaches"), "980");
      await user.type(t.getByLabelText("Stop-loss"), "970");
      await user.click(t.getByRole("button", { name: /Buy RELIANCE, wait for price/ }));
      await waitFor(() => expect(posts("/pending-orders")).toHaveLength(1));
      expect(posts("/pending-orders")[0].body.allow_stacking).toBe(false);

      await user.click(box);
      expect(box).toBeChecked();
    });

    it("sends allow_stacking true when ticked", async () => {
      positionRows = held();
      const user = userEvent.setup();
      renderAt("/trade?symbol=RELIANCE");
      await screen.findByTestId("ticket-positions");
      await user.click(screen.getByRole("button", { name: "+ Place another order" }));
      const t = within(await screen.findByTestId("ticket"));
      await user.click(t.getByRole("button", { name: "Wait for a price" }));
      await user.click(t.getByRole("checkbox", { name: /Allow adding to my open position/ }));
      await user.type(t.getByLabelText("Enter when the price reaches"), "980");
      await user.type(t.getByLabelText("Stop-loss"), "970");
      await user.click(t.getByRole("button", { name: /Buy RELIANCE, wait for price/ }));
      await waitFor(() => expect(posts("/pending-orders")).toHaveLength(1));
      expect(posts("/pending-orders")[0].body.allow_stacking).toBe(true);
    });

    it("shows no warning when nothing is open on the instrument", async () => {
      renderAt("/trade?symbol=RELIANCE");
      const t = await ticket();
      expect(t.queryByTestId("stacking-notice")).not.toBeInTheDocument();
    });
  });

  it("will not place without a stop-loss when the account requires one, and says why", async () => {
    account.require_stop_loss = true;
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    const button = t.getByRole("button", { name: /Buy RELIANCE/ });
    expect(button).toBeDisabled();
    expect(t.getByText(/require a stop-loss/)).toBeInTheDocument();
    await user.type(t.getByLabelText("Stop-loss (required)"), "990");
    expect(button).toBeEnabled();
  });

  it("blocks a stop on the wrong side before it reaches the server", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "1010");
    expect(t.getByText(/stop-loss must be below/)).toBeInTheDocument();
    expect(t.getByRole("button", { name: /Buy RELIANCE/ })).toBeDisabled();
    expect(posts("/positions/manual")).toHaveLength(0);
  });

  it("shows the server's reason when it rejects the order, and keeps the ticket", async () => {
    placeManual = () => json({ id: "p1", status: "REJECTED", rejection_reason: "insufficient account balance" });
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.click(t.getByRole("button", { name: /Buy RELIANCE/ }));
    expect(await t.findByRole("alert")).toHaveTextContent("insufficient account balance");
    expect(t.getByText("Not placed")).toBeInTheDocument();
    expect(t.getByLabelText("Stop-loss")).toHaveValue("990");
  });

  it("shows a request error (for example a 422) in words", async () => {
    placeManual = () => json({ detail: "stop_loss_price must be below entry" }, 422);
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.click(t.getByRole("button", { name: /Buy RELIANCE/ }));
    expect(await t.findByRole("alert")).toHaveTextContent("stop_loss_price must be below entry");
  });

  it("sends the size when typed by hand", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.type(t.getByLabelText("Number of shares"), "7");
    await user.click(t.getByRole("button", { name: /Buy RELIANCE/ }));
    await waitFor(() => expect(posts("/positions/manual")).toHaveLength(1));
    expect(posts("/positions/manual")[0].body).toMatchObject({ quantity: 7, risk_managed: false });
  });
});

/** Opens the layout dropdown and picks an arrangement by its name. */
async function pickLayout(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: /^(1×1|2×1|1×2)/ }));
  await user.click(within(screen.getByRole("group", { name: "Layout" })).getByRole("radio", { name: new RegExp(name) }));
}

describe("the layout dropdown", () => {
  beforeEach(() => screenIs(true));

  it("shows the current grid on its button, with the three arrangements listed when opened", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    const button = screen.getByRole("button", { name: /^(1×1|2×1|1×2)/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    const list = within(screen.getByRole("radiogroup", { name: "Chart layout" }));
    expect(list.getAllByRole("radio").map((r) => r.textContent)).toEqual(["1×1One chart", "2×1Side by side", "1×2Stacked"]);
    expect(list.getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });

  it("changes the layout, closes itself, and the button shows the new grid", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    await pickLayout(user, "Stacked");
    expect(document.querySelector(".ws-grid")!.className).toContain("layout-stack");
    expect(screen.queryByRole("radiogroup", { name: "Chart layout" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1×2" })).toBeInTheDocument();
    await pickLayout(user, "Side by side");
    expect(document.querySelector(".ws-grid")!.className).toContain("layout-side");
    expect(screen.getByRole("button", { name: "2×1" })).toBeInTheDocument();
  });

  it("closes with Escape, keeping the layout", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    const before = document.querySelector(".ws-grid")!.className;
    await user.click(screen.getByRole("button", { name: /^(1×1|2×1|1×2)/ }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("radiogroup", { name: "Chart layout" })).not.toBeInTheDocument();
    expect(document.querySelector(".ws-grid")!.className).toBe(before);
  });
});

describe("the notes panel under the chart", () => {
  beforeEach(() => screenIs(true));

  it("sits under the charts for the active instrument, closed until opened", async () => {
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    expect(screen.getByTestId("notes")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/study-notes"))).toBe(false); // nothing is fetched while it is shut
    await userEvent.setup().click(screen.getByTestId("notes-toggle"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/study-notes?segment=NSE&symbol=NIFTY"))).toBe(true));
  });

  it("saves a note under the active chart's instrument and interval, with the market as it was on screen", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    await user.click(screen.getByTestId("notes-toggle"));
    await user.type(await screen.findByLabelText("Note"), "Range day, wait for a break");
    await user.click(screen.getByRole("button", { name: "observation" }));
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(posts("/study-notes")).toHaveLength(1));
    const sent = posts("/study-notes")[0].body;
    expect(sent).toMatchObject({ segment: "NSE", symbol: "NIFTY", interval: "15min", text: "Range day, wait for a break", tag: "observation" });
    expect(sent.context.price).toBe(1000);
    expect(sent.context.interval).toBe("15min");
    expect(sent).not.toHaveProperty("snapshot_png_base64");
  });
});

describe("waiting orders", () => {
  it("arms a limit order on the server at the typed level, draws it on the chart, and lists it with a cancel", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    const c = await loaded();
    await user.click(t.getByRole("button", { name: "Wait for a price" }));
    await user.type(t.getByLabelText("Enter when the price reaches"), "980");
    await user.type(t.getByLabelText("Stop-loss"), "970");
    await waitFor(() => expect(c.overlaysNamed("planLine").map((o) => o.extendData.label).sort()).toEqual(["Entry", "Stop"]));
    waiting = [{ id: "w1", segment: "NSE", symbol: "RELIANCE", action: "BUY", strategy: "future", trigger_price: 980, stop_loss_price: 970, target_price: null, status: "pending", status_reason: null, expires_at: "x", last_price: null }];
    await user.click(t.getByRole("button", { name: /Buy RELIANCE, wait for price/ }));
    await waitFor(() => expect(posts("/pending-orders")).toHaveLength(1));
    expect(posts("/pending-orders")[0].body).toMatchObject({ segment: "NSE", symbol: "RELIANCE", action: "BUY", trigger_price: 980, stop_loss_price: 970, strategy: "future" });
    expect(await t.findByText(/placed when the price reaches 980/)).toBeInTheDocument();
    expect(t.queryByRole("link", { name: "See it in Portfolio" })).not.toBeInTheDocument(); // a waiting order is not a position yet
    const list = within(await screen.findByTestId("waiting"));
    expect(list.getByText("980")).toBeInTheDocument();
    await user.click(list.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls.some((c2) => c2.method === "DELETE" && c2.url.endsWith("/pending-orders/w1"))).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("waiting")).not.toBeInTheDocument());
  });

  it("needs a price for a limit order", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.click(t.getByRole("button", { name: "Wait for a price" }));
    expect(t.getByText(/Enter the price you want/)).toBeInTheDocument();
    expect(t.getByRole("button", { name: /wait for price/ })).toBeDisabled();
  });
});

describe("options", () => {
  const spread = async () => {
    lotSize = 65;
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const t = await ticket();
    await user.click(await t.findByRole("button", { name: "Option spread" }));
    await user.selectOptions(t.getByLabelText("Strike"), "OTM1");
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.type(t.getByLabelText("Target"), "1030");
    await user.click(t.getByRole("button", { name: /Buy NIFTY/ }));
    return { user, t };
  };

  it("opens the spread, then attaches the stop and target on the underlying", async () => {
    const { t } = await spread();
    await waitFor(() => expect(posts("/option-groups/manual")).toHaveLength(1));
    expect(posts("/option-groups/manual")[0].body).toMatchObject({ segment: "NSE", symbol: "NIFTY", option_position_style: "spread", option_strike_moneyness: "OTM1", order_type: "market" });
    await waitFor(() => expect(puts("/option-groups/g1/spot-stop-loss")).toHaveLength(1));
    expect(puts("/option-groups/g1/spot-stop-loss")[0].body).toEqual({ spot_stop_loss_price: 990 });
    expect(puts("/option-groups/g1/spot-target")[0].body).toEqual({ spot_target_price: 1030 });
    expect(await t.findByText("Paper order placed.")).toBeInTheDocument();
    expect(t.queryByText(/did not attach/)).not.toBeInTheDocument();
  });

  it("says so when the stop would not attach, rather than pretending it is protected", async () => {
    attachFails = true;
    const { t } = await spread();
    expect(await t.findByText(/stop-loss and target did not attach/)).toBeInTheDocument();
  });
});

describe("safety", () => {
  it("never shows an order ticket for an account that is live", async () => {
    account.live_trading_enabled = true;
    renderAt("/trade?symbol=RELIANCE");
    expect(await screen.findByText(/set to live trading/)).toBeInTheDocument();
    expect(screen.queryByTestId("ticket")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/more/settings?tab=broker");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("starts a clean ticket when the instrument changes", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    let t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.click(screen.getByRole("button", { name: "Bank Nifty" }));
    t = await ticket();
    await waitFor(() => expect(t.getByLabelText("Stop-loss")).toHaveValue(""));
  });
});

describe("Scan to Trade", () => {
  it("opens the stock that the scan linked to", async () => {
    renderAt("/trade?symbol=M%26M&segment=NSE");
    expect(await screen.findByRole("heading", { name: "Trade M&M" })).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("underlying=M%26M"))).toBe(true);
  });
});

describe("live price push", () => {
  const openSocket = async () => {
    await waitFor(() => expect(FakeWebSocket.last).toBeDefined());
    act(() => FakeWebSocket.last!.open());
    return FakeWebSocket.last!;
  };

  it("subscribes to the series it is charting, and the price and the newest candle follow it", async () => {
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    const c = await loaded();
    const socket = await openSocket();
    await waitFor(() => expect(socket.sent).toContainEqual({ action: "subscribe", exchange: "NSE", symbol: "RELIANCE" }));
    expect(screen.getByTestId("feed-0")).toHaveTextContent("Live");
    act(() => socket.push({ type: "tick", exchange: "NSE", symbol: "RELIANCE", price: 1012.5 }));
    expect(screen.getByTestId("price-0")).toHaveTextContent("1,012.5");
    await waitFor(() => expect(c.data[c.data.length - 1].close).toBe(1012.5));
  });

  it("uses the pushed price for a market order and for the risk on the ticket", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const socket = await openSocket();
    await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    act(() => socket.push({ type: "tick", exchange: "NSE", symbol: "RELIANCE", price: 1010 }));
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,010"));
    const t = within(await screen.findByTestId("ticket"));
    await user.type(t.getByLabelText("Stop-loss"), "1000");
    expect(within(t.getByTestId("summary")).getByText("1,010")).toBeInTheDocument(); // entry
    await user.click(t.getByRole("button", { name: /Buy RELIANCE/ }));
    await waitFor(() => expect(posts("/positions/manual")).toHaveLength(1));
    expect(posts("/positions/manual")[0].body).toMatchObject({ price: 1010, stop_loss_price: 1000 });
  });

  it("ignores a tick for some other symbol", async () => {
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    const socket = await openSocket();
    act(() => socket.push({ type: "tick", exchange: "NSE", symbol: "TCS", price: 4000 }));
    expect(screen.getByTestId("price-0")).toHaveTextContent("1,000");
  });

  it("says it is polling when the socket is down, and goes back to Live when it returns", async () => {
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    expect(screen.getByTestId("feed-0")).toHaveTextContent("every 5 seconds");
    const socket = await openSocket();
    expect(screen.getByTestId("feed-0")).toHaveTextContent("Live");
    act(() => socket.drop());
    expect(screen.getByTestId("feed-0")).toHaveTextContent("every 5 seconds");
  });

  it("falls back to REST once a pushed price has gone stale, rather than leaving no price at all", async () => {
    // The socket can be "connected" (the handshake to market-data succeeded) while delivering
    // nothing at all - market-data's own shared upstream feed can be dead independently of that.
    // REST keeps polling in the background even once the socket is up (just slower), specifically
    // so this can self-heal - see usePaneData's own comment on LTP_POLL_MS_SOCKET_UP. Without that,
    // this reproduces exactly what was reported live: a market order stuck on "Waiting for a live
    // price" indefinitely once the one pushed tick aged out, with nothing left to fall back to.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAt("/trade?symbol=RELIANCE");
      await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
      const socket = await openSocket();
      await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
      act(() => socket.push({ type: "tick", exchange: "NSE", symbol: "RELIANCE", price: 1010 }));
      await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,010"));
      // The feed goes quiet - no more ticks - but REST (still returning 1,000 throughout) keeps
      // confirming freshness in the background at its slower, socket-up cadence.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60_000 + 1_000);
      });
      expect(screen.getByTestId("price-0")).toHaveTextContent("1,000");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows no price at all once both the pushed and the polled price have gone stale", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAt("/trade?symbol=RELIANCE");
      await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
      const socket = await openSocket();
      await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
      act(() => socket.push({ type: "tick", exchange: "NSE", symbol: "RELIANCE", price: 1010 }));
      await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,010"));
      // Now REST starts failing too, same as the live feed actually being down end to end (an
      // expired/blocked Dhan token) - nothing left to confirm freshness with at all.
      ltpFails = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60_000 + 1_000);
      });
      expect(screen.getByTestId("price-0")).toHaveTextContent("–");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not carry the old symbol's price to the new one", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const socket = await openSocket();
    await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    act(() => socket.push({ type: "tick", exchange: "NSE", symbol: "RELIANCE", price: 1555 }));
    expect(screen.getByTestId("price-0")).toHaveTextContent("1,555");
    await user.click(screen.getByRole("button", { name: "Bank Nifty" }));
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000")); // this symbol's own quote
    expect(screen.getByTestId("price-0")).not.toHaveTextContent("1,555");
  });
});

// ---------------------------------------------------------------------------------------------------
// The workstation: a wide screen, the tool strip, menus, structure, and two linked charts.
// ---------------------------------------------------------------------------------------------------

describe("on a phone", () => {
  it("has one chart, no tool strip, no layout controls, and the ticket beneath", async () => {
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    expect(screen.queryByRole("toolbar", { name: "Drawing tools" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Layout" })).not.toBeInTheDocument();
    expect(screen.getAllByTestId("chart-pane")).toHaveLength(1);
    expect(screen.getByTestId("ticket")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Indicators/ })).toBeInTheDocument(); // still reachable
  });
});

describe("drawing tools", () => {
  beforeEach(() => screenIs(true));

  it("shows a tool strip, arms the chosen tool on the chart, and puts it down when the drawing is finished", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    const bar = within(screen.getByRole("toolbar", { name: "Drawing tools" }));
    expect(bar.getByRole("button", { name: "Cursor" })).toHaveAttribute("aria-pressed", "true");
    await user.click(bar.getByRole("button", { name: "Trend line" }));
    expect(bar.getByRole("button", { name: "Trend line" })).toHaveAttribute("aria-pressed", "true");
    const armed = c.overlaysNamed("segment");
    expect(armed).toHaveLength(1);
    act(() => c.finishDrawing(armed[0].id, [{ timestamp: c.data[3].timestamp, value: 1010 }, { timestamp: c.data[10].timestamp, value: 1020 }]));
    expect(bar.getByRole("button", { name: "Cursor" })).toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(localStorage.getItem("web.chart.drawings:NSE:NIFTY")!)).toEqual([
      { name: "segment", points: [{ timestamp: c.data[3].timestamp, value: 1010 }, { timestamp: c.data[10].timestamp, value: 1020 }] },
    ]);
  });

  describe("the Text tool", () => {
    const KEY = "web.chart.drawings:NSE:NIFTY";
    const saved = () => JSON.parse(localStorage.getItem(KEY) ?? "[]");

    async function place(user: ReturnType<typeof userEvent.setup>) {
      renderAt("/trade?symbol=NIFTY");
      const c = await loaded();
      const bar = within(screen.getByRole("toolbar", { name: "Drawing tools" }));
      await user.click(bar.getByRole("button", { name: "Text" }));
      expect(bar.getByRole("button", { name: "Text" })).toHaveAttribute("aria-pressed", "true");
      const armed = c.overlaysNamed("textNote");
      expect(armed).toHaveLength(1);
      act(() => c.finishDrawing(armed[0].id, [{ timestamp: c.data[5].timestamp, value: 1010 }]));
      return { c, bar, id: armed[0].id };
    }

    it("is in the tool strip, and after the click asks for the words in a box on the chart", async () => {
      const user = userEvent.setup();
      const { bar } = await place(user);
      expect(await screen.findByLabelText("Text on the chart")).toHaveFocus();
      expect(saved()).toEqual([]); // nothing is kept until there are words
      expect(bar.getByRole("button", { name: "Cursor" })).toHaveAttribute("aria-pressed", "true"); // the tool is put down
    });

    it("keeps the words on Enter - shown on the chart and saved with the instrument's drawings", async () => {
      const user = userEvent.setup();
      const { c, id } = await place(user);
      await user.type(await screen.findByLabelText("Text on the chart"), "Support held twice{Enter}");
      expect(screen.queryByLabelText("Text on the chart")).not.toBeInTheDocument();
      expect(c.overlays.get(id)!.extendData).toEqual({ text: "Support held twice" });
      expect(saved()).toEqual([{ name: "textNote", points: [{ timestamp: c.data[5].timestamp, value: 1010 }], text: "Support held twice" }]);
    });

    it("keeps nothing when Escape is pressed or the box is left empty", async () => {
      const user = userEvent.setup();
      const first = await place(user);
      await user.type(await screen.findByLabelText("Text on the chart"), "never mind{Escape}");
      expect(first.c.overlaysNamed("textNote")).toHaveLength(0);
      expect(saved()).toEqual([]);
    });

    it("keeps nothing for a box left empty, and trims the words it does keep", async () => {
      const user = userEvent.setup();
      const { c } = await place(user);
      await user.type(await screen.findByLabelText("Text on the chart"), "   {Enter}");
      expect(c.overlaysNamed("textNote")).toHaveLength(0);
      expect(saved()).toEqual([]);
    });

    it("saves the words when the person clicks away from the box", async () => {
      const user = userEvent.setup();
      const { c } = await place(user);
      await user.type(await screen.findByLabelText("Text on the chart"), "break and retest");
      await user.click(document.body);
      expect(saved()[0]).toMatchObject({ name: "textNote", text: "break and retest" });
      expect(c.overlaysNamed("textNote")).toHaveLength(1);
    });

    it("draws a saved text back on the chart when the instrument is opened again", async () => {
      localStorage.setItem(KEY, JSON.stringify([{ name: "textNote", points: [{ timestamp: Date.now() - 600_000, value: 1005 }], text: "Gap fill target" }]));
      renderAt("/trade?symbol=NIFTY");
      const c = await loaded();
      await waitFor(() => expect(c.overlaysNamed("textNote")).toHaveLength(1));
      expect(c.overlaysNamed("textNote")[0].extendData).toEqual({ text: "Gap fill target" });
    });

    it("double-clicking a text changes its words", async () => {
      localStorage.setItem(KEY, JSON.stringify([{ name: "textNote", points: [{ timestamp: Date.now() - 600_000, value: 1005 }], text: "old words" }]));
      const user = userEvent.setup();
      renderAt("/trade?symbol=NIFTY");
      const c = await loaded();
      await waitFor(() => expect(c.overlaysNamed("textNote")).toHaveLength(1));
      const ov = c.overlaysNamed("textNote")[0];
      act(() => c.doubleClick(ov.id));
      const box = await screen.findByLabelText("Text on the chart");
      expect(box).toHaveValue("old words");
      await user.clear(box);
      await user.type(box, "new words{Enter}");
      expect(c.overlays.get(ov.id)!.extendData).toEqual({ text: "new words" });
      expect(saved()[0].text).toBe("new words");
    });

    it("leaves a text as it was when its edit is cancelled, and never deletes it", async () => {
      localStorage.setItem(KEY, JSON.stringify([{ name: "textNote", points: [{ timestamp: Date.now() - 600_000, value: 1005 }], text: "keep me" }]));
      const user = userEvent.setup();
      renderAt("/trade?symbol=NIFTY");
      const c = await loaded();
      await waitFor(() => expect(c.overlaysNamed("textNote")).toHaveLength(1));
      act(() => c.doubleClick(c.overlaysNamed("textNote")[0].id));
      await user.type(await screen.findByLabelText("Text on the chart"), "xyz{Escape}");
      expect(c.overlaysNamed("textNote")).toHaveLength(1);
      expect(saved()[0].text).toBe("keep me");
    });
  });

  describe("the look of a drawing", () => {
    const KEY = "web.chart.drawings:NSE:NIFTY";
    const saved = () => JSON.parse(localStorage.getItem(KEY) ?? "[]");
    const defaults = () => JSON.parse(localStorage.getItem("web.chart.drawingDefaults") ?? "{}");

    async function drawLine(user: ReturnType<typeof userEvent.setup>, tool = "Trend line", name = "segment") {
      const c = chart(0);
      const bar = within(screen.getByRole("toolbar", { name: "Drawing tools" }));
      await user.click(bar.getByRole("button", { name: tool }));
      const armed = c.overlaysNamed(name).filter((o) => o.points.length === 0);
      const ov = armed[armed.length - 1];
      act(() => c.finishDrawing(ov.id, [{ timestamp: c.data[3].timestamp, value: 1010 }, { timestamp: c.data[10].timestamp, value: 1020 }]));
      act(() => c.select(ov.id));
      return { c, id: ov.id };
    }

    it("shows the style bar only while a drawing is selected", async () => {
      const user = userEvent.setup();
      renderAt("/trade?symbol=NIFTY");
      await loaded();
      expect(screen.queryByTestId("style-bar")).not.toBeInTheDocument();
      await drawLine(user);
      expect(await screen.findByTestId("style-bar")).toBeInTheDocument();
    });

    it("applies a colour, thickness and dash to the drawing at once and saves them with it", async () => {
      const user = userEvent.setup();
      renderAt("/trade?symbol=NIFTY");
      await loaded();
      const { c, id } = await drawLine(user);
      const bar = within(await screen.findByTestId("style-bar"));
      await user.click(bar.getByRole("button", { name: "Colour Red" }));
      await user.click(bar.getByRole("button", { name: "Thickness 3" }));
      await user.click(bar.getByRole("button", { name: "Dashed" }));
      expect(c.overlays.get(id)!.styles.line).toEqual({ color: "#e8586a", size: 3, style: "dashed", dashedValue: [6, 4] });
      expect(saved()[0]).toMatchObject({ name: "segment", style: { color: "#e8586a", width: 3, dash: "dashed" } });
    });

    it("draws a restyled drawing the same way when the instrument is opened again", async () => {
      localStorage.setItem(KEY, JSON.stringify([{ name: "rect", points: [{ timestamp: Date.now() - 900_000, value: 1000 }, { timestamp: Date.now() - 300_000, value: 1020 }], style: { color: "#3ecf8e", fill: 0.5 } }]));
      renderAt("/trade?symbol=NIFTY");
      const c = await loaded();
      await waitFor(() => expect(c.overlaysNamed("rect")).toHaveLength(1));
      expect(c.overlaysNamed("rect")[0].styles.polygon).toMatchObject({ color: "rgba(62, 207, 142, 0.5)", borderColor: "#3ecf8e" });
    });

    it("ignores a damaged saved style instead of drawing it", async () => {
      localStorage.setItem(KEY, JSON.stringify([{ name: "segment", points: [{ timestamp: Date.now() - 900_000, value: 1000 }, { timestamp: Date.now() - 300_000, value: 1020 }], style: { color: "javascript:alert(1)", width: 99 } }]));
      renderAt("/trade?symbol=NIFTY");
      const c = await loaded();
      await waitFor(() => expect(c.overlaysNamed("segment")).toHaveLength(1));
      expect(c.overlaysNamed("segment")[0].styles).toBeUndefined();
    });

    it("resets a drawing to the chart's own look, and keeps it where it was", async () => {
      const user = userEvent.setup();
      renderAt("/trade?symbol=NIFTY");
      await loaded();
      const { c } = await drawLine(user);
      const bar = within(await screen.findByTestId("style-bar"));
      await user.click(bar.getByRole("button", { name: "Colour Blue" }));
      await user.click(bar.getByRole("button", { name: "Reset look" }));
      expect(saved()[0].style).toBeUndefined();
      expect(saved()[0].points).toHaveLength(2);
      expect(c.overlaysNamed("segment").every((o) => o.styles === undefined)).toBe(true);
    });

    it("makes a look the default for its kind: the next drawing of that kind starts with it, other kinds do not", async () => {
      const user = userEvent.setup();
      renderAt("/trade?symbol=NIFTY");
      await loaded();
      const first = await drawLine(user);
      let bar = within(await screen.findByTestId("style-bar"));
      await user.click(bar.getByRole("button", { name: "Colour Yellow" }));
      await user.click(bar.getByRole("button", { name: "Use for new trend lines" }));
      expect(defaults()).toEqual({ segment: { color: "#ffc83d" } });
      expect(within(screen.getByTestId("style-bar")).getByRole("button", { name: "Clear default for trend lines" })).toBeInTheDocument();

      // a second trend line starts yellow...
      const second = await drawLine(user);
      expect(second.c.overlays.get(second.id)!.styles.line.color).toBe("#ffc83d");
      expect(saved()[1].style).toEqual({ color: "#ffc83d" });
      // ...a ray does not
      const ray = await drawLine(user, "Ray", "rayLine");
      expect(ray.c.overlays.get(ray.id)!.styles).toBeUndefined();
      void first;
    });

    it("clears a default again", async () => {
      localStorage.setItem("web.chart.drawingDefaults", JSON.stringify({ segment: { color: "#ffc83d" } }));
      const user = userEvent.setup();
      renderAt("/trade?symbol=NIFTY");
      await loaded();
      await drawLine(user);
      await user.click(await screen.findByRole("button", { name: "Clear default for trend lines" }));
      expect(defaults()).toEqual({});
    });

    it("changes a text label's colour, size and weight, keeping its words", async () => {
      const user = userEvent.setup();
      renderAt("/trade?symbol=NIFTY");
      const c = await loaded();
      await user.click(within(screen.getByRole("toolbar", { name: "Drawing tools" })).getByRole("button", { name: "Text" }));
      const ov = c.overlaysNamed("textNote")[0];
      act(() => c.finishDrawing(ov.id, [{ timestamp: c.data[5].timestamp, value: 1010 }]));
      await user.type(await screen.findByLabelText("Text on the chart"), "Supply above{Enter}");
      act(() => c.select(ov.id));
      const bar = within(await screen.findByTestId("style-bar"));
      expect(bar.queryByRole("group", { name: "Thickness" })).not.toBeInTheDocument();
      await user.click(bar.getByRole("button", { name: "Colour Orange" }));
      await user.click(bar.getByRole("button", { name: "Large" }));
      await user.click(bar.getByRole("button", { name: "Bold" }));
      expect(c.overlays.get(ov.id)!.extendData).toEqual({ text: "Supply above", style: { color: "#ff9f43", textSize: 16, bold: false } });
      expect(saved()[0]).toMatchObject({ name: "textNote", text: "Supply above", style: { color: "#ff9f43", textSize: 16, bold: false } });
    });

    it("a text label keeps its look when its words are edited", async () => {
      localStorage.setItem(KEY, JSON.stringify([{ name: "textNote", points: [{ timestamp: Date.now() - 600_000, value: 1005 }], text: "old", style: { color: "#a78bfa", textSize: 20 } }]));
      const user = userEvent.setup();
      renderAt("/trade?symbol=NIFTY");
      const c = await loaded();
      await waitFor(() => expect(c.overlaysNamed("textNote")).toHaveLength(1));
      const ov = c.overlaysNamed("textNote")[0];
      expect(ov.extendData).toEqual({ text: "old", style: { color: "#a78bfa", textSize: 20 } });
      act(() => c.doubleClick(ov.id));
      const box = await screen.findByLabelText("Text on the chart");
      await user.clear(box);
      await user.type(box, "new{Enter}");
      expect(c.overlays.get(ov.id)!.extendData).toEqual({ text: "new", style: { color: "#a78bfa", textSize: 20 } });
    });
  });

  it("a drawing made on one chart shows up on a sibling chart of the SAME instrument at a different interval", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded(0);
    await user.click(screen.getByRole("button", { name: /Combos/ }));
    await user.click(screen.getByRole("button", { name: "NIFTY + BANKNIFTY" }));
    await loaded(1);
    // Make the second chart NIFTY too, at a different interval than the first (still 15m).
    await user.pointer({ target: screen.getAllByRole("region")[1], keys: "[MouseLeft]" });
    await user.type(screen.getByRole("searchbox", { name: "Trade a stock" }), "NIFTY");
    await user.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(screen.getAllByText("NIFTY")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: /^(1×1|2×1|1×2)/ }));
    await user.click(screen.getByLabelText("Same interval"));
    await user.click(screen.getByRole("button", { name: /^(1×1|2×1|1×2)/ }));
    await user.click(within(screen.getAllByRole("group", { name: "Interval, NIFTY" })[1]).getByRole("button", { name: "1h" }));
    // Clicking into chart 1's region above (to change its symbol) made IT the active pane -
    // click back into chart 0 so the toolbar draws there instead.
    await user.pointer({ target: screen.getAllByRole("region")[0], keys: "[MouseLeft]" });

    const bar = within(screen.getByRole("toolbar", { name: "Drawing tools" }));
    await user.click(bar.getByRole("button", { name: "Trend line" }));
    const pending = chart(0).overlaysNamed("segment");
    expect(pending).toHaveLength(1);
    act(() => chart(0).finishDrawing(pending[0].id, [{ timestamp: chart(0).data[3].timestamp, value: 1010 }, { timestamp: chart(0).data[10].timestamp, value: 1020 }]));

    // Pane 2 remounted (a fresh FakeChart instance) when its own symbol changed to NIFTY above -
    // same "starts a new instrument with its own drawings" precedent this file already uses, so
    // its CURRENT chart is the latest instance, not chart(1).
    const paneTwo = FakeChart.instances[FakeChart.instances.length - 1];
    // The SAME drawing now exists on chart 2 (1h) too - not drawn there by the person, restored
    // from the shared (exchange, symbol) save the moment chart 0 persisted it - and only once,
    // not duplicated by chart 0 also reacting to its own write.
    await waitFor(() => expect(paneTwo.overlaysNamed("segment")).toHaveLength(1));
    expect(chart(0).overlaysNamed("segment")).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("web.chart.drawings:NSE:NIFTY")!)).toHaveLength(1);
  });

  it("choosing the same tool again, or the cursor, puts it down without drawing anything", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    const bar = within(screen.getByRole("toolbar", { name: "Drawing tools" }));
    await user.click(bar.getByRole("button", { name: "Zone (supply or demand)" }));
    expect(c.overlaysNamed("rect")).toHaveLength(1);
    await user.click(bar.getByRole("button", { name: "Zone (supply or demand)" }));
    expect(c.overlaysNamed("rect")).toHaveLength(0);
    await user.click(bar.getByRole("button", { name: "Ray" }));
    await user.click(bar.getByRole("button", { name: "Cursor" }));
    expect(c.overlaysNamed("rayLine")).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem("web.chart.drawings:NSE:NIFTY") ?? "[]")).toEqual([]); // nothing was drawn, so nothing is saved
  });

  it("restores saved drawings when the chart loads, at the time they were drawn", async () => {
    localStorage.setItem("web.chart.drawings:NSE:NIFTY", JSON.stringify([{ name: "horizontalStraightLine", points: [{ value: 1015 }] }, { name: "rect", points: [{ timestamp: Date.parse("2026-09-25T10:00:00+05:30"), value: 1010 }, { timestamp: Date.parse("2026-09-25T11:00:00+05:30"), value: 1020 }] }]));
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    await waitFor(() => expect(c.overlaysNamed("rect")).toHaveLength(1));
    expect(c.overlaysNamed("horizontalStraightLine")).toHaveLength(1);
    // handed over as continuous bar positions, never as bare timestamps the library would snap
    const [a, b] = c.overlaysNamed("rect")[0].points;
    expect(a.timestamp).toBeUndefined();
    expect(b.dataIndex).toBeGreaterThan(a.dataIndex);
    expect(a.value).toBe(1010);
  });

  it("re-places each drawing once when the interval changes, never doubling them up", async () => {
    const user = userEvent.setup();
    localStorage.setItem("web.chart.drawings:NSE:NIFTY", JSON.stringify([{ name: "priceLine", points: [{ value: 1030 }] }, { name: "segment", points: [{ timestamp: Date.now() - 3 * 3_600_000, value: 1010 }, { timestamp: Date.now() - 3_600_000, value: 1020 }] }]));
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    await waitFor(() => expect(c.overlaysNamed("segment")).toHaveLength(1));
    const applied = c.applyCalls;
    await user.click(screen.getByRole("button", { name: "5m" }));
    await waitFor(() => expect(c.applyCalls).toBeGreaterThan(applied)); // the series was reloaded at the new size
    await waitFor(() => expect(c.overlaysNamed("segment")).toHaveLength(1));
    expect(c.overlaysNamed("priceLine")).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("web.chart.drawings:NSE:NIFTY")!)).toHaveLength(2); // and the saved set is intact
  });

  it("starts a new instrument with its own drawings, none of the previous instrument's", async () => {
    const user = userEvent.setup();
    localStorage.setItem("web.chart.drawings:NSE:NIFTY", JSON.stringify([{ name: "priceLine", points: [{ value: 1030 }] }]));
    localStorage.setItem("web.chart.drawings:NSE:BANKNIFTY", JSON.stringify([{ name: "horizontalStraightLine", points: [{ value: 55000 }] }]));
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    await user.click(screen.getByRole("button", { name: "Bank Nifty" }));
    await waitFor(() => expect(FakeChart.instances.length).toBeGreaterThan(1));
    const next = FakeChart.instances[FakeChart.instances.length - 1];
    await waitFor(() => expect(next.overlaysNamed("horizontalStraightLine")).toHaveLength(1));
    expect(next.overlaysNamed("priceLine")).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem("web.chart.drawings:NSE:NIFTY")!)).toHaveLength(1);
  });

  it("keeps drawings per instrument", async () => {
    localStorage.setItem("web.chart.drawings:NSE:BANKNIFTY", JSON.stringify([{ name: "priceLine", points: [{ value: 5 }] }]));
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    expect(c.overlaysNamed("priceLine")).toHaveLength(0);
  });

  it("deletes the selected drawing (and it stays deleted), and can clear the lot", async () => {
    const user = userEvent.setup();
    localStorage.setItem("web.chart.drawings:NSE:NIFTY", JSON.stringify([{ name: "horizontalStraightLine", points: [{ value: 1015 }] }, { name: "priceLine", points: [{ value: 1030 }] }]));
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    await waitFor(() => expect(c.overlaysNamed("priceLine")).toHaveLength(1));
    const bar = within(screen.getByRole("toolbar", { name: "Drawing tools" }));
    expect(bar.getByRole("button", { name: "Delete selected drawing" })).toBeDisabled();
    act(() => c.select(c.overlaysNamed("priceLine")[0].id));
    await user.click(bar.getByRole("button", { name: "Delete selected drawing" }));
    expect(c.overlaysNamed("priceLine")).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem("web.chart.drawings:NSE:NIFTY")!)).toHaveLength(1);
    await user.click(bar.getByRole("button", { name: "Clear all drawings" }));
    expect(c.overlaysNamed("horizontalStraightLine")).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem("web.chart.drawings:NSE:NIFTY")!)).toEqual([]);
  });

  it("removes the selected drawing with the Delete key, but not while typing in a field", async () => {
    const user = userEvent.setup();
    localStorage.setItem("web.chart.drawings:NSE:NIFTY", JSON.stringify([{ name: "priceLine", points: [{ value: 1030 }] }]));
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    await waitFor(() => expect(c.overlaysNamed("priceLine")).toHaveLength(1));
    act(() => c.select(c.overlaysNamed("priceLine")[0].id));
    const box = screen.getByLabelText("Stop-loss");
    await user.click(box);
    await user.keyboard("{Delete}");
    expect(c.overlaysNamed("priceLine")).toHaveLength(1); // the key was for the text box
    await user.click(document.body);
    await user.keyboard("{Delete}");
    expect(c.overlaysNamed("priceLine")).toHaveLength(0);
  });

  it("hides drawings without deleting them, and turns the magnet on for them", async () => {
    const user = userEvent.setup();
    localStorage.setItem("web.chart.drawings:NSE:NIFTY", JSON.stringify([{ name: "priceLine", points: [{ value: 1030 }] }]));
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    await waitFor(() => expect(c.overlaysNamed("priceLine")).toHaveLength(1));
    const bar = within(screen.getByRole("toolbar", { name: "Drawing tools" }));
    await user.click(bar.getByRole("button", { name: "Hide drawings" }));
    await waitFor(() => expect(c.overlaysNamed("priceLine")[0].visible).toBe(false));
    expect(JSON.parse(localStorage.getItem("web.chart.drawings:NSE:NIFTY")!)).toHaveLength(1); // still saved
    await user.click(bar.getByRole("button", { name: "Show drawings" }));
    await waitFor(() => expect(c.overlaysNamed("priceLine")[0].visible).toBe(true));
    await user.click(bar.getByRole("button", { name: "Magnet" }));
    await waitFor(() => expect(c.overlaysNamed("priceLine")[0].mode).toBe("weak_magnet"));
    expect(JSON.parse(localStorage.getItem("web.chart.tools")!).magnet).toBe(true);
  });

  it("right-clicking a drawing removes it", async () => {
    localStorage.setItem("web.chart.drawings:NSE:NIFTY", JSON.stringify([{ name: "priceLine", points: [{ value: 1030 }] }]));
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    await waitFor(() => expect(c.overlaysNamed("priceLine")).toHaveLength(1));
    const ov = c.overlaysNamed("priceLine")[0];
    act(() => void ov.handlers.onRightClick({ overlay: { id: ov.id } }));
    expect(c.overlaysNamed("priceLine")).toHaveLength(0);
  });
});

describe("indicators", () => {
  beforeEach(() => screenIs(true));
  const menu = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    return within(screen.getByRole("group", { name: "Indicators" }));
  };

  it("starts with moving averages and volume, on the price pane and a pane of its own", async () => {
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    await waitFor(() => expect([...c.indicators.keys()].sort()).toEqual(["MA", "VOL"]));
    expect(c.indicators.get("MA")!.stack).toBe(true);
    expect(c.indicators.get("VOL")!.stack).toBe(false);
  });

  it("adds and removes an indicator from the menu, and remembers the choice", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    const m = await menu(user);
    await user.click(m.getByLabelText("Supertrend (ATR period, multiplier)"));
    await waitFor(() => expect(c.indicators.has("SUPERTREND")).toBe(true));
    await user.click(m.getByLabelText("Volume"));
    await waitFor(() => expect(c.removedIndicators).toContain("VOL"));
    expect(JSON.parse(localStorage.getItem("web.chart.indicators")!).sort()).toEqual(["MA", "SUPERTREND"]);
  });

  it("changes an indicator's numbers only when the box is committed, ignoring half-typed values", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    const m = await menu(user);
    const box = m.getByLabelText("MA settings");
    expect(box).toHaveValue("5, 10, 30, 60");
    await user.clear(box);
    await user.type(box, "9, 21");
    expect(c.overrides.some((o: any) => o.name === "MA")).toBe(false); // nothing yet
    await user.tab();
    await waitFor(() => expect(c.overrides).toContainEqual({ name: "MA", calcParams: [9, 21] }));
    expect(JSON.parse(localStorage.getItem("web.chart.indicatorParams")!)).toEqual({ MA: [9, 21] });
  });

  it("hides every indicator without forgetting them", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    await waitFor(() => expect(c.indicators.size).toBe(2));
    const m = await menu(user);
    await user.click(m.getByLabelText("Hide all indicators"));
    await waitFor(() => expect(c.indicators.size).toBe(0));
    expect(JSON.parse(localStorage.getItem("web.chart.indicators")!).sort()).toEqual(["MA", "VOL"]);
    await user.click(m.getByLabelText("Hide all indicators"));
    await waitFor(() => expect(c.indicators.size).toBe(2));
  });

  it("closes on Escape and on a click elsewhere", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    await menu(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Indicators" })).not.toBeInTheDocument();
    await menu(user);
    await user.click(document.body);
    expect(screen.queryByRole("group", { name: "Indicators" })).not.toBeInTheDocument();
  });
});

describe("structure", () => {
  beforeEach(() => screenIs(true));
  const fullStructure = () => ({
    trend: "up",
    order_blocks: [{ kind: "demand", role: "orderblock", proximal: 100, distal: 95, origin_timestamp: "2026-09-25T09:30:00+05:30", mitigated: false, counter_trend: false }],
    fvgs: [{ kind: "bullish", top: 110, bottom: 108, origin_timestamp: "2026-09-25T10:00:00+05:30", filled: false }],
    events: [{ kind: "bos", direction: "up", price: 105, timestamp: "2026-09-25T11:00:00+05:30", from_timestamp: "2026-09-25T10:15:00+05:30" }],
    trend_changes: [{ timestamp: "2026-09-25T11:00:00+05:30", price: 105, trend: "up" }],
    setups: [{ direction: "long", status: "triggered", entry: 106, stop_loss: 103, target: 112, risk_reward: 2, zone_proximal: 100, zone_distal: 95, confirmed_timestamp: "2026-09-25T11:30:00+05:30", resolved_timestamp: null }],
  });
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    // The Structure dropdown itself only exists once at least one timeframe is ticked - off by
    // default, so most tests here have to turn it on first via the Indicators menu's own switch.
    if (!screen.queryByRole("button", { name: /^Structure/ })) {
      await user.click(screen.getByRole("button", { name: /Indicators/ }));
      await user.click(screen.getByLabelText("Structure"));
      await user.click(screen.getByRole("button", { name: /Indicators/ })); // close it again
    }
    await user.click(screen.getByRole("button", { name: /^Structure/ }));
    return within(screen.getByRole("group", { name: "Structure" }));
  };

  it("is off until a timeframe is ticked, and downloads nothing", async () => {
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    expect(c.overlays.size).toBe(0);
    expect(calls.some((x) => x.url.includes("/order-blocks"))).toBe(false);
  });

  it("the Structure dropdown itself only exists once the Indicators menu's own switch turns the layer on, and disappears again when it's switched off", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    expect(screen.queryByRole("button", { name: /^Structure/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    const indicators = within(screen.getByRole("group", { name: "Indicators" }));
    expect(indicators.getByLabelText("Structure")).not.toBeChecked();
    await user.click(indicators.getByLabelText("Structure"));
    await user.click(screen.getByRole("button", { name: /Indicators/ }));

    // Seeded with the active chart's own interval (15m, the default) - not a stale accumulated list.
    expect(screen.getByRole("button", { name: "Structure 1" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("web.chart.structure")!).tfs).toEqual(["15min"]);

    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    await user.click(within(screen.getByRole("group", { name: "Indicators" })).getByLabelText("Structure"));
    await user.click(screen.getByRole("button", { name: /Indicators/ }));

    expect(screen.queryByRole("button", { name: /^Structure/ })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("web.chart.structure")!).tfs).toEqual([]);
  });

  it("draws zones for the ticked timeframe, asking the server for the optional layers only when they are on", async () => {
    structure = fullStructure();
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    const m = await open(user);
    // Turning Structure on (inside open()) already ticks 15m - the active chart's own interval.
    expect(within(m.getByRole("group", { name: "Detection timeframes" })).getByRole("button", { name: "15m" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(c.overlaysNamed("htfOrderBlock")).toHaveLength(1));
    expect(c.overlaysNamed("htfFvg")).toHaveLength(0); // not asked for
    const first = calls.filter((x) => x.url.includes("/order-blocks")).pop()!;
    expect(new URL(first.url).searchParams.get("interval")).toBe("15min");
    expect(new URL(first.url).searchParams.get("fvg")).toBeNull();

    await user.click(m.getByLabelText(/Fair value gaps/));
    await user.click(m.getByLabelText(/BOS and CHoCH/));
    await user.click(m.getByLabelText(/Trend marks/));
    await user.click(m.getByLabelText(/^Setups/));
    await user.click(m.getByLabelText(/Breaker blocks/));
    await waitFor(() => expect(c.overlaysNamed("htfFvg")).toHaveLength(1));
    expect(c.overlaysNamed("htfStructureBreak")).toHaveLength(1);
    expect(c.overlaysNamed("htfTrendMark")).toHaveLength(1);
    expect(c.overlaysNamed("htfSetup")).toHaveLength(1);
    const last = calls.filter((x) => x.url.includes("/order-blocks")).pop()!;
    const p = new URL(last.url).searchParams;
    expect([p.get("fvg"), p.get("breakers"), p.get("setups")]).toEqual(["true", "true", "true"]);
    expect(JSON.parse(localStorage.getItem("web.chart.structure")!)).toMatchObject({ tfs: ["15min"], fvg: true, setups: true });
  });

  it("resets to the new interval on a change - drops finer detection timeframes, keeps coarser ones, adds the new size", async () => {
    structure = fullStructure();
    localStorage.setItem("web.chart.structure", JSON.stringify({ tfs: ["5min", "60min"], breakers: false, fvg: false, breaks: false, trendMarks: false, setups: false }));
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    await user.click(within(screen.getByRole("group", { name: "Interval, NIFTY" })).getByRole("button", { name: "15m" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("web.chart.structure")!).tfs).toEqual(["15min", "60min"]));
  });

  it("shows the structure trend beside the chart's name, and live setups in a strip", async () => {
    structure = fullStructure();
    localStorage.setItem("web.chart.structure", JSON.stringify({ tfs: ["15min"], breakers: false, fvg: false, breaks: false, trendMarks: false, setups: true }));
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    expect(await screen.findByText("15m structure up")).toBeInTheDocument();
    const strip = await screen.findByTestId("setups");
    expect(strip).toHaveTextContent("15m long triggered · entry 106 · stop 103 · target 112 · 2.0R");
  });

  it("clears the layer when every timeframe is unticked", async () => {
    structure = fullStructure();
    localStorage.setItem("web.chart.structure", JSON.stringify({ tfs: ["15min"] }));
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    await waitFor(() => expect(c.overlaysNamed("htfOrderBlock")).toHaveLength(1));
    const m = await open(user);
    await user.click(within(m.getByRole("group", { name: "Detection timeframes" })).getByRole("button", { name: "15m" }));
    await waitFor(() => expect(c.overlaysNamed("htfOrderBlock")).toHaveLength(0));
    expect(screen.queryByText("15m structure up")).not.toBeInTheDocument();
  });

  it("keeps the chart working when the structure download fails", async () => {
    structureFails = true;
    localStorage.setItem("web.chart.structure", JSON.stringify({ tfs: ["15min"] }));
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    await waitFor(() => expect(calls.some((x) => x.url.includes("/order-blocks"))).toBe(true));
    expect(c.data.length).toBe(30);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("picking a price on the chart", () => {
  beforeEach(() => screenIs(true));

  it("fills the stop from a click on the chart, then stops picking", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const t = await ticket();
    const c = await loaded();
    await user.click(t.getAllByRole("button", { name: "Pick on chart" })[0]); // the first field is the stop (a market order has no entry)
    expect(t.getByRole("button", { name: "Click the chart…" })).toBeInTheDocument();
    expect(c.subs.get("onCrosshairChange")!.size).toBeGreaterThan(0);
    // pointer over the price pane at y = 40 -> price 960 (the stand-in maps y to 1000 - y)
    act(() => c.emit("onCrosshairChange", { paneId: "candle_pane", y: 40 }));
    await user.click(screen.getAllByTestId("chart-pane")[0].querySelector(".chart-canvas")!);
    await waitFor(() => expect(t.getByLabelText("Stop-loss")).toHaveValue("960"));
    expect(t.queryByRole("button", { name: "Click the chart…" })).not.toBeInTheDocument();
    expect(c.overlaysNamed("planLine").map((o) => o.extendData.label)).toEqual(["Stop"]);
  });

  it("ignores a click when the pointer is not over the price pane", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const t = await ticket();
    const c = await loaded();
    await user.click(t.getAllByRole("button", { name: "Pick on chart" })[0]);
    act(() => c.emit("onCrosshairChange", { paneId: "vol_pane", y: 40 }));
    await user.click(screen.getAllByTestId("chart-pane")[0].querySelector(".chart-canvas")!);
    expect(t.getByLabelText("Stop-loss")).toHaveValue("");
    expect(t.getByRole("button", { name: "Click the chart…" })).toBeInTheDocument(); // still waiting
  });

  it("picking an entry switches the order to wait-for-a-price", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const t = await ticket();
    const c = await loaded();
    await user.click(t.getByRole("button", { name: "Wait for a price" }));
    await user.click(t.getAllByRole("button", { name: "Pick on chart" })[0]); // entry is first once it is a waiting order
    act(() => c.emit("onCrosshairChange", { paneId: "candle_pane", y: 20 }));
    await user.click(screen.getAllByTestId("chart-pane")[0].querySelector(".chart-canvas")!);
    await waitFor(() => expect(t.getByLabelText("Enter when the price reaches")).toHaveValue("980"));
  });

  it("stops listening for the pointer once picking is switched off", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const t = await ticket();
    const c = await loaded();
    const before = c.subs.get("onCrosshairChange")!.size;
    await user.click(t.getAllByRole("button", { name: "Pick on chart" })[0]);
    expect(c.subs.get("onCrosshairChange")!.size).toBe(before + 1);
    await user.click(t.getByRole("button", { name: "Click the chart…" }));
    expect(c.subs.get("onCrosshairChange")!.size).toBe(before);
  });
});

describe("layout and the ticket panel", () => {
  beforeEach(() => screenIs(true));

  it("hides and shows the ticket, so the chart can have the whole width, and remembers it", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    expect(screen.getByTestId("ticket")).toBeInTheDocument();
    const box = screen.getByRole("button", { name: "Show ticket" });
    expect(box).toHaveAttribute("aria-pressed", "true");
    await user.click(box);
    expect(screen.queryByTestId("ticket")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("web.workstation")!).ticketOpen).toBe(false);
    await user.click(box);
    expect(screen.getByTestId("ticket")).toBeInTheDocument();
  });

  it("goes full screen and back", async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    const exit = vi.fn();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    const stage = document.querySelector(".workstation") as HTMLElement & { requestFullscreen?: () => void };
    stage.requestFullscreen = request;
    await user.click(screen.getByRole("button", { name: "Full screen" }));
    expect(request).toHaveBeenCalled();
    Object.defineProperty(document, "fullscreenElement", { value: stage, configurable: true });
    (document as any).exitFullscreen = exit;
    act(() => document.dispatchEvent(new Event("fullscreenchange")));
    expect(await screen.findByRole("button", { name: "Exit full screen" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Exit full screen" }));
    expect(exit).toHaveBeenCalled();
    Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
  });

  it("changes interval on the chart and reloads the candles at that size", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    await user.click(screen.getByRole("button", { name: "5m" }));
    await waitFor(() => expect(calls.some((x) => x.url.includes("/candles/history") && new URL(x.url).searchParams.get("interval") === "5min")).toBe(true));
    expect(screen.getByTestId("chart-summary")).toHaveTextContent("NIFTY, 5m candles");
    expect(JSON.parse(localStorage.getItem("web.workstation")!).panes[0].interval).toBe("5min");
  });

  it("shows only the favourite intervals by default, with every interval in the Intervals menu, and structure detects on all but weekly", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    for (const hidden of ["30m", "1d", "1w"]) expect(screen.queryByRole("button", { name: hidden })).not.toBeInTheDocument();
    for (const shown of ["1m", "3m", "5m", "15m", "1h"]) expect(screen.getAllByRole("button", { name: shown }).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole("button", { name: /Intervals/ })[0]);
    expect(within(screen.getByRole("group", { name: "Intervals" })).getByRole("button", { name: "30m" })).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /Intervals/ })[0]); // close it again
    // the Structure dropdown only exists once the layer is switched on, from the Indicators menu
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    await user.click(screen.getByLabelText("Structure"));
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    await user.click(screen.getByRole("button", { name: /^Structure/ }));
    const menu = within(screen.getByRole("group", { name: "Structure" }));
    expect(menu.getAllByRole("button").map((b) => b.textContent).slice(0, 7)).toEqual(["1m", "3m", "5m", "15m", "30m", "1h", "1d"]);
    expect(menu.queryByRole("button", { name: "1w" })).not.toBeInTheDocument(); // order blocks are not detected that coarsely
  });

  it("opens a saved layout on a size that is not a favourite, and shows that size's button while it is on screen", async () => {
    localStorage.setItem("web.workstation", JSON.stringify({ layout: "single", panes: [{ symbol: "NIFTY", segment: "NSE", interval: "30min" }, { symbol: "BANKNIFTY", segment: "NSE", interval: "30min" }], active: 0, ticketOpen: true, links: { crosshair: true, scale: false, interval: true } }));
    renderAt("/trade");
    await loaded(0);
    expect(screen.getByTestId("chart-summary")).toHaveTextContent("NIFTY, 30m candles");
    expect(screen.getAllByRole("button", { name: "30m", pressed: true }).length).toBeGreaterThan(0);
  });

  it("restores the saved layout on the next visit", async () => {
    localStorage.setItem("web.workstation", JSON.stringify({ layout: "stack", panes: [{ symbol: "NIFTY", segment: "NSE", interval: "5min" }, { symbol: "GOLDM", segment: "MCX", interval: "5min" }], active: 1, ticketOpen: false, links: { crosshair: false, scale: true, interval: true } }));
    renderAt("/trade");
    await loaded(0);
    await waitFor(() => expect(screen.getAllByTestId("chart-pane")).toHaveLength(2));
    expect(screen.queryByTestId("ticket")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /^(1×1|2×1|1×2)/ }));
    expect(screen.getByLabelText("Sync crosshair")).not.toBeChecked();
  });
});

describe("two linked charts", () => {
  beforeEach(() => screenIs(true));
  const pair = async (user: ReturnType<typeof userEvent.setup>) => {
    renderAt("/trade?symbol=NIFTY");
    await loaded(0);
    await user.click(screen.getByRole("button", { name: /Combos/ }));
    await user.click(screen.getByRole("button", { name: "NIFTY + BANKNIFTY" }));
    await loaded(1);
  };

  it("shows NIFTY and BANKNIFTY side by side, each with its own price and candles", async () => {
    prices = { default: 1000, NIFTY: 23140.5, BANKNIFTY: 55580.4 };
    const user = userEvent.setup();
    await pair(user);
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("23,140.5"));
    await waitFor(() => expect(screen.getByTestId("price-1")).toHaveTextContent("55,580.4"));
    expect(screen.getAllByTestId("chart-pane")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "2×1" })).toBeInTheDocument(); // the layout button names the current grid
    const symbols = calls.filter((x) => x.url.includes("/candles/history")).map((x) => new URL(x.url).searchParams.get("symbol"));
    expect(symbols).toContain("BANKNIFTY");
    expect(FakeChart.instances).toHaveLength(2);
  });

  it("draws the other chart's pointer when the crosshair is linked, follows it, and removes it when the pointer leaves", async () => {
    const user = userEvent.setup();
    await pair(user);
    const [a, b] = [chart(0), chart(1)];
    const ts = a.data[5].timestamp;
    act(() => a.emit("onCrosshairChange", { paneId: "candle_pane", kLineData: { timestamp: ts } }));
    await waitFor(() => expect(b.overlaysNamed("peerCursor")).toHaveLength(1));
    expect(b.overlaysNamed("peerCursor")[0].points[0].timestamp).toBe(ts);
    expect(a.overlaysNamed("peerCursor")).toHaveLength(0); // never on the chart you are pointing at
    act(() => a.emit("onCrosshairChange", { paneId: "candle_pane", kLineData: { timestamp: a.data[8].timestamp } }));
    await waitFor(() => expect(b.overlaysNamed("peerCursor")[0].points[0].timestamp).toBe(a.data[8].timestamp));
    expect(b.overlaysNamed("peerCursor")).toHaveLength(1); // moved, not duplicated
    act(() => a.emit("onCrosshairChange", undefined));
    await waitFor(() => expect(b.overlaysNamed("peerCursor")).toHaveLength(0));
  });

  it("does not link the crosshair when that is switched off", async () => {
    const user = userEvent.setup();
    await pair(user);
    await user.click(screen.getByRole("button", { name: /^(1×1|2×1|1×2)/ }));
    await user.click(screen.getByLabelText("Sync crosshair"));
    act(() => chart(0).emit("onCrosshairChange", { paneId: "candle_pane", kLineData: { timestamp: chart(0).data[5].timestamp } }));
    expect(chart(1).overlaysNamed("peerCursor")).toHaveLength(0);
  });

  it("makes the other chart follow scrolling and zoom, once, without the two chasing each other, once that link is switched on", async () => {
    const user = userEvent.setup();
    await pair(user);
    // Off by default (see "does not link scrolling by default" below) - switch it on for this test.
    await user.click(screen.getByRole("button", { name: /^(1×1|2×1|1×2)/ }));
    await user.click(screen.getByLabelText("Sync scrolling and zoom"));
    const [a, b] = [chart(0), chart(1)];
    b.barSpace = 8;
    a.barSpace = 12; // the person zoomed chart A
    b.scrolledTo.length = 0;
    act(() => a.emit("onVisibleRangeChange"));
    await waitFor(() => expect(b.barSpace).toBe(12));
    expect(b.scrolledTo).toHaveLength(1);
    // B's own report of that change (the echo) must not bounce back to A, even if A has since moved
    a.barSpace = 3;
    const aBefore = a.scrolledTo.length;
    act(() => b.emit("onVisibleRangeChange"));
    expect(a.scrolledTo.length).toBe(aBefore);
    expect(a.barSpace).toBe(3);
  });

  it("does not link scrolling by default", async () => {
    const user = userEvent.setup();
    await pair(user);
    chart(0).barSpace = 15;
    act(() => chart(0).emit("onVisibleRangeChange"));
    expect(chart(1).barSpace).toBe(8);
  });

  it("puts both charts on the same interval while that link is on, and lets them differ when it is off", async () => {
    const user = userEvent.setup();
    await pair(user);
    const size = (i: number) => within(screen.getAllByRole("region")[i]).getByRole("button", { pressed: true, name: /^(1m|3m|5m|15m|30m|1h|1d)$/ });
    await user.click(within(screen.getByRole("group", { name: "Interval, BANKNIFTY" })).getByRole("button", { name: "5m" }));
    await waitFor(() => expect(screen.getByRole("group", { name: "Interval, NIFTY" }).querySelector('[aria-pressed="true"]')!.textContent).toBe("5m"));
    expect(size).toBeDefined();
    await user.click(screen.getByRole("button", { name: /^(1×1|2×1|1×2)/ }));
    await user.click(screen.getByLabelText("Same interval"));
    await user.click(within(screen.getByRole("group", { name: "Interval, BANKNIFTY" })).getByRole("button", { name: "1h" }));
    expect(screen.getByRole("group", { name: "Interval, NIFTY" }).querySelector('[aria-pressed="true"]')!.textContent).toBe("5m");
    expect(screen.getByRole("group", { name: "Interval, BANKNIFTY" }).querySelector('[aria-pressed="true"]')!.textContent).toBe("1h");
  });

  it("orders and drawing tools go to the chart you last clicked, and the ticket follows", async () => {
    const user = userEvent.setup();
    await pair(user);
    expect(screen.getByRole("heading", { name: "Trade NIFTY" })).toBeInTheDocument();
    const panes = screen.getAllByRole("region");
    await user.pointer({ target: panes[1], keys: "[MouseLeft]" });
    expect(await screen.findByRole("heading", { name: "Trade BANKNIFTY" })).toBeInTheDocument();
    await user.click(within(screen.getByRole("toolbar", { name: "Drawing tools" })).getByRole("button", { name: "Ray" }));
    expect(chart(1).overlaysNamed("rayLine")).toHaveLength(1);
    expect(chart(0).overlaysNamed("rayLine")).toHaveLength(0);
  });

  it("puts the plan on the active chart only", async () => {
    const user = userEvent.setup();
    await pair(user);
    const t = within(await screen.findByTestId("ticket"));
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await waitFor(() => expect(chart(0).overlaysNamed("planLine")).toHaveLength(1));
    expect(chart(1).overlaysNamed("planLine")).toHaveLength(0);
  });

  it("goes back to one chart, and keeps the first chart", async () => {
    const user = userEvent.setup();
    await pair(user);
    await pickLayout(user, "One chart");
    await waitFor(() => expect(screen.getAllByTestId("chart-pane")).toHaveLength(1));
    expect(screen.queryByLabelText("Sync crosshair")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Trade NIFTY" })).toBeInTheDocument();
  });

  it("stacks the charts on request", async () => {
    const user = userEvent.setup();
    await pair(user);
    await pickLayout(user, "Stacked");
    expect(document.querySelector(".ws-grid")!.className).toContain("layout-stack");
  });
});

describe("saved combos", () => {
  beforeEach(() => screenIs(true));
  const openCombos = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: /Combos/ }));

  it("NIFTY + BANKNIFTY is there from the start, with nothing saved yet", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded(0);
    await openCombos(user);
    expect(screen.getByRole("button", { name: "NIFTY + BANKNIFTY" })).toBeInTheDocument();
  });

  it("says Combos with the saved count until one of them is on screen, then shows that pair's name with the count", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded(0);
    const button = () => screen.getByRole("button", { name: /Combos/ });
    expect(button()).toHaveTextContent(/^Combos1 ▾$/);
    expect(button()).toHaveAccessibleName("Combos, 1 saved");

    await openCombos(user);
    await user.click(screen.getByRole("button", { name: "NIFTY + BANKNIFTY" }));
    await loaded(1);
    expect(button()).toHaveTextContent(/^NIFTY \+ BANKNIFTY1 ▾$/);
    expect(button()).toHaveAccessibleName("Combos: NIFTY + BANKNIFTY, 1 saved");

    await pickLayout(user, "One chart"); // one chart is no longer that pair
    expect(button()).toHaveTextContent(/^Combos1 ▾$/);
  });

  it("offers to save the two charts on screen once they show two different instruments, applies and removes it", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded(0);
    await openCombos(user);
    expect(screen.queryByRole("button", { name: /\+ Save/ })).not.toBeInTheDocument(); // one chart only: nothing to save yet
    await user.click(screen.getByRole("button", { name: "NIFTY + BANKNIFTY" })); // two-up, still the seeded combo
    await loaded(1);

    // Make the second chart RELIANCE instead of BANKNIFTY: click into it, then search.
    await user.pointer({ target: screen.getAllByRole("region")[1], keys: "[MouseLeft]" });
    await user.type(screen.getByRole("searchbox", { name: "Trade a stock" }), "RELIANCE");
    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(await screen.findByRole("heading", { name: "Trade RELIANCE" })).toBeInTheDocument();

    await openCombos(user);
    await user.click(screen.getByRole("button", { name: "+ Save NIFTY + RELIANCE" }));
    expect(await screen.findByRole("button", { name: "NIFTY + RELIANCE" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\+ Save/ })).not.toBeInTheDocument(); // now saved: nothing more to offer
    expect(JSON.parse(localStorage.getItem("web.workstation.combos")!)).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Remove NIFTY + RELIANCE" }));
    expect(screen.queryByRole("button", { name: "NIFTY + RELIANCE" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("web.workstation.combos")!)).toHaveLength(1);
  });

  it("removing every saved combo, including the default, leaves the menu empty rather than reseeding it", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded(0);
    await openCombos(user);
    await user.click(screen.getByRole("button", { name: "Remove NIFTY + BANKNIFTY" }));
    expect(screen.getByText("No saved combos yet.")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("web.workstation.combos")!)).toEqual([]);
  });

  it("saves the same symbol at two different intervals as its own combo, with a disambiguated label", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded(0);
    await openCombos(user);
    await user.click(screen.getByRole("button", { name: "NIFTY + BANKNIFTY" })); // two-up
    await loaded(1);

    // Make the second chart NIFTY too, then give it its own interval (unlinked first, or the
    // interval link would just snap it straight back to chart 1's own size).
    await user.pointer({ target: screen.getAllByRole("region")[1], keys: "[MouseLeft]" });
    await user.type(screen.getByRole("searchbox", { name: "Trade a stock" }), "NIFTY");
    await user.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(screen.getAllByText("NIFTY")[0]).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /^(1×1|2×1|1×2)/ }));
    await user.click(screen.getByLabelText("Same interval"));
    await user.click(within(screen.getAllByRole("group", { name: "Interval, NIFTY" })[1]).getByRole("button", { name: "1h" }));

    await openCombos(user);
    await user.click(screen.getByRole("button", { name: "+ Save NIFTY 15m + NIFTY 1h" }));
    expect(await screen.findByRole("button", { name: "NIFTY 15m + NIFTY 1h" })).toBeInTheDocument();
    const saved = JSON.parse(localStorage.getItem("web.workstation.combos")!);
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ a: { symbol: "NIFTY", interval: "15min" }, b: { symbol: "NIFTY", interval: "60min" } });
  });
});

describe("when candles will not load", () => {
  beforeEach(() => screenIs(true));

  it("says what happened, retries on its own, and shows the chart once the provider recovers", async () => {
    candleFailures = 1;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAt("/trade?symbol=NIFTY");
      expect(await screen.findByText(/Dhan candle queue is backed up/)).toBeInTheDocument();
      expect(screen.getByText("Trying again automatically.")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
      });
      const c = await loaded();
      expect(c.data.length).toBe(30);
      expect(screen.queryByText(/Dhan candle queue/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the person retry now", async () => {
    candleFailures = 1;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    try {
      renderAt("/trade?symbol=NIFTY");
      await screen.findByText(/Dhan candle queue/);
      await user.click(screen.getByRole("button", { name: "Retry now" }));
      const c = await loaded();
      expect(c.data.length).toBe(30);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying automatically after a few goes, and says so", async () => {
    candleFailures = 99;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAt("/trade?symbol=NIFTY");
      await screen.findByText(/Dhan candle queue/);
      for (let i = 0; i < 9; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(13_000);
        });
      }
      expect(await screen.findByText("Automatic retries are used up.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry now" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains a chart with no candles at all", async () => {
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (String(url).includes("/candles/history") ? json([]) : base(url, init))));
    renderAt("/trade?symbol=NIFTY");
    expect(await screen.findByText(/No candles for NIFTY at 15m/)).toBeInTheDocument();
  });
});

describe("dragging the plan lines", () => {
  beforeEach(() => screenIs(true));
  const line = (c: ReturnType<typeof chart>, label: string) => c.overlaysNamed("planLine").find((o) => o.extendData.label === label)!;

  it("moves the stop on the ticket when its line is dragged on the chart, rounded to the chart's decimals", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const t = await ticket();
    const c = await loaded();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await waitFor(() => expect(line(c, "Stop")).toBeDefined());
    const ov = line(c, "Stop");
    expect(typeof ov.handlers.onPressedMoveEnd).toBe("function"); // it can be grabbed
    act(() => c.moveOverlay(ov.id, [{ timestamp: c.data[c.data.length - 1].timestamp, value: 985.1234 }]));
    await waitFor(() => expect(t.getByLabelText("Stop-loss")).toHaveValue("985.12"));
    // the same line moved: it was not deleted and drawn again
    await waitFor(() => expect(line(c, "Stop").points[0].value).toBe(985.12));
    expect(line(c, "Stop").id).toBe(ov.id);
    expect(c.overlaysNamed("planLine")).toHaveLength(1);
  });

  it("sizes the trade from the dragged stop: the risk on the ticket follows the chart", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    const c = await loaded();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    const summary = within(t.getByTestId("summary"));
    await waitFor(() => expect(summary.getByText("₹1,000")).toBeInTheDocument());
    act(() => c.moveOverlay(line(c, "Stop").id, [{ timestamp: c.data[0].timestamp, value: 980 }]));
    await waitFor(() => expect(t.getByLabelText("Stop-loss")).toHaveValue("980"));
    expect(summary.getByText("50 (auto)")).toBeInTheDocument(); // a wider stop, a smaller size: 1% of 1,00,000 over 20
    expect(summary.getByText("₹1,000")).toBeInTheDocument(); // the same money at risk
  });

  it("drags the target the same way, and keeps both lines apart", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    const c = await loaded();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.type(t.getByLabelText("Target"), "1030");
    await waitFor(() => expect(c.overlaysNamed("planLine")).toHaveLength(2));
    act(() => c.moveOverlay(line(c, "Target").id, [{ timestamp: c.data[0].timestamp, value: 1055.5 }]));
    await waitFor(() => expect(t.getByLabelText("Target")).toHaveValue("1055.5"));
    expect(t.getByLabelText("Stop-loss")).toHaveValue("990");
  });

  it("dragging the entry of a waiting order changes its price", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    const c = await loaded();
    await user.click(t.getByRole("button", { name: "Wait for a price" }));
    await user.type(t.getByLabelText("Enter when the price reaches"), "980");
    await waitFor(() => expect(line(c, "Entry")).toBeDefined());
    act(() => c.moveOverlay(line(c, "Entry").id, [{ timestamp: c.data[0].timestamp, value: 975 }]));
    await waitFor(() => expect(t.getByLabelText("Enter when the price reaches")).toHaveValue("975"));
  });

  it("a line dragged to the wrong side is refused by the ticket, in words, and nothing is sent", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    const c = await loaded();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await waitFor(() => expect(line(c, "Stop")).toBeDefined());
    act(() => c.moveOverlay(line(c, "Stop").id, [{ timestamp: c.data[0].timestamp, value: 1020 }]));
    expect(await t.findByText(/stop-loss must be below/)).toBeInTheDocument();
    expect(t.getByRole("button", { name: /Buy RELIANCE/ })).toBeDisabled();
  });

  it("keeps one overlay per level when the ticket is edited by hand, moving it rather than redrawing", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    const c = await loaded();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await waitFor(() => expect(line(c, "Stop")).toBeDefined());
    const id = line(c, "Stop").id;
    fireEvent.change(t.getByLabelText("Stop-loss"), { target: { value: "985" } }); // one edit, so the field is never empty in between
    await waitFor(() => expect(line(c, "Stop").points[0].value).toBe(985));
    expect(line(c, "Stop").id).toBe(id);
    await user.clear(t.getByLabelText("Stop-loss"));
    await waitFor(() => expect(c.overlaysNamed("planLine")).toHaveLength(0)); // a cleared field removes its line
  });

  it("draws the lines again, once each, when the interval changes", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    const c = await loaded();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.type(t.getByLabelText("Target"), "1030");
    await waitFor(() => expect(c.overlaysNamed("planLine")).toHaveLength(2));
    const applied = c.applyCalls;
    await user.click(screen.getByRole("button", { name: "5m" }));
    await waitFor(() => expect(c.applyCalls).toBeGreaterThan(applied));
    await waitFor(() => expect(c.overlaysNamed("planLine").map((o) => o.extendData.label).sort()).toEqual(["Stop", "Target"]));
  });

  it("adds a starting line on the right side of the price for the order, ready to drag", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    const c = await loaded();
    await user.click(t.getByRole("button", { name: "Add stop line" }));
    expect(t.getByLabelText("Stop-loss")).toHaveValue("988.29"); // one typical bar-move (11.71 on these candles) against the trade
    await user.click(t.getByRole("button", { name: "Add target line" }));
    expect(t.getByLabelText("Target")).toHaveValue("1023.43"); // two in its favour
    await waitFor(() => expect(c.overlaysNamed("planLine").map((o) => o.extendData.label).sort()).toEqual(["Stop", "Target"]));
    // the button goes away once the field has a value: there is a line to drag
    expect(t.queryByRole("button", { name: "Add stop line" })).not.toBeInTheDocument();
  });

  it("puts the starting line the other side of the price for a sell, and for a waiting entry", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.click(t.getByRole("button", { name: "Sell" }));
    await user.click(t.getByRole("button", { name: "Add stop line" }));
    expect(t.getByLabelText("Stop-loss")).toHaveValue("1011.71");
    await user.click(t.getByRole("button", { name: "Wait for a price" }));
    await user.click(t.getByRole("button", { name: "Add entry line" }));
    expect(t.getByLabelText("Enter when the price reaches")).toHaveValue("1005.86"); // half a bar-move back
  });

  it("offers no starting line until there is a price to base it on", async () => {
    ltpFails = true;
    renderAt("/trade?symbol=RELIANCE");
    await loaded();
    await waitFor(() => expect(calls.some((x) => x.url.includes("/quotes/ltp"))).toBe(true));
    expect(screen.getByTestId("price-0")).toHaveTextContent("–");
    expect(screen.queryByRole("button", { name: "Add stop line" })).not.toBeInTheDocument();
  });

  it("resets a price once it is set: the field empties, its line leaves the chart, and Add line comes back", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    const c = await loaded();
    expect(t.queryByRole("button", { name: "Reset stop" })).not.toBeInTheDocument(); // nothing to reset yet
    await user.click(t.getByRole("button", { name: "Add stop line" }));
    await user.click(t.getByRole("button", { name: "Add target line" }));
    await waitFor(() => expect(c.overlaysNamed("planLine")).toHaveLength(2));

    await user.click(t.getByRole("button", { name: "Reset stop" }));

    expect(t.getByLabelText("Stop-loss")).toHaveValue("");
    await waitFor(() => expect(c.overlaysNamed("planLine").map((o) => o.extendData.label)).toEqual(["Target"]));
    expect(t.getByRole("button", { name: "Add stop line" })).toBeInTheDocument();
    expect(t.getByLabelText("Target")).not.toHaveValue(""); // the other price is left alone
  });

  it("lines exist only on the active chart, so a drag on one cannot touch the other's ticket", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded(0);
    await user.click(screen.getByRole("button", { name: /Combos/ }));
    await user.click(screen.getByRole("button", { name: "NIFTY + BANKNIFTY" }));
    await loaded(1);
    const t = within(await screen.findByTestId("ticket"));
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await waitFor(() => expect(chart(0).overlaysNamed("planLine")).toHaveLength(1));
    expect(chart(1).overlaysNamed("planLine")).toHaveLength(0);
  });
});

describe("your trades on the chart", () => {
  beforeEach(() => screenIs(true));
  const step = 15 * 60_000;
  const newest = () => Math.floor(Date.now() / step) * step;
  const iso = (barsBack: number) => new Date(newest() - barsBack * step).toISOString();
  const position = (over: Record<string, any>) => ({
    id: "p1", symbol: "RELIANCE", exchange: "NSE", segment: "NSE", action: "BUY", instrument_type: "spot", quantity: 10, entry_price: 1010, entry_time: iso(8),
    exit_price: null, exit_time: null, pnl: null, unrealized_pnl: 250, status: "OPEN", option_group_id: null, stop_loss_price: null, target_price: null, ...over,
  });
  const markers = (c: ReturnType<typeof chart>) => c.overlaysNamed("tradeMarker");

  it("draws an open trade as an entry with its live result, and a closed one as entry to exit", async () => {
    positionRows = [
      position({}),
      position({ id: "p2", action: "SELL", entry_price: 1020, entry_time: iso(20), exit_price: 1005, exit_time: iso(12), pnl: 150, status: "CLOSED", exit_reason: "target_hit", unrealized_pnl: null }),
    ];
    renderAt("/trade?symbol=RELIANCE");
    const c = await loaded();
    await waitFor(() => expect(markers(c)).toHaveLength(2));
    const open = markers(c).find((o) => o.extendData.state === "open")!;
    expect(open.extendData).toMatchObject({ side: "long", pnl: 250, label: "Long 10", entryPrice: 1010 });
    expect(open.points).toEqual([{ timestamp: Date.parse(iso(8)), value: 1010 }]);
    const closed = markers(c).find((o) => o.extendData.state === "closed")!;
    expect(closed.extendData).toMatchObject({ side: "short", pnl: 150, reason: "target_hit" });
    expect(closed.points).toEqual([{ timestamp: Date.parse(iso(20)), value: 1020 }, { timestamp: Date.parse(iso(12)), value: 1005 }]);
    expect(screen.getByTestId("chart-summary")).toHaveTextContent(/Your trades on this chart: Long 10 \(open\), Short 10/);
  });

  it("asks for the open trades with their live result, and only the segment on screen", async () => {
    renderAt("/trade?symbol=RELIANCE");
    await loaded();
    await waitFor(() => expect(calls.some((c) => c.url.includes("/positions?segment=NSE&status=OPEN&with_live_pnl=true"))).toBe(true));
    expect(calls.some((c) => c.url.includes("segment=MCX"))).toBe(false);
  });

  it("shows only this instrument's trades: a futures contract yes, another stock or a lookalike name no", async () => {
    positionRows = [
      position({ id: "a", symbol: "RELIANCE" }),
      position({ id: "b", symbol: "RELIANCEX" }),
      position({ id: "c", symbol: "TCS" }),
      position({ id: "d", symbol: "RELIANCE-Sep2026-FUT", instrument_type: "future" }),
      position({ id: "e", symbol: "RELIANCE26SEP2500CE", option_group_id: "g9" }),
    ];
    renderAt("/trade?symbol=RELIANCE");
    const c = await loaded();
    await waitFor(() => expect(markers(c).length).toBeGreaterThan(0));
    expect(markers(c)).toHaveLength(2);
  });

  it("puts an option trade at the underlying's price when it opened, as a diamond with its result", async () => {
    groupRows = [{
      id: "g1", underlying_symbol: "NIFTY", strategy_type: "naked_call", action: "BUY", quantity: 1, status: "OPEN", pnl: null, unrealized_pnl: -300,
      entry_time: iso(6), exit_time: null, entry_spot_price: 1012, segment: "NSE",
    }];
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    await waitFor(() => expect(markers(c)).toHaveLength(1));
    expect(markers(c)[0].extendData).toMatchObject({ kind: "option", label: "Naked Call", entryPrice: 1012, pnl: -300 });
  });

  it("leaves out a trade from before the first candle, which has nowhere to go", async () => {
    positionRows = [position({ id: "old", entry_time: iso(400) }), position({ id: "new" })];
    renderAt("/trade?symbol=RELIANCE");
    const c = await loaded();
    await waitFor(() => expect(markers(c)).toHaveLength(1));
    expect(markers(c)[0].extendData.label).toBe("Long 10");
  });

  it("keeps the closed trades on the chart when the live results are unavailable", async () => {
    tradeCallsFail = true;
    positionRows = [position({ id: "p2", entry_price: 1020, exit_price: 1005, exit_time: iso(4), pnl: 90, status: "CLOSED", unrealized_pnl: null }), position({})];
    renderAt("/trade?symbol=RELIANCE");
    const c = await loaded();
    await waitFor(() => expect(markers(c)).toHaveLength(1));
    expect(markers(c)[0].extendData.state).toBe("closed");
  });

  it("the My trades toggle takes them off the chart and back, and remembers the choice", async () => {
    const user = userEvent.setup();
    positionRows = [position({})];
    renderAt("/trade?symbol=RELIANCE");
    const c = await loaded();
    await waitFor(() => expect(markers(c)).toHaveLength(1));
    const box = screen.getByRole("button", { name: "My trades" });
    expect(box).toHaveAttribute("aria-pressed", "true");
    await user.click(box);
    await waitFor(() => expect(markers(c)).toHaveLength(0));
    expect(box).toHaveAttribute("aria-pressed", "false");
    expect(JSON.parse(localStorage.getItem("web.chart.tools") ?? "{}").tradesOn).toBe(false);
    await user.click(box);
    await waitFor(() => expect(markers(c)).toHaveLength(1));
  });

  it("each chart of a pair shows its own instrument's trades", async () => {
    const user = userEvent.setup();
    positionRows = [position({ id: "n", symbol: "NIFTY-Sep2026-FUT", instrument_type: "future" }), position({ id: "b", symbol: "BANKNIFTY-Sep2026-FUT", instrument_type: "future", action: "SELL" })];
    renderAt("/trade?symbol=NIFTY");
    await loaded(0);
    await user.click(screen.getByRole("button", { name: /Combos/ }));
    await user.click(screen.getByRole("button", { name: "NIFTY + BANKNIFTY" }));
    await loaded(1);
    await waitFor(() => expect(markers(chart(0))).toHaveLength(1));
    await waitFor(() => expect(markers(chart(1))).toHaveLength(1));
    expect(markers(chart(0))[0].extendData.side).toBe("long");
    expect(markers(chart(1))[0].extendData.side).toBe("short");
  });
});

describe("the view toggles at the end of the top bar", () => {
  beforeEach(() => screenIs(true));
  const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

  it("are icon buttons, each named for what it switches and pressed when on - trades and the ticket on by default, OI levels off", async () => {
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    const group = within(screen.getByRole("group", { name: "View" }));
    expect(group.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["OI levels", "My trades", "Price in header", "Show ticket"]);
    expect(group.getAllByRole("button").every((b) => b.textContent === "")).toBe(true); // icons, not words
    expect([pressed("OI levels"), pressed("My trades"), pressed("Price in header"), pressed("Show ticket")]).toEqual(["false", "true", "true", "true"]);
  });

  it("say on or off in their tooltips, and flip when clicked", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    expect(screen.getByRole("button", { name: "OI levels" })).toHaveAttribute("title", expect.stringMatching(/\(off\)$/));
    await user.click(screen.getByRole("button", { name: "OI levels" }));
    expect(pressed("OI levels")).toBe("true");
    expect(screen.getByRole("button", { name: "OI levels" })).toHaveAttribute("title", expect.stringMatching(/\(on\)$/));
    await user.click(screen.getByRole("button", { name: "Show ticket" }));
    expect(pressed("Show ticket")).toBe("false");
  });

  it("hides the header's live price, and it comes back the same way", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    expect(screen.getByTestId("price-0")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Price in header" }));
    expect(screen.queryByTestId("price-0")).not.toBeInTheDocument();
    expect(pressed("Price in header")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Price in header" }));
    expect(screen.getByTestId("price-0")).toBeInTheDocument();
  });

  it("are one row with the rest of the top bar - there is no second row any more", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    await pickLayout(user, "Side by side");
    expect(screen.queryByTestId("agreement")).not.toBeInTheDocument();
    expect(document.querySelector(".ws-links")).toBeNull();
    expect(screen.getByRole("group", { name: "View" }).closest(".ws-bar")).not.toBeNull();
  });

  it("have no ticket switch on a phone: there is nothing to toggle, the ticket is always shown", async () => {
    screenIs(false);
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    expect(screen.queryByRole("button", { name: "Show ticket" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "My trades" })).toBeInTheDocument();
  });
});

describe("option-chain levels on the chart", () => {
  beforeEach(() => screenIs(true));
  const levels = (c: ReturnType<typeof chart>) => c.overlaysNamed("oiLevel");
  const oiCalls = () => calls.filter((c) => c.url.includes("/options/"));

  it("draws no lines on the chart until asked for, even though the strip below already reads the chain", async () => {
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    expect(screen.getByRole("button", { name: "OI levels" })).toHaveAttribute("aria-pressed", "false");
    expect(levels(c)).toHaveLength(0);
    await waitFor(() => expect(oiCalls().length).toBeGreaterThan(0)); // the always-on strip below the chart
    expect(await screen.findByTestId("oi-strip")).toBeInTheDocument();
  });

  it("draws resistance above and support below from the nearest expiry once switched on", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    await user.click(screen.getByRole("button", { name: "OI levels" }));
    await waitFor(() => expect(levels(c).length).toBeGreaterThan(0));
    const lines = levels(c).map((o) => o.extendData);
    expect(lines.find((l) => l.kind === "resistance" && l.rank === 1)).toMatchObject({ price: 1020, label: "R1 1020 · 80.00L OI" });
    expect(lines.find((l) => l.kind === "support" && l.rank === 1)).toMatchObject({ price: 960 });
    expect(lines.find((l) => l.forming)).toMatchObject({ kind: "support", price: 990 });
    expect(calls.find((x) => x.url.includes("/options/oi-summary"))!.url).toContain("expiry=2026-09-29"); // the nearest
    expect(screen.getByTestId("chart-summary")).toHaveTextContent(/Option-chain levels: /);
    expect(JSON.parse(localStorage.getItem("web.chart.tools") ?? "{}").oiLevelsOn).toBe(true);
  });

  it("takes the lines off again, and stops asking", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    const box = screen.getByRole("button", { name: "OI levels" });
    await user.click(box);
    await waitFor(() => expect(levels(c).length).toBeGreaterThan(0));
    await user.click(box);
    await waitFor(() => expect(levels(c)).toHaveLength(0));
  });

  it("asks for nothing on an instrument with no option chain, and shows no strip", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const c = await loaded();
    await user.click(screen.getByRole("button", { name: "OI levels" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(levels(c)).toHaveLength(0);
    expect(oiCalls()).toHaveLength(0);
    expect(screen.queryByTestId("oi-strip")).not.toBeInTheDocument();
  });

  it("looks up the expiry once and reuses it, and again after a failed reading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderAt("/trade?symbol=NIFTY");
      const c = await loaded();
      await user.click(screen.getByRole("button", { name: "OI levels" }));
      await waitFor(() => expect(levels(c).length).toBeGreaterThan(0));
      await act(async () => void vi.advanceTimersByTime(60_500));
      await waitFor(() => expect(calls.filter((x) => x.url.includes("/options/oi-summary")).length).toBe(2));
      expect(calls.filter((x) => x.url.includes("/options/expiries"))).toHaveLength(1);
      oiFails = true;
      await act(async () => void vi.advanceTimersByTime(60_500));
      await waitFor(() => expect(calls.filter((x) => x.url.includes("/options/oi-summary")).length).toBe(3));
      oiFails = false;
      await act(async () => void vi.advanceTimersByTime(60_500));
      await waitFor(() => expect(calls.filter((x) => x.url.includes("/options/expiries"))).toHaveLength(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the last good lines when a refresh fails", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const c = await loaded();
    await user.click(screen.getByRole("button", { name: "OI levels" }));
    await waitFor(() => expect(levels(c).length).toBeGreaterThan(0));
    const n = levels(c).length;
    oiFails = true;
    await new Promise((r) => setTimeout(r, 100));
    expect(levels(c)).toHaveLength(n);
  });

  it("each chart of a pair draws the levels of its own chain", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded(0);
    await user.click(screen.getByRole("button", { name: /Combos/ }));
    await user.click(screen.getByRole("button", { name: "NIFTY + BANKNIFTY" }));
    await loaded(1);
    await user.click(screen.getByRole("button", { name: "OI levels" }));
    await waitFor(() => expect(levels(chart(0)).length).toBeGreaterThan(0));
    await waitFor(() => expect(levels(chart(1)).length).toBeGreaterThan(0));
    const asked = calls.filter((x) => x.url.includes("/options/oi-summary")).map((x) => new URL(x.url).searchParams.get("symbol"));
    expect(asked).toContain("NIFTY");
    expect(asked).toContain("BANKNIFTY");
  });
});

describe("the OI strip under the chart", () => {
  beforeEach(() => screenIs(true));
  const strip = () => within(screen.getByTestId("oi-strip"));

  it("shows PCR, call/put OI and support/resistance for an eligible instrument, with no toggle needed", async () => {
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    const s = strip();
    expect(s.getByText("1.00")).toBeInTheDocument(); // PCR
    expect(s.getByText(/CE OI/)).toBeInTheDocument();
    expect(s.getByText(/PE OI/)).toBeInTheDocument();
    expect(s.getByText(/1,020/)).toBeInTheDocument(); // resistance
    expect(s.getByText(/960/)).toBeInTheDocument(); // support
  });

  it("hides the R/S text once the chart is already drawing those same levels", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    expect(strip().getByText(/1,020/)).toBeInTheDocument(); // resistance, shown by default
    await user.click(screen.getByRole("button", { name: "OI levels" }));
    await waitFor(() => expect(strip().queryByText(/1,020/)).not.toBeInTheDocument());
    expect(strip().queryByText(/960/)).not.toBeInTheDocument(); // support, same
    expect(strip().getByText(/CE OI/)).toBeInTheDocument(); // everything else stays
  });

  it("shows a buildup badge for each side that has one", async () => {
    oiBuildups = { call: "long_buildup", put: "short_covering" };
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    const s = strip();
    expect(s.getByText(/CE LB/)).toBeInTheDocument();
    expect(s.getByText(/PE SC/)).toBeInTheDocument();
  });

  it("shows the OI-trend sparklines once there is sentiment history, and not before", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAt("/trade?symbol=NIFTY");
      await loaded();
      const s = strip();
      expect(s.queryByTestId("oi-sent-5m")).not.toBeInTheDocument();
      const now = Date.now();
      sentHistPoints = [
        { recorded_at: new Date(now - 5 * 60_000).toISOString(), score_5m: 0.1, score_15m: 0.1 },
        { recorded_at: new Date(now).toISOString(), score_5m: 0.15, score_15m: 0.12 },
      ];
      await act(async () => void vi.advanceTimersByTime(60_500));
      await waitFor(() => expect(strip().getByTestId("oi-sent-5m")).toBeInTheDocument());
      expect(strip().getByTestId("oi-sent-5m")).toHaveTextContent("+0.15%");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows nothing before the first reading arrives, and nothing for a stock", async () => {
    renderAt("/trade?symbol=RELIANCE");
    await loaded();
    expect(screen.queryByTestId("oi-strip")).not.toBeInTheDocument();
  });

  it("each chart of a pair shows its own strip", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded(0);
    await user.click(screen.getByRole("button", { name: /Combos/ }));
    await user.click(screen.getByRole("button", { name: "NIFTY + BANKNIFTY" }));
    await loaded(1);
    await waitFor(() => expect(screen.getAllByTestId("oi-strip")).toHaveLength(2));
  });
});

describe("alerts on drawings", () => {
  beforeEach(() => screenIs(true));
  const KEY = "web.chart.drawings:NSE:RELIANCE";
  const saved = () => JSON.parse(localStorage.getItem(KEY) ?? "[]");
  const level = (value: number, extra: object = {}) => ({ name: "horizontalStraightLine", points: [{ value }], ...extra });
  const band = (a: number, b: number, extra: object = {}) => ({ name: "rect", points: [{ timestamp: Date.now() - 3_600_000, value: a }, { timestamp: Date.now() - 1_800_000, value: b }], ...extra });

  async function open(drawings: object[], names = drawings.map((d: any) => d.name)) {
    localStorage.setItem(KEY, JSON.stringify(drawings));
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    const c = await loaded();
    await waitFor(() => expect(names.every((n) => c.overlaysNamed(n).length > 0)).toBe(true));
    const socket = await (async () => {
      await waitFor(() => expect(FakeWebSocket.last).toBeDefined());
      act(() => FakeWebSocket.last!.open());
      await waitFor(() => expect(FakeWebSocket.last!.sent.length).toBeGreaterThan(0));
      return FakeWebSocket.last!;
    })();
    const tick = (price: number) => act(() => socket.push({ type: "tick", exchange: "NSE", symbol: "RELIANCE", price }));
    const select = (name: string) => act(() => c.select(c.overlaysNamed(name)[0].id));
    return { c, tick, select };
  }
  const bar = () => screen.getByRole("group", { name: "Alerts on drawings" });
  const flash = () => screen.queryByTestId("alert-flash");

  it("offers an alert on a selected line, reading out its level, and says it works only while the page is open", async () => {
    const { select } = await open([level(1015)]);
    expect(screen.queryByRole("group", { name: "Alerts on drawings" })).not.toBeInTheDocument(); // nothing selected, nothing armed
    select("horizontalStraightLine");
    expect(within(bar()).getByText("1,015")).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: "Alert me" })).toHaveAttribute("aria-pressed", "false");
    expect(within(bar()).getByText(/only while this page is open/)).toBeInTheDocument();
  });

  it("arms it, keeps it with the drawing, and counts it", async () => {
    const user = userEvent.setup();
    const { select } = await open([level(1015)]);
    select("horizontalStraightLine");
    await user.click(within(bar()).getByRole("button", { name: "Alert me" }));
    expect(within(bar()).getByRole("button", { name: "Alert on" })).toHaveAttribute("aria-pressed", "true");
    expect(within(bar()).getByRole("button", { name: "As it crosses" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("armed")).toHaveTextContent("1 alert armed");
    expect(saved()[0].alert).toEqual({ trigger: "cross" });
  });

  it("tells the person when the price crosses the line, once, and not before", async () => {
    const user = userEvent.setup();
    const { select, tick } = await open([level(1015)]);
    select("horizontalStraightLine");
    await user.click(within(bar()).getByRole("button", { name: "Alert me" }));
    tick(1010);
    tick(1014.9);
    expect(flash()).not.toBeInTheDocument();
    tick(1016);
    expect(await screen.findByTestId("alert-flash")).toHaveTextContent("RELIANCE ▲ crossed above 1,015");
    await user.click(within(flash()!).getByRole("button", { name: "Dismiss" }));
    tick(1020);
    tick(1030);
    expect(flash()).not.toBeInTheDocument(); // still on the same side: nothing more to say
    tick(1010);
    expect(await screen.findByTestId("alert-flash")).toHaveTextContent("RELIANCE ▼ crossed below 1,015"); // and back again is another crossing
  });

  it("arming starts from where the price is now, so a price already past the line does not fire", async () => {
    const user = userEvent.setup();
    const { select, tick } = await open([level(990)]); // the price is 1,000: already above it
    select("horizontalStraightLine");
    await user.click(within(bar()).getByRole("button", { name: "Alert me" }));
    tick(1005);
    tick(1050);
    expect(flash()).not.toBeInTheDocument();
    tick(985);
    expect(await screen.findByTestId("alert-flash")).toHaveTextContent("▼ crossed below 990");
  });

  it("watches a zone: entering it, and leaving it", async () => {
    const user = userEvent.setup();
    const { select, tick } = await open([band(1010, 1020)]);
    select("rect");
    expect(within(bar()).getByText("1,010 to 1,020")).toBeInTheDocument();
    await user.click(within(bar()).getByRole("button", { name: "Alert me" }));
    tick(1012);
    expect(await screen.findByTestId("alert-flash")).toHaveTextContent("RELIANCE entered the zone 1,010–1,020");
    tick(1025);
    await waitFor(() => expect(screen.getByTestId("alert-flash")).toHaveTextContent("left the zone ▲ 1,010–1,020"));
  });

  it("watches a diagonal line where it is now", async () => {
    const user = userEvent.setup();
    const t = Date.now();
    // 1,000 an hour ago rising to 1,020 now-ish: about 1,020 at this moment, and rising 20 an hour
    const { select, tick } = await open([{ name: "rayLine", points: [{ timestamp: t - 3_600_000, value: 1000 }, { timestamp: t, value: 1020 }] }]);
    select("rayLine");
    await user.click(within(bar()).getByRole("button", { name: "Alert me" }));
    tick(1010); // below the line
    tick(1040); // above it
    expect(await screen.findByTestId("alert-flash")).toHaveTextContent("▲ crossed above");
  });

  it("on a candle close waits for the candle to finish across the line, and a wick through it does not count", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup();
      const { select, tick } = await open([level(1015)]);
      select("horizontalStraightLine");
      await user.click(within(bar()).getByRole("button", { name: "Alert me" }));
      await user.click(within(bar()).getByRole("button", { name: "On a candle close" }));
      expect(saved()[0].alert).toEqual({ trigger: "close" });
      tick(1020); // across, mid-candle
      expect(flash()).not.toBeInTheDocument();
      tick(1010); // wick back: the candle will close below it
      vi.setSystemTime(Date.now() + 16 * 60_000);
      tick(1011); // the next candle starts: the last one closed at 1,010, below the line
      expect(flash()).not.toBeInTheDocument();
      tick(1022);
      vi.setSystemTime(Date.now() + 16 * 60_000);
      tick(1023); // that candle closed at 1,022: above
      expect(await screen.findByTestId("alert-flash")).toHaveTextContent("RELIANCE ▲ closed above 1,015");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a restored on-a-close alert already knows which side the price was on, so the first close across the line counts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { tick } = await open([level(1015, { alert: { trigger: "close" } })]); // the price is 1,000: below
      tick(1020);
      vi.setSystemTime(Date.now() + 16 * 60_000);
      tick(1021); // the candle that closed at 1,020 finished above the line
      expect(await screen.findByTestId("alert-flash")).toHaveTextContent("▲ closed above 1,015");
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns off again, and the drawing forgets the alert", async () => {
    const user = userEvent.setup();
    const { select, tick } = await open([level(1015, { alert: { trigger: "cross" } })]);
    select("horizontalStraightLine");
    expect(screen.getByTestId("armed")).toHaveTextContent("1 alert armed");
    await user.click(within(bar()).getByRole("button", { name: "Alert on" }));
    expect(screen.queryByTestId("armed")).not.toBeInTheDocument();
    expect(saved()[0].alert).toBeUndefined();
    tick(1016);
    expect(flash()).not.toBeInTheDocument();
  });

  it("remembers an armed alert across a reload, showing that one is armed without selecting anything", async () => {
    const { tick } = await open([level(1015, { alert: { trigger: "cross" } })]);
    expect(screen.getByTestId("armed")).toHaveTextContent("1 alert armed");
    tick(1010);
    tick(1020);
    expect(await screen.findByTestId("alert-flash")).toHaveTextContent("▲ crossed above 1,015");
  });

  it("does not fire for the price already being across a restored line: it only learns the side first", async () => {
    const { tick } = await open([level(990, { alert: { trigger: "cross" } })]);
    tick(1005);
    tick(1030);
    expect(flash()).not.toBeInTheDocument();
  });

  it("moving an armed drawing does not set it off: it learns its new side", async () => {
    const user = userEvent.setup();
    const { c, select, tick } = await open([level(1015, { alert: { trigger: "cross" } })]);
    tick(1010); // below 1,015
    select("horizontalStraightLine");
    // drag the line down through the price to 1,005: the price is now above it, which is not a crossing
    act(() => c.moveOverlay(c.overlaysNamed("horizontalStraightLine")[0].id, [{ timestamp: c.data[0].timestamp, value: 1005 }]));
    tick(1011);
    expect(flash()).not.toBeInTheDocument();
    expect(saved()[0].alert).toEqual({ trigger: "cross" }); // still armed, at the new level
    expect(within(bar()).getByText("1,005")).toBeInTheDocument();
    tick(1000);
    expect(await screen.findByTestId("alert-flash")).toHaveTextContent("▼ crossed below 1,005");
    void user;
  });

  it("removing an armed drawing removes its alert", async () => {
    const user = userEvent.setup();
    const { c, select, tick } = await open([level(1015, { alert: { trigger: "cross" } })]);
    tick(1010);
    select("horizontalStraightLine");
    await user.click(screen.getByRole("button", { name: "Delete selected drawing" }));
    await waitFor(() => expect(c.overlaysNamed("horizontalStraightLine")).toHaveLength(0));
    expect(screen.queryByTestId("armed")).not.toBeInTheDocument();
    tick(1020);
    expect(flash()).not.toBeInTheDocument();
  });

  it("offers no alert on a drawing that has no price to watch", async () => {
    const { select } = await open([{ name: "fibonacciLine", points: [{ timestamp: Date.now() - 3_600_000, value: 1000 }, { timestamp: Date.now() - 1_800_000, value: 1020 }] }]);
    select("fibonacciLine");
    expect(screen.queryByRole("button", { name: "Alert me" })).not.toBeInTheDocument();
  });

  it("drops an alert setting it does not understand, rather than trusting it", async () => {
    const { select } = await open([level(1015, { alert: { trigger: "sometimes" } })]);
    expect(screen.queryByTestId("armed")).not.toBeInTheDocument();
    select("horizontalStraightLine");
    expect(within(bar()).getByRole("button", { name: "Alert me" })).toHaveAttribute("aria-pressed", "false");
  });

  it("each chart of a pair watches its own instrument's drawings", async () => {
    const user = userEvent.setup();
    localStorage.setItem("web.chart.drawings:NSE:NIFTY", JSON.stringify([level(1015, { alert: { trigger: "cross" } })]));
    localStorage.setItem("web.chart.drawings:NSE:BANKNIFTY", JSON.stringify([level(1016, { alert: { trigger: "cross" } }), level(1017, { alert: { trigger: "close" } })]));
    renderAt("/trade?symbol=NIFTY");
    await loaded(0);
    await user.click(screen.getByRole("button", { name: /Combos/ }));
    await user.click(screen.getByRole("button", { name: "NIFTY + BANKNIFTY" }));
    await loaded(1);
    await waitFor(() => expect(screen.getByTestId("armed")).toHaveTextContent("3 alerts armed"));
    await pickLayout(user, "One chart");
    await waitFor(() => expect(screen.getByTestId("armed")).toHaveTextContent("1 alert armed")); // the hidden chart's are not counted
  });
});

describe("the auto-trader on the trade screen", () => {
  beforeEach(() => screenIs(true));

  it("is hidden by default, and asks the server for nothing", async () => {
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    expect(screen.queryByTestId("auto-trader")).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/strategies") || c.url.includes("/indicators") || c.url.includes("/rules"))).toBe(false);
  });

  it("is offered for the instrument on the chart when it has contracts, and follows the active chart, once turned on in Settings", async () => {
    localStorage.setItem("web.autotrader.visible", "true");
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    // Shares the aside with the ticket, as a tab - not shown side by side, to save the width.
    await user.click(screen.getByRole("tab", { name: "Auto-trader" }));
    const card = within(await screen.findByTestId("auto-trader"));
    expect(card.getByRole("heading", { name: "Auto-trader · NIFTY" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Bank Nifty" }));
    expect(await screen.findByRole("heading", { name: "Auto-trader · BANKNIFTY" })).toBeInTheDocument();
  });

  it("says it is not available for a stock, once turned on", async () => {
    localStorage.setItem("web.autotrader.visible", "true");
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    await loaded();
    await user.click(screen.getByRole("tab", { name: "Auto-trader" }));
    expect(await screen.findByText(/A stock is traded as shares/)).toBeInTheDocument();
    expect(screen.queryByTestId("auto-trader")).not.toBeInTheDocument();
  });

  it("starts on the Manual tab, with the ticket, and only the auto-trader tab shows its panel", async () => {
    localStorage.setItem("web.autotrader.visible", "true");
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    expect(screen.getByTestId("ticket")).toBeInTheDocument();
    expect(screen.queryByTestId("auto-trader")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Manual" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Auto-trader" })).toHaveAttribute("aria-selected", "false");
  });

  it("has no tab strip at all when the auto-trader is off - just the ticket, as before", async () => {
    renderAt("/trade?symbol=NIFTY");
    await loaded();
    expect(screen.queryByRole("tab", { name: "Manual" })).not.toBeInTheDocument();
    expect(screen.getByTestId("ticket")).toBeInTheDocument();
  });
});

describe("moving the stop and target of open trades", () => {
  beforeEach(() => screenIs(true));
  const step = 15 * 60_000;
  const iso = (barsBack: number) => new Date(Math.floor(Date.now() / step) * step - barsBack * step).toISOString();
  const long = (over: Record<string, any> = {}) => ({
    id: "p1", symbol: "RELIANCE", exchange: "NSE", segment: "NSE", action: "BUY", instrument_type: "spot", quantity: 10, entry_price: 1010, entry_time: iso(8),
    exit_price: null, exit_time: null, pnl: null, unrealized_pnl: -100, status: "OPEN", option_group_id: null, stop_loss_price: 990, target_price: 1030, ...over,
  });
  const lines = (c: ReturnType<typeof chart>) => c.overlaysNamed("planLine").filter((o) => /^(position|group):/.test(o.extendData.key));
  const line = (c: ReturnType<typeof chart>, key: string) => lines(c).find((o) => o.extendData.key === key)!;
  const drag = (c: ReturnType<typeof chart>, key: string, value: number) => act(() => c.moveOverlay(line(c, key).id, [{ timestamp: c.data[c.data.length - 1].timestamp, value }]));
  const puts = (part: string) => calls.filter((c) => c.method === "PUT" && c.url.includes(part));

  it("draws the stop and target of an open trade, named for it, and nothing for a closed one or for a level that is not set", async () => {
    positionRows = [long(), long({ id: "old", status: "CLOSED", pnl: 5 }), long({ id: "nostop", stop_loss_price: null, target_price: 1040 })];
    renderAt("/trade?symbol=RELIANCE");
    const c = await loaded();
    await waitFor(() => expect(lines(c)).toHaveLength(3));
    expect(lines(c).map((o) => [o.extendData.key, o.extendData.label, o.points[0].value]).sort()).toEqual([
      ["position:nostop:target", "Target · Long 10", 1040],
      ["position:p1:stop", "Stop · Long 10", 990],
      ["position:p1:target", "Target · Long 10", 1030],
    ]);
    expect(screen.getByTestId("chart-summary")).toHaveTextContent(/Stops and targets of open trades: Stop · Long 10 990/);
  });

  it("dragging the stop saves it, says so, and the line stays where it was put", async () => {
    positionRows = [long()];
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    const c = await loaded();
    await waitFor(() => expect(lines(c)).toHaveLength(2));
    const id = line(c, "position:p1:stop").id;
    drag(c, "position:p1:stop", 985.1234);
    await waitFor(() => expect(puts("/positions/p1/stop-loss")).toHaveLength(1));
    expect(puts("/positions/p1/stop-loss")[0].body).toEqual({ stop_loss_price: 985.12 });
    expect(await screen.findByTestId("level-note")).toHaveTextContent("Stop-loss moved to 985.12.");
    await waitFor(() => expect(line(c, "position:p1:stop").points[0].value).toBe(985.12)); // the reload confirms it
    expect(line(c, "position:p1:stop").id).toBe(id); // the same line, not a new one
  });

  it("an open trade with no target offers Add line and Pick on chart, and Add line saves a target on the winning side", async () => {
    positionRows = [long({ target_price: null })];
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    await loaded();
    const card = within(await screen.findByTestId("position-card"));
    expect(card.queryByRole("button", { name: "Add stop line" })).not.toBeInTheDocument(); // the stop is set: nothing to add
    expect(card.getByRole("button", { name: "Pick stop on chart" })).toBeInTheDocument();

    await user.click(card.getByRole("button", { name: "Add target line" }));

    await waitFor(() => expect(puts("/positions/p1/target")).toHaveLength(1));
    const saved = (puts("/positions/p1/target")[0].body as { target_price: number }).target_price;
    expect(saved).toBe(1023.43); // a long's target above the price, two typical bar-moves (11.71 on these candles) away
  });

  it("Pick on chart arms the chart, and the next click saves that price as the open trade's target", async () => {
    positionRows = [long({ target_price: null })];
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    const c = await loaded();
    const card = within(await screen.findByTestId("position-card"));

    await user.click(card.getByRole("button", { name: "Pick target on chart" }));
    expect(card.getByRole("button", { name: "Pick target on chart" })).toHaveTextContent("Click the chart…");
    act(() => c.emit("onCrosshairChange", { paneId: "candle_pane", y: -20 })); // the stand-in maps y to 1000 - y: 1020
    await user.click(screen.getAllByTestId("chart-pane")[0].querySelector(".chart-canvas")!);

    await waitFor(() => expect(puts("/positions/p1/target")).toHaveLength(1));
    expect(puts("/positions/p1/target")[0].body).toEqual({ target_price: 1020 });
    expect(card.getByRole("button", { name: "Pick target on chart" })).not.toHaveTextContent("Click the chart…"); // picking is over
  });

  it("a target picked on the wrong side of the price is refused in words, and nothing is saved", async () => {
    positionRows = [long({ target_price: null })];
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    const c = await loaded();
    const card = within(await screen.findByTestId("position-card"));

    await user.click(card.getByRole("button", { name: "Pick target on chart" }));
    act(() => c.emit("onCrosshairChange", { paneId: "candle_pane", y: 40 })); // 960: below a long's price
    await user.click(screen.getAllByTestId("chart-pane")[0].querySelector(".chart-canvas")!);

    expect(await screen.findByTestId("level-note")).toHaveTextContent(/target/i);
    expect(puts("/positions/p1/target")).toHaveLength(0);
  });

  it("dragging the target uses the position's target route", async () => {
    positionRows = [long()];
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    const c = await loaded();
    await waitFor(() => expect(lines(c)).toHaveLength(2));
    drag(c, "position:p1:target", 1055);
    await waitFor(() => expect(puts("/positions/p1/target")).toHaveLength(1));
    expect(puts("/positions/p1/target")[0].body).toEqual({ target_price: 1055 });
    expect(await screen.findByTestId("level-note")).toHaveTextContent("Target moved to 1,055.");
  });

  it("refuses a stop dragged above the price of a long, sends nothing, and puts the line back", async () => {
    positionRows = [long()];
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    const c = await loaded();
    await waitFor(() => expect(lines(c)).toHaveLength(2));
    drag(c, "position:p1:stop", 1020); // the price is 1,000
    expect(await screen.findByRole("alert")).toHaveTextContent("has to stay below the current price (1000)");
    expect(puts("/stop-loss")).toHaveLength(0);
    await waitFor(() => expect(line(c, "position:p1:stop").points[0].value).toBe(990));
  });

  it("refuses a target dragged below the price of a long", async () => {
    positionRows = [long()];
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    const c = await loaded();
    await waitFor(() => expect(lines(c)).toHaveLength(2));
    drag(c, "position:p1:target", 995);
    expect(await screen.findByRole("alert")).toHaveTextContent("target of a long trade has to stay above");
    expect(puts("/target")).toHaveLength(0);
    await waitFor(() => expect(line(c, "position:p1:target").points[0].value).toBe(1030));
  });

  it("a short is the other way round: its stop belongs above the price and its target below", async () => {
    positionRows = [long({ action: "SELL", entry_price: 990, stop_loss_price: 1010, target_price: 970 })];
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    const c = await loaded();
    await waitFor(() => expect(lines(c)).toHaveLength(2));
    drag(c, "position:p1:stop", 995); // below the price: it would close at once
    expect(await screen.findByRole("alert")).toHaveTextContent("stop-loss of a short trade has to stay above");
    drag(c, "position:p1:target", 960);
    await waitFor(() => expect(puts("/positions/p1/target")).toHaveLength(1));
  });

  it("puts the line back and says why when the server refuses", async () => {
    positionRows = [long()];
    levelFails = "target (1005) must be above entry (1010) for a BUY";
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    const c = await loaded();
    await waitFor(() => expect(lines(c)).toHaveLength(2));
    drag(c, "position:p1:target", 1005);
    expect(await screen.findByRole("alert")).toHaveTextContent("must be above entry (1010) for a BUY");
    await waitFor(() => expect(line(c, "position:p1:target").points[0].value).toBe(1030));
  });

  it("shows a trailing stop but does not let it be picked up, since moving it would switch the trailing off; its target can still be dragged", async () => {
    positionRows = [long({ trailing_stop_enabled: true })];
    renderAt("/trade?symbol=RELIANCE");
    const c = await loaded();
    await waitFor(() => expect(lines(c)).toHaveLength(2));
    expect(line(c, "position:p1:stop").extendData.label).toBe("Stop · Long 10 (trailing)");
    expect(line(c, "position:p1:stop").handlers.lock).toBe(true);
    expect(line(c, "position:p1:target").handlers.lock).toBe(false);
  });

  it("an option trade's stop and target are levels of the underlying, saved on their own routes", async () => {
    groupRows = [{
      id: "g1", underlying_symbol: "NIFTY", strategy_type: "naked_call", action: "BUY", quantity: 1, status: "OPEN", pnl: null, unrealized_pnl: 0, entry_time: iso(6),
      exit_time: null, entry_spot_price: 1000, segment: "NSE", spot_stop_loss_price: 985, spot_target_price: 1030, spot_stop_loss_trailing_enabled: false,
    }];
    renderAt("/trade?symbol=NIFTY");
    await waitFor(() => expect(screen.getByTestId("price-0")).toHaveTextContent("1,000"));
    const c = await loaded();
    await waitFor(() => expect(lines(c)).toHaveLength(2));
    expect(line(c, "group:g1:stop").extendData.label).toBe("Stop · Naked Call");
    drag(c, "group:g1:stop", 980);
    await waitFor(() => expect(puts("/option-groups/g1/spot-stop-loss")).toHaveLength(1));
    expect(puts("/option-groups/g1/spot-stop-loss")[0].body).toEqual({ spot_stop_loss_price: 980 });
    drag(c, "group:g1:target", 1040);
    await waitFor(() => expect(puts("/option-groups/g1/spot-target")).toHaveLength(1));
    expect(puts("/option-groups/g1/spot-target")[0].body).toEqual({ spot_target_price: 1040 });
  });

  it("only the chart's own instrument gets lines, and turning My trades off removes them", async () => {
    const user = userEvent.setup();
    positionRows = [long(), long({ id: "other", symbol: "TCS" })];
    renderAt("/trade?symbol=RELIANCE");
    const c = await loaded();
    await waitFor(() => expect(lines(c)).toHaveLength(2));
    expect(lines(c).every((o) => o.extendData.key.startsWith("position:p1:"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "My trades" }));
    await waitFor(() => expect(lines(c)).toHaveLength(0));
  });

  it("each chart of a pair has the levels of its own instrument", async () => {
    const user = userEvent.setup();
    positionRows = [long({ id: "n", symbol: "NIFTY-Sep2026-FUT", instrument_type: "future" }), long({ id: "b", symbol: "BANKNIFTY-Sep2026-FUT", instrument_type: "future", stop_loss_price: null })];
    renderAt("/trade?symbol=NIFTY");
    await loaded(0);
    await user.click(screen.getByRole("button", { name: /Combos/ }));
    await user.click(screen.getByRole("button", { name: "NIFTY + BANKNIFTY" }));
    await loaded(1);
    await waitFor(() => expect(lines(chart(0))).toHaveLength(2));
    await waitFor(() => expect(lines(chart(1))).toHaveLength(1));
    expect(lines(chart(1))[0].extendData.key).toBe("position:b:target");
  });
});
