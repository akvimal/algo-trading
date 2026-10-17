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

const read = { direction: "bullish", strength: "moderate", score: 0.4, underlyings: [] };
const sentiment = { exchanges: { NSE: read, MCX: read, CRYPTO: read } }; // every market, so the page does not depend on which one is trading when the test runs

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
    expect(screen.queryByRole("region", { name: "Markets" })).not.toBeInTheDocument(); // Markets has its own page now
    expect(screen.getAllByRole("link", { name: /Markets/ }).every((l) => l.getAttribute("href") === "/markets")).toBe(true);
  });

  it("Markets is its own page, with the open-interest read for the market trading first", async () => {
    mockFetch({ "/options/sentiment": () => json(sentiment) });
    renderApp("/markets");
    expect(await screen.findByRole("heading", { name: "Markets" })).toBeInTheDocument();
    expect(await screen.findByText(/OI bullish · moderate/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Markets" })).toBeInTheDocument();
  });

  it("shows each account as a card: balance, the last days' trend, a discipline read, and a way into its detail", async () => {
    mockFetch({
      "/accounts": () => json([account]),
      "/option-groups": () => json([]),
      "/positions": () => json([]),
      "/options/sentiment": () => json(sentiment),
      "/equity-history": () => json({ segment: "NSE", days: 30, points: [{ snapshot_date: "2026-09-01", balance: 200000, unrealized_pnl: 0, equity: 200000, is_reset_point: true }, { snapshot_date: "2026-09-27", balance: 210000, unrealized_pnl: 0, equity: 210000, is_reset_point: false }], stats: { since: "2026-09-01", baseline: 200000, latest_equity: 210000, return_pct: 5, peak_equity: 210000, max_drawdown_pct: 0, days_tracked: 27, points: 2 } }),
      "/trade-review/summary": () => json({ segment: "NSE", reviewed: 4, pending: 2, by_level: {}, by_tag: { chased: { n: 3, pnl: -900 } }, clean: {}, flawed: {}, trades_since_last: { chased: 2 } }),
      "/discipline": () => json({ segment: "NSE", scope: "epoch", score: 82, trade_count: 10, emotions: { greed: 90, fear: 80, patience: 75 }, categories: {}, mistakes: {}, week_mistakes: {}, target_and_stop_moved: 0, emotion_counts: {}, needs_emotion: 2, coaching: null, trades: [] }),
    });
    renderApp("/");
    const card = within(await screen.findByTestId("account-card"));
    expect(await card.findByTestId("trend")).toBeInTheDocument();
    expect(await card.findByText("82")).toBeInTheDocument(); // discipline score
    expect(card.getByText(/Good/)).toBeInTheDocument();
    expect(card.getByText(/Fix next: Chased/)).toBeInTheDocument();
    expect(card.getByRole("link", { name: /Stocks & F&O/ })).toHaveAttribute("href", "/performance?segment=NSE&tab=overview");
    expect(card.getByRole("link", { name: /2 to review/ })).toHaveAttribute("href", "/performance?segment=NSE&tab=review&section=journal");
  });

  it("shows the last sessions in place of the first-week checklist once there is a session", async () => {
    const cellOf = (ok: number, of: number) => ({ ok, of, rate: of ? ok / of : null, band: of ? "good" : "none" });
    mockFetch({
      "/accounts": () => json([account]),
      "/option-groups": () => json([]),
      "/positions": () => json([]),
      "/options/sentiment": () => json(sentiment),
      "/trade-review/sessions": () => json({ manual: [{ date: "2026-10-03", trades: 2, unreviewed: 0, study: cellOf(2, 2), plan: cellOf(2, 2), trade: cellOf(2, 2) }], bot: [] }),
    });
    renderApp("/");
    expect(await screen.findByTestId("manual-grid")).toBeInTheDocument();
    expect(screen.queryByText("Your first week")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bot-grid")).not.toBeInTheDocument(); // no bot trades, no bot grid
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

  it("Today stays fine, and Markets says so, when the market pulse fails", async () => {
    mockFetch({
      "/accounts": () => json([account]),
      "/option-groups": () => json([]),
      "/positions": () => json([openPos]),
      "/equity-history": () => json({ segment: "NSE", days: 30, points: [], stats: null }),
      "/performance": () => json({ segment: "NSE", scope: "epoch", since: null, performance: null, discipline: emptyDiscipline, equity: null }),
      "/options/sentiment": () => json({ detail: "boom" }, 500),
    });
    renderApp("/");
    expect(await screen.findByText(/RELIANCE/)).toBeInTheDocument(); // Today does not need the market pulse at all
    renderApp("/markets");
    expect(await screen.findByText(/OI read unavailable/)).toBeInTheDocument();
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
