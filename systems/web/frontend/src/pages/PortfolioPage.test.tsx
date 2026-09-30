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
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
type Route = (url: string) => Response;
function mockFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      for (const [needle, handler] of Object.entries(routes)) if (url.includes(needle)) return handler(url);
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
  return calls;
}
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const stats = { since: "2026-09-20", baseline: 200000, latest_equity: 201430, return_pct: 0.72, peak_equity: 201800, max_drawdown_pct: 0.5, days_tracked: 5, points: 4 };
const equity = {
  segment: "NSE", days: 90, stats,
  points: [
    { snapshot_date: "2026-09-20", balance: 200000, unrealized_pnl: 0, equity: 200000, is_reset_point: true },
    { snapshot_date: "2026-09-24", balance: 201430, unrealized_pnl: 0, equity: 201430, is_reset_point: false },
  ],
};
const perfStats = {
  trades: 4, wins: 3, losses: 1, breakeven: 0, win_rate_pct: 75, total_pnl: 1430, gross_pnl: 1500, total_charges: 50, total_slippage: 20,
  avg_pnl: 357.5, avg_win: 600, avg_loss: -450, profit_factor: 3.2, avg_r: 0.42, best_trade: 1100, worst_trade: -450, max_consecutive_losses: 1,
};
const perf = (score: number | null) => ({
  segment: "NSE", scope: "epoch", since: "2026-09-20", performance: perfStats, equity: stats,
  discipline: {
    score, window_days: 30, window_start: null, trade_count: score == null ? 3 : 8,
    planned: { rate: 0.5, trades: 8 }, plan_adherence: { rate: 1, trades: 8 },
    plan_review: { rate: null, trades: 0, before_rate: null, after_rate: null }, outcome: { rate: 0.75, trades: 8, win_rate: 0.75, avg_r: 0.4 },
  },
});
const elig = {
  segment: "NSE", enforced: false, eligible: false,
  requirements: [
    { key: "trades", label: "Costed trades", required: "30", actual: "22", met: false },
    { key: "days", label: "Days of trading", required: "14", actual: "20", met: true },
  ],
};
const closedPos = (over: object) => ({
  id: "x", symbol: "TCS", exchange: "NSE", segment: "NSE", action: "BUY", horizon: "intraday", instrument_type: "spot", quantity: 1,
  entry_price: 1, entry_time: "2026-09-26T03:00:00Z", exit_price: 2, exit_time: "2026-09-26T05:00:00Z", pnl: 180, status: "CLOSED",
  stop_loss_price: null, target_price: null, option_group_id: null, exit_reason: "target", reviewed_at: null, ...over,
});

const happy = (score: number | null = 62) =>
  mockFetch({
    "/equity-history/": () => json(equity),
    "/performance/": () => json(perf(score)),
    "/live-eligibility/": () => json(elig),
    "/option-groups": () => json([{ id: "g1", underlying_symbol: "BANKNIFTY", strategy_type: "naked_call", action: "BUY", horizon: "intraday", quantity: 1, net_debit: 1, combined_stop_loss_price: null, spot_stop_loss_price: null, spot_target_price: null, status: "CLOSED", pnl: 1100, entry_time: "2026-09-26T02:00:00Z", exit_time: "2026-09-26T05:30:00Z" }]),
    "/positions": (url) =>
      url.includes("status=OPEN")
        ? json([{ ...closedPos({ id: "open1", symbol: "RELIANCE", status: "OPEN", exit_time: null, pnl: null }), unrealized_pnl: 88, stop_loss_price: 1190 }])
        : json([
            closedPos({ id: "t1", symbol: "TCS", pnl: 180, setup_tag: "Breakout" }),
            closedPos({ id: "t2", symbol: "INFY", pnl: -450, setup_tag: "Breakout", exit_reason: "stop_loss", exit_time: "2026-09-26T04:30:00Z" }),
            closedPos({ id: "leg", symbol: "BANKNIFTY-LEG", pnl: 1100, option_group_id: "g1" }),
          ]),
  });

beforeEach(() => {
  setToken(jwt({ sub: "u1", email: "me@x.com", exp: Math.floor(Date.now() / 1000) + 3600 }), "me@x.com");
});
afterEach(() => vi.unstubAllGlobals());

describe("Portfolio overview", () => {
  it("shows equity, the change since the reset, performance in plain words, and graduation", async () => {
    happy();
    renderAt("/portfolio");
    expect(await screen.findByText("₹2,01,430")).toBeInTheDocument();
    expect(screen.getByText(/\+₹1,430 \(\+0\.72%\)/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Equity from/ })).toBeInTheDocument();
    expect(await screen.findByText("75%")).toBeInTheDocument();
    expect(screen.getByText("+0.42R")).toBeInTheDocument();
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByText("22 / 30")).toBeInTheDocument();
    expect(screen.getByText(/it does not block you/)).toBeInTheDocument();
  });

  it("recent fills list an option group once, never its leg", async () => {
    happy();
    renderAt("/portfolio");
    expect(await screen.findByText("BANKNIFTY")).toBeInTheDocument();
    expect(screen.queryByText("BANKNIFTY-LEG")).not.toBeInTheDocument();
  });

  it("welcomes an account with no history instead of showing zeros", async () => {
    mockFetch({
      "/equity-history/": () => json({ segment: "NSE", days: 90, points: [], stats: null }),
      "/performance/": () => json({ ...perf(null), performance: null, equity: null }),
      "/live-eligibility/": () => json(elig),
      "/option-groups": () => json([]),
      "/positions": () => json([]),
    });
    renderAt("/portfolio");
    expect(await screen.findByText(/No equity history yet/)).toBeInTheDocument();
    expect(await screen.findByText(/once you have closed a trade/)).toBeInTheDocument();
  });

  it("isolates failures: performance failing does not hide equity", async () => {
    mockFetch({
      "/equity-history/": () => json(equity),
      "/performance/": () => json({ detail: "boom" }, 500),
      "/live-eligibility/": () => json(elig),
      "/option-groups": () => json([]),
      "/positions": () => json([]),
    });
    renderAt("/portfolio");
    expect(await screen.findByText("₹2,01,430")).toBeInTheDocument();
    expect(await screen.findByText(/That did not load/)).toBeInTheDocument();
  });

  it("switching segment asks for that segment's data", async () => {
    const calls = happy();
    const user = userEvent.setup();
    renderAt("/portfolio");
    await screen.findByText("₹2,01,430");
    await user.click(screen.getByRole("button", { name: "Commodities" }));
    await waitFor(() => expect(calls.some((c) => c.includes("/equity-history/MCX"))).toBe(true));
    expect(calls.some((c) => c.includes("/performance/MCX"))).toBe(true);
  });
});

describe("Portfolio positions and history", () => {
  it("lists open positions with a two-step square off, only fetching them on that tab", async () => {
    const calls = happy();
    const user = userEvent.setup();
    renderAt("/portfolio");
    await screen.findByText("₹2,01,430");
    expect(calls.some((c) => c.includes("status=OPEN"))).toBe(false);
    await user.click(screen.getByRole("tab", { name: "Positions" }));
    expect(await screen.findByText(/RELIANCE/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Square off" })).toBeInTheDocument();
  });

  it("history shows results with signs, why each closed, and no legs", async () => {
    happy();
    const user = userEvent.setup();
    renderAt("/portfolio?tab=history");
    const history = await screen.findByTestId("history");
    expect(within(history).getByText("−₹450")).toBeInTheDocument();
    expect(within(history).getByText(/stop-loss hit/)).toBeInTheDocument();
    expect(within(history).queryByText("BANKNIFTY-LEG")).not.toBeInTheDocument();
    expect(user).toBeDefined();
  });
});

describe("Review", () => {
  it("explains the score, its parts and the unreviewed journal", async () => {
    happy(62);
    renderAt("/portfolio?tab=review");
    expect(await screen.findByText("62")).toBeInTheDocument();
    expect(screen.getByText("Getting there")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Planned" })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText(/No trades to judge yet/)).toBeInTheDocument(); // plan-review has no data
    expect(within(screen.getByRole("table")).getByText("Breakout")).toBeInTheDocument();
    expect(screen.getByText(/3 of 3 closed trades still need a review/)).toBeInTheDocument();
    expect(screen.getByText("₹50")).toBeInTheDocument(); // charges
  });

  it("does not show a score of zero when there are too few trades", async () => {
    happy(null);
    renderAt("/portfolio?tab=review");
    expect(await screen.findByText("Not enough trades yet")).toBeInTheDocument();
    expect(screen.getByText(/at least 5 trades/)).toBeInTheDocument();
  });
});
