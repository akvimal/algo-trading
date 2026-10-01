import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { setToken } from "./auth/token";

function jwt(claims: object): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
}

const TODAY = new Date().toISOString();

const account = {
  segment: "NSE", starting_balance: 200000, current_balance: 200500, realized_pnl: 500, unrealized_pnl: 250,
  capital_per_trade: 10000, max_daily_loss: 2000, live_trading_enabled: false, apply_charges: false,
  require_stop_loss: false, square_off_time: null,
};
const openPos = {
  id: "p1", symbol: "RELIANCE", exchange: "NSE", segment: "NSE", action: "BUY", horizon: "intraday",
  instrument_type: "spot", quantity: 10, entry_price: 2500, entry_time: TODAY, exit_price: null, exit_time: null,
  pnl: null, status: "OPEN", stop_loss_price: 2480, target_price: null, option_group_id: null,
  unrealized_pnl: 250,
};
const closedPos = { ...openPos, id: "p2", symbol: "TCS", status: "CLOSED", pnl: -600, exit_time: TODAY, unrealized_pnl: undefined };
const emptyComponent = { rate: null, trades: 0 };
const emptyDiscipline = {
  score: null, window_days: 30, window_start: null, trade_count: 0,
  planned: emptyComponent, plan_adherence: emptyComponent,
  plan_review: { ...emptyComponent, before_rate: null, after_rate: null },
  outcome: { ...emptyComponent, win_rate: null, avg_r: null },
};

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function mockFetch(routes: Record<string, Route>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      for (const [needle, handler] of Object.entries(routes)) if (url.includes(needle)) return handler(url, init);
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
  return calls;
}

function renderApp(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const sentiment = { exchanges: { NSE: { direction: "bullish", strength: "moderate", score: 0.4, underlyings: [] } } };

beforeEach(() => {
  setToken(jwt({ sub: "u1", email: "me@x.com", exp: Math.floor(Date.now() / 1000) + 3600 }), "me@x.com");
});
afterEach(() => vi.unstubAllGlobals());

describe("routing", () => {
  it("sends a signed-out visitor to sign in", async () => {
    localStorage.clear();
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("drops an expired token instead of using it", async () => {
    setToken(jwt({ sub: "u1", exp: 10 }), "me@x.com");
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(localStorage.getItem("web.authToken")).toBeNull();
  });
});

describe("sign up", () => {
  it("keeps Create account disabled until the risk disclosure is ticked, then sends the acceptance", async () => {
    localStorage.clear();
    const calls = mockFetch({ "/auth/signup": () => json({ access_token: jwt({ sub: "u2", exp: 4102444800 }), token_type: "bearer" }, 201) });
    const user = userEvent.setup();
    renderApp("/signin");
    await user.click(screen.getByRole("button", { name: /create an account/i }));
    await user.type(screen.getByLabelText("Name"), "Asha");
    await user.type(screen.getByLabelText("Email"), "asha@x.com");
    await user.type(screen.getByLabelText("Password"), "longenough1");
    const submit = screen.getByRole("button", { name: "Create account" });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0].url).toContain("/auth/signup"); // later calls are the Today screen loading after sign-in
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({
      name: "Asha", email: "asha@x.com", password: "longenough1", accept_risk_disclosure: true,
    });
  });

  it("shows the server's message on a wrong password and stays on the form", async () => {
    localStorage.clear();
    mockFetch({ "/auth/login": () => json({ detail: "Invalid email or password" }, 401) });
    const user = userEvent.setup();
    renderApp("/signin");
    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.type(screen.getByLabelText("Password"), "wrongwrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
  });
});

describe("Today", () => {
  const happy = () =>
    mockFetch({
      "/accounts": () => json([account]),
      "/option-groups": () => json([]),
      "/positions": () => json([openPos, closedPos]),
      "/options/sentiment": () => json(sentiment),
    });

  it("shows today's P&L with signs, the open position, and the loss budget", async () => {
    happy();
    renderApp("/");
    // booked -600 today + open +250 = -350
    expect(await screen.findByText("−₹350")).toBeInTheDocument();
    expect(screen.getByText(/RELIANCE/)).toBeInTheDocument();
    expect(screen.queryByText(/TCS/)).not.toBeInTheDocument(); // closed trades are not "open now"
    expect(screen.getByRole("meter", { name: /daily loss budget/i })).toHaveAttribute("aria-valuenow", "350");
    expect(screen.getByText(/SL 2,480/)).toBeInTheDocument();
    expect(screen.getByText(/Target not set/)).toBeInTheDocument();
    expect(await screen.findByText(/bullish/)).toBeInTheDocument();
  });

  it("shows performance and a discipline score on Today, scoped to the account's own segment", async () => {
    mockFetch({
      "/accounts": () => json([account]),
      "/option-groups": () => json([]),
      "/positions": () => json([]),
      "/options/sentiment": () => json(sentiment),
      "/equity-history": () => json({ segment: "NSE", days: 30, points: [{ snapshot_date: "2026-09-01", balance: 200000, unrealized_pnl: 0, equity: 200000, is_reset_point: true }, { snapshot_date: "2026-09-27", balance: 210000, unrealized_pnl: 0, equity: 210000, is_reset_point: false }], stats: { since: "2026-09-01", baseline: 200000, latest_equity: 210000, return_pct: 5, peak_equity: 210000, max_drawdown_pct: 0, days_tracked: 27, points: 2 } }),
      "/performance": () =>
        json({
          segment: "NSE", scope: "epoch", since: "2026-09-01",
          performance: { trades: 10, wins: 7, losses: 3, breakeven: 0, win_rate_pct: 70, total_pnl: 10000, gross_pnl: 10500, total_charges: 400, total_slippage: 100, avg_pnl: 1000, avg_win: 2000, avg_loss: -1500, profit_factor: 2.5, avg_r: 0.8, best_trade: 3000, worst_trade: -1500, max_consecutive_losses: 1 },
          discipline: { score: 82, window_days: 30, window_start: "2026-08-28", trade_count: 10, planned: { rate: 0.9, trades: 10 }, plan_adherence: { rate: 0.8, trades: 10 }, plan_review: { rate: 0.7, trades: 10, before_rate: 0.7, after_rate: 0.7 }, outcome: { rate: 0.7, trades: 10, win_rate: 0.7, avg_r: 0.8 } },
          equity: null,
        }),
      "/discipline": () => json({ segment: "NSE", scope: "epoch", score: 82, trade_count: 10, emotions: { greed: 90, fear: 80, patience: 75 }, categories: {}, mistakes: {}, week_mistakes: {}, target_and_stop_moved: 0, coaching: null, trades: [] }),
    });
    renderApp("/");
    expect(await screen.findByText("₹2,10,000")).toBeInTheDocument(); // equity headline
    expect(screen.getByText("70%")).toBeInTheDocument(); // win rate
    expect(screen.getByText("+0.80R")).toBeInTheDocument(); // expectancy
    expect(screen.getByText("82")).toBeInTheDocument(); // discipline score, in the gauge
    expect(screen.getByText("Good")).toBeInTheDocument(); // discipline band
    expect(screen.getByRole("link", { name: /full breakdown/ })).toHaveAttribute("href", "/portfolio?segment=NSE&tab=review");
  });

  it("squares off only after an explicit confirm", async () => {
    const calls = happy();
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Square off" }));
    expect(calls.some((c) => c.url.includes("/square-off"))).toBe(false); // one tap does nothing
    await user.click(screen.getByRole("button", { name: "Keep open" }));
    expect(screen.getByRole("button", { name: "Square off" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Square off" }));
    await user.click(screen.getByRole("button", { name: "Confirm square off" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/positions/p1/square-off") && c.init?.method === "POST")).toBe(true));
  });

  it("explains the own-keys case and links to adding keys, instead of a raw error", async () => {
    mockFetch({
      "/accounts": () => json([account]),
      "/option-groups": () => json({ detail: "add keys" }, 403, { "x-error-code": "own_dhan_keys_required" }),
      "/positions": () => json([]),
      "/options/sentiment": () => json(sentiment),
    });
    renderApp("/");
    expect(await screen.findByText(/Add your Dhan keys to see live data/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add Dhan keys" })).toBeInTheDocument();
  });

  it("keeps positions on screen when only the market pulse fails", async () => {
    mockFetch({
      "/accounts": () => json([account]),
      "/option-groups": () => json([]),
      "/positions": () => json([openPos]),
      "/equity-history": () => json({ segment: "NSE", days: 30, points: [], stats: null }),
      "/performance": () => json({ segment: "NSE", scope: "epoch", since: null, performance: null, discipline: emptyDiscipline, equity: null }),
      "/options/sentiment": () => json({ detail: "boom" }, 500),
    });
    renderApp("/");
    expect(await screen.findByText(/RELIANCE/)).toBeInTheDocument();
    expect(await screen.findByText(/That did not load/)).toBeInTheDocument();
  });

  it("welcomes a brand-new user with no trades", async () => {
    mockFetch({
      "/accounts": () => json([{ ...account, current_balance: 200000, unrealized_pnl: 0, max_daily_loss: null }]),
      "/option-groups": () => json([]),
      "/positions": () => json([]),
      "/options/sentiment": () => json(sentiment),
    });
    renderApp("/");
    expect(await screen.findByText(/once you place one/)).toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument(); // no limit set: no invented budget
  });

  it("signs out when the server rejects the session", async () => {
    mockFetch({
      "/accounts": () => json({ detail: "expired" }, 401),
      "/positions": () => json({ detail: "expired" }, 401),
      "/option-groups": () => json({ detail: "expired" }, 401),
      "/options/sentiment": () => json(sentiment),
    });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("navigation", () => {
  it("offers the five destinations", async () => {
    mockFetch({ "/accounts": () => json([account]), "/positions": () => json([]), "/option-groups": () => json([]), "/options/sentiment": () => json(sentiment) });
    renderApp("/more");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    for (const label of ["Today", "Scan", "Trade", "Portfolio", "More"]) expect(nav).toHaveTextContent(label);
    expect(within(nav).getByText("me@x.com")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});
