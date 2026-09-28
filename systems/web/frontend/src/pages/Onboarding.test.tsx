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

type Call = { url: string; method: string; body: any };
let calls: Call[];
let profile: Record<string, any>;
let meStatus: number;
let putAccount: (segment: string, body: any) => Response;
let putCreds: () => Response;
let ltp: () => Response;
let positions: object[];

const account = (segment: string) => ({
  segment, starting_balance: 200000, current_balance: 200000, realized_pnl: 0, unrealized_pnl: 0, capital_per_trade: 10000, max_daily_loss: null,
  live_trading_enabled: false, apply_charges: false, require_stop_loss: false, square_off_time: null, risk_per_trade_pct: 1, min_reward_risk_ratio: 2,
  enforce_risk_based_lots: false, slippage_bps: 0, max_order_value: null, live_trading_consent_at: null,
});
const emptyComponent = { rate: null, trades: 0 };
const emptyDiscipline = {
  score: null, window_days: 30, window_start: null, trade_count: 0,
  planned: emptyComponent, plan_adherence: emptyComponent,
  plan_review: { ...emptyComponent, before_rate: null, after_rate: null },
  outcome: { ...emptyComponent, win_rate: null, avg_r: null },
};

beforeEach(() => {
  calls = [];
  positions = [];
  meStatus = 200;
  profile = { id: "u1", email: "asha@x.com", name: "Asha Rao", is_admin: false, experience: "guided", onboarded_at: null, markets: ["NSE", "MCX", "CRYPTO"] };
  putAccount = (seg) => json(account(seg));
  putCreds = () => json({ has_dhan: true, has_delta: false, has_openrouter: false, dhan_client_id_masked: "****1234" });
  ltp = () => json({ exchange: "NSE", symbol: "RELIANCE", ltp: 1226, provider: "dhan" });
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith("/auth/me")) return meStatus === 200 ? json(profile) : json({ detail: "boom" }, meStatus);
      if (url.endsWith("/auth/me/preferences")) {
        if (body.experience) profile.experience = body.experience;
        if (body.markets) profile.markets = body.markets;
        if (body.onboarded === true && !profile.onboarded_at) profile.onboarded_at = "2026-09-26T05:00:00Z";
        return json(profile);
      }
      const acct = url.match(/\/accounts\/(NSE|MCX|CRYPTO)$/);
      if (acct && method === "PUT") return putAccount(acct[1], body);
      if (url.endsWith("/accounts")) return json([account("NSE")]);
      if (url.endsWith("/credentials") && method === "PUT") return putCreds();
      if (url.includes("/quotes/ltp")) return ltp();
      if (url.includes("/options/sentiment")) return json({ exchanges: {} });
      if (url.includes("/positions")) return json(positions);
      if (url.includes("/option-groups")) return json([]);
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
  setToken(jwt({ sub: "u1", email: "asha@x.com", exp: Math.floor(Date.now() / 1000) + 3600 }), "asha@x.com");
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
const puts = (part: string) => calls.filter((c) => c.method === "PUT" && c.url.includes(part));

describe("who is sent to setup", () => {
  it("takes a new person to setup wherever they land, greeting them by first name", async () => {
    renderAt("/portfolio");
    expect(await screen.findByRole("heading", { name: "Welcome, Asha" })).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument(); // no app chrome during setup
  });

  it("never offers setup again to someone who has finished it: it would reset their account", async () => {
    profile.onboarded_at = "2026-09-01T00:00:00Z";
    renderAt("/welcome");
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.queryByText("Step 1 of 3")).not.toBeInTheDocument();
  });

  it("opens the app anyway when the profile cannot be read, rather than locking anyone out", async () => {
    meStatus = 500;
    renderAt("/");
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });
});

describe("step 1: experience", () => {
  it("suggests Pro to a regular trader, but the choice stays theirs, and saves it", async () => {
    const user = userEvent.setup();
    renderAt("/");
    await user.click(await screen.findByRole("radio", { name: /I trade regularly/ }));
    expect(screen.getByText(/We suggest Pro/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Pro/ })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: /^Guided/ })); // overriding the suggestion
    await user.click(screen.getByRole("radio", { name: /^Pro/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(puts("/auth/me/preferences")).toHaveLength(1));
    expect(puts("/auth/me/preferences")[0].body).toEqual({ experience: "pro" });
    expect(await screen.findByText("Step 2 of 3")).toBeInTheDocument();
  });

  it("suggests Guided to a beginner", async () => {
    const user = userEvent.setup();
    renderAt("/");
    await user.click(await screen.findByRole("radio", { name: /I am new to trading/ }));
    expect(screen.getByText(/We suggest Guided/)).toBeInTheDocument();
  });
});

async function toStep2() {
  const user = userEvent.setup();
  renderAt("/");
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await screen.findByText("Step 2 of 3");
  return user;
}

describe("step 2: the practice account", () => {
  it("works the starting rules out from the capital and updates them as the capital changes", async () => {
    const user = await toStep2();
    const rules = within(screen.getByTestId("rules"));
    expect(rules.getByText("₹50,000")).toBeInTheDocument(); // money in one trade on 5 lakh
    expect(rules.getByText("1% (₹5,000)")).toBeInTheDocument();
    expect(rules.getByText("₹10,000")).toBeInTheDocument(); // daily loss limit
    await user.click(screen.getByRole("radio", { name: "₹10,00,000" }));
    expect(within(screen.getByTestId("rules")).getByText("₹1,00,000")).toBeInTheDocument();
  });

  it("creates the account for each chosen market with the derived rules, costs on and a required stop-loss", async () => {
    const user = await toStep2();
    await user.click(screen.getByLabelText(/Commodities/));
    await user.click(screen.getByLabelText(/Crypto/));
    await user.click(screen.getByRole("button", { name: "Create my practice account" }));
    await waitFor(() => expect(puts("/accounts/")).toHaveLength(3));
    const body = (seg: string) => puts(`/accounts/${seg}`)[0].body;
    expect(body("NSE")).toEqual({
      starting_balance: 500000, capital_per_trade: 50000, risk_per_trade_pct: 1, min_reward_risk_ratio: 2, max_daily_loss: 10000,
      require_stop_loss: true, slippage_bps: 5, apply_charges: true,
    });
    expect(body("MCX").apply_charges).toBe(true);
    expect("apply_charges" in body("CRYPTO")).toBe(false);
    expect(await screen.findByText("Step 3 of 3")).toBeInTheDocument();
  });

  it("remembers which markets were chosen, so the others do not count", async () => {
    const user = await toStep2();
    await user.click(screen.getByLabelText(/Commodities/));
    await user.click(screen.getByRole("button", { name: "Create my practice account" }));
    await waitFor(() => expect(puts("/auth/me/preferences").some((c) => c.body.markets)).toBe(true));
    expect(puts("/auth/me/preferences").find((c) => c.body.markets)!.body).toEqual({ markets: ["NSE", "MCX"] });
  });

  it("does not record a market choice when creating the account failed", async () => {
    putAccount = () => json({ detail: "no" }, 422);
    const user = await toStep2();
    await user.click(screen.getByRole("button", { name: "Create my practice account" }));
    await screen.findByRole("alert");
    expect(puts("/auth/me/preferences").some((c) => c.body.markets)).toBe(false);
  });

  it("takes a custom amount, and refuses one it cannot use", async () => {
    const user = await toStep2();
    await user.click(screen.getByRole("radio", { name: "Another amount" }));
    const amount = screen.getByLabelText("Amount");
    await user.type(amount, "50");
    expect(await screen.findByText(/whole amount from/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create my practice account" })).toBeDisabled();
    await user.clear(amount);
    await user.type(amount, "2,50,000");
    expect(screen.getByRole("button", { name: "Create my practice account" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Create my practice account" }));
    await waitFor(() => expect(puts("/accounts/NSE")).toHaveLength(1));
    expect(puts("/accounts/NSE")[0].body).toMatchObject({ starting_balance: 250000, capital_per_trade: 25000, max_daily_loss: 5000 });
  });

  it("needs at least one market", async () => {
    const user = await toStep2();
    await user.click(screen.getByLabelText(/Stocks and index options/));
    expect(screen.getByText("Pick at least one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create my practice account" })).toBeDisabled();
  });

  it("shows the server's message when creating fails, and stays on the step", async () => {
    putAccount = () => json({ detail: "starting_balance must be positive" }, 422);
    const user = await toStep2();
    await user.click(screen.getByRole("button", { name: "Create my practice account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("starting_balance must be positive");
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
  });

  it("goes back to step 1", async () => {
    const user = await toStep2();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("Step 1 of 3")).toBeInTheDocument();
  });
});

async function toStep3() {
  const user = await toStep2();
  await user.click(screen.getByRole("button", { name: "Create my practice account" }));
  await screen.findByText("Step 3 of 3");
  return user;
}

describe("step 3: live prices", () => {
  it("can be skipped: it finishes setup and lands on Today, and says what works without keys", async () => {
    const user = await toStep3();
    expect(screen.getByText(/Scan \(end-of-day\) works without keys/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip and finish" }));
    await waitFor(() => expect(puts("/auth/me/preferences").some((c) => c.body.onboarded === true)).toBe(true));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.queryByText("Step 3 of 3")).not.toBeInTheDocument();
  });

  it("needs both fields, connects, proves it with a real quote, and never keeps the token on screen", async () => {
    const user = await toStep3();
    await user.type(screen.getByLabelText("Access token"), "secrettoken");
    await user.click(screen.getByRole("button", { name: "Connect and check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/both/);
    expect(puts("/credentials")).toHaveLength(0);
    await user.type(screen.getByLabelText("Dhan client ID"), "1100001234");
    await user.click(screen.getByRole("button", { name: "Connect and check" }));
    await waitFor(() => expect(puts("/credentials")).toHaveLength(1));
    expect(puts("/credentials")[0].body).toEqual({ dhan_client_id: "1100001234", dhan_access_token: "secrettoken" });
    expect(await screen.findByText(/Connected. Live prices are working: RELIANCE is ₹1,226.00/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("secrettoken")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish" })).toBeInTheDocument(); // no longer "Skip and finish"
  });

  it("says so when the keys do not work, and still lets the person finish", async () => {
    ltp = () => json({ detail: "Dhan rejected the token" }, 502);
    const user = await toStep3();
    await user.type(screen.getByLabelText("Dhan client ID"), "1100001234");
    await user.type(screen.getByLabelText("Access token"), "badtoken");
    await user.click(screen.getByRole("button", { name: "Connect and check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Dhan rejected the token");
    expect(screen.getByRole("button", { name: "Skip and finish" })).toBeEnabled();
  });
});

describe("skipping setup", () => {
  it("skips from any step without changing the account or the experience", async () => {
    const user = userEvent.setup();
    renderAt("/");
    await user.click(await screen.findByRole("button", { name: "Skip setup" }));
    await waitFor(() => expect(puts("/auth/me/preferences")).toHaveLength(1));
    expect(puts("/auth/me/preferences")[0].body).toEqual({ onboarded: true });
    expect(puts("/accounts/")).toHaveLength(0);
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });
});

describe("Guided and Pro", () => {
  beforeEach(() => {
    profile.onboarded_at = "2026-09-01T00:00:00Z";
  });

  it("shows a Guided person a first-week checklist that notices what they have done, and can be hidden", async () => {
    positions = [{ id: "p1", symbol: "TCS", exchange: "NSE", segment: "NSE", action: "BUY", horizon: "intraday", instrument_type: "spot", quantity: 1, entry_price: 1, entry_time: "2026-09-26T03:00:00Z", exit_price: null, exit_time: null, pnl: null, status: "OPEN", stop_loss_price: 0.9, target_price: null, option_group_id: null }];
    const user = userEvent.setup();
    renderAt("/");
    const card = within(await screen.findByTestId("first-week"));
    expect(card.getByText("1 of 3 done")).toBeInTheDocument();
    expect(card.getByRole("link", { name: "Write down why" })).toHaveAttribute("href", "/portfolio?tab=history");
    expect(card.queryByRole("link", { name: "Place a planned trade" })).not.toBeInTheDocument(); // done: no longer a call to action
    await user.click(card.getByRole("button", { name: "Hide this" }));
    expect(screen.queryByTestId("first-week")).not.toBeInTheDocument();
    expect(localStorage.getItem("web.firstWeekHidden")).toBe("1");
  });

  it("offers a brand-new person a way to their first trade", async () => {
    renderAt("/");
    expect(await screen.findByRole("link", { name: "Place your first trade" })).toHaveAttribute("href", "/trade");
  });

  it("shows a Pro person no checklist", async () => {
    profile.experience = "pro";
    renderAt("/");
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url.includes("/positions"))).toBe(true));
    expect(screen.queryByTestId("first-week")).not.toBeInTheDocument();
  });

  it("switches from More, and the change is saved on the account", async () => {
    const user = userEvent.setup();
    renderAt("/more");
    expect(await screen.findByRole("radio", { name: "Guided" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "Pro" }));
    await waitFor(() => expect(puts("/auth/me/preferences")).toHaveLength(1));
    expect(puts("/auth/me/preferences")[0].body).toEqual({ experience: "pro" });
    expect(screen.getByRole("radio", { name: "Pro" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/Pro hides the hints/)).toBeInTheDocument();
  });
});

describe("markets", () => {
  beforeEach(() => {
    profile.onboarded_at = "2026-09-01T00:00:00Z";
    profile.markets = ["NSE"];
  });

  it("counts only the chosen markets in the balance and daily loss limit on Today", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/auth/me")) return json(profile);
        if (url.endsWith("/accounts"))
          return json([
            { ...account("NSE"), current_balance: 500000, max_daily_loss: 10000 },
            { ...account("MCX"), current_balance: 200000, max_daily_loss: 4000 },
            { ...account("CRYPTO"), current_balance: 200000 },
          ]);
        if (url.includes("/options/sentiment")) return json({ exchanges: {} });
        if (url.includes("/equity-history")) return json({ segment: "NSE", days: 30, points: [], stats: null });
        if (url.includes("/performance/")) return json({ segment: "NSE", scope: "epoch", since: null, performance: null, discipline: emptyDiscipline, equity: null });
        return json([]);
      }),
    );
    renderAt("/");
    expect(await screen.findByText("₹5,00,000")).toBeInTheDocument(); // not ₹9,00,000
    expect(screen.getByRole("meter", { name: /daily loss budget/i })).toHaveAttribute("aria-valuemax", "10000");
  });

  it("shows only the chosen markets on Portfolio", async () => {
    renderAt("/portfolio");
    expect(await screen.findByRole("button", { name: "Stocks & F&O" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Commodities" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crypto" })).not.toBeInTheDocument();
  });

  it("can be changed from More, but never emptied", async () => {
    const user = userEvent.setup();
    renderAt("/more");
    const commodities = await screen.findByLabelText("Commodities");
    expect(commodities).not.toBeChecked();
    await user.click(commodities);
    await waitFor(() => expect(puts("/auth/me/preferences")).toHaveLength(1));
    expect(puts("/auth/me/preferences")[0].body).toEqual({ markets: ["NSE", "MCX"] });
    await user.click(screen.getByLabelText("Commodities"));
    await user.click(screen.getByLabelText("Stocks and index options"));
    expect(await screen.findByText("Keep at least one market.")).toBeInTheDocument();
    expect(screen.getByLabelText("Stocks and index options")).toBeChecked();
  });
});
