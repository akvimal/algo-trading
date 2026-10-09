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
let accounts: Record<string, any>[];
let creds: Record<string, any>;
let putAccount: (segment: string, body: any) => Response;
let putCreds: (body: any) => Response;
let ltp: () => Response;
let platformStatus: Record<string, any>;
let refreshResult: () => Response;
let renewResult: () => Response;

const mkAccount = (segment: string, over: object = {}) => ({
  segment, starting_balance: 200000, current_balance: 200000, realized_pnl: 0, unrealized_pnl: 0, capital_per_trade: 10000,
  max_daily_loss: null, live_trading_enabled: false, apply_charges: false, require_stop_loss: false, square_off_time: "15:15:00",
  risk_per_trade_pct: 1, min_reward_risk_ratio: 2, enforce_risk_based_lots: false, slippage_bps: 5, max_order_value: null,
  live_trading_consent_at: null, ...over,
});

beforeEach(() => {
  calls = [];
  accounts = [mkAccount("NSE"), mkAccount("MCX", { capital_per_trade: 7777 }), mkAccount("CRYPTO", { square_off_time: null })];
  creds = { has_dhan: false, has_delta: false, has_openrouter: false, dhan_client_id_masked: null };
  putAccount = (segment, body) => {
    const a = accounts.find((x) => x.segment === segment)!;
    Object.assign(a, body);
    if (body.starting_balance) a.current_balance = body.starting_balance;
    return json(a);
  };
  putCreds = (body) => {
    if (body.dhan_client_id) creds = { ...creds, has_dhan: true, dhan_client_id_masked: "****" + body.dhan_client_id.slice(-4) };
    return json(creds);
  };
  ltp = () => json({ exchange: "NSE", symbol: "RELIANCE", ltp: 1226, provider: "dhan-nse" });
  platformStatus = { token_expires_at: new Date(Date.now() + 20 * 3_600_000).toISOString(), has_access_token: true, dhan_client_id: "1101" };
  refreshResult = () => json({ adopted: true, reason: "now using the token saved in Settings", token_expires_at: platformStatus.token_expires_at });
  renewResult = () => json({ renewed: true, adopted_saved_token: false, saved_back_to_settings: true, expiry_time: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      const acct = url.match(/\/accounts\/(NSE|MCX|CRYPTO)(\/reset)?$/);
      if (acct && method === "PUT") return putAccount(acct[1], body);
      if (acct && method === "POST") {
        const a = accounts.find((x) => x.segment === acct[1])!;
        a.current_balance = a.starting_balance;
        return json(a);
      }
      if (url.endsWith("/accounts") && method === "GET") return json(accounts);
      if (url.endsWith("/credentials") && method === "PUT") return putCreds(body);
      if (url.endsWith("/credentials")) return json(creds);
      if (url.includes("/dhan/token-status")) return json(platformStatus);
      if (url.endsWith("/dhan/refresh") && method === "POST") return refreshResult();
      if (url.endsWith("/dhan/renew-token") && method === "POST") return renewResult();
      if (url.includes("/quotes/ltp")) return ltp();
      if (url.includes("/live-eligibility/"))
        return json({ segment: "NSE", enforced: true, eligible: false, requirements: [{ key: "trades", label: "Costed trades", required: "30", actual: "3", met: false }, { key: "days", label: "Days", required: "14", actual: "20", met: true }] });
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
const puts = (part: string) => calls.filter((c) => c.method === "PUT" && c.url.includes(part));

describe("navigation", () => {
  it("is reachable from More", async () => {
    const user = userEvent.setup();
    renderAt("/more");
    await user.click(await screen.findByRole("link", { name: /Settings/ }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("risk limits", () => {
  it("shows the account's values and keeps Save off until something changes", async () => {
    renderAt("/more/settings");
    expect(await screen.findByLabelText("Capital per trade")).toHaveValue("10000");
    expect(screen.getByLabelText("Square off open trades at")).toHaveValue("15:15");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("sends only the changed fields, then confirms and keeps the confirmation", async () => {
    const user = userEvent.setup();
    renderAt("/more/settings");
    const capital = await screen.findByLabelText("Capital per trade");
    await user.clear(capital);
    await user.type(capital, "25000");
    await user.click(screen.getByLabelText(/Require a stop-loss/));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(puts("/accounts/NSE")).toHaveLength(1));
    expect(puts("/accounts/NSE")[0].body).toEqual({ capital_per_trade: 25000, require_stop_loss: true });
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Capital per trade")).toHaveValue("25000")); // reloaded value
    expect(screen.getByText("Saved.")).toBeInTheDocument(); // not wiped by the refresh
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("blocks an invalid value on the field itself, with nothing sent", async () => {
    const user = userEvent.setup();
    renderAt("/more/settings");
    const risk = await screen.findByLabelText("Risk per trade");
    await user.clear(risk);
    await user.type(risk, "150");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/above 0 and up to 100/)).toBeInTheDocument();
    expect(risk).toHaveAttribute("aria-invalid", "true");
    expect(puts("/accounts/")).toHaveLength(0);
  });

  it("clears the daily loss limit with an explicit null", async () => {
    accounts[0].max_daily_loss = 3000;
    const user = userEvent.setup();
    renderAt("/more/settings");
    const loss = await screen.findByLabelText("Daily loss limit");
    expect(loss).toHaveValue("3000");
    await user.clear(loss);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(puts("/accounts/NSE")).toHaveLength(1));
    expect(puts("/accounts/NSE")[0].body).toEqual({ max_daily_loss: null });
  });

  it("shows the server's message when a save is refused", async () => {
    putAccount = () => json({ detail: "capital_per_trade must be positive" }, 422);
    const user = userEvent.setup();
    renderAt("/more/settings");
    const capital = await screen.findByLabelText("Capital per trade");
    await user.clear(capital);
    await user.type(capital, "5");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("capital_per_trade must be positive");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled(); // can retry
  });

  it("switches segment and offers no charges toggle for crypto", async () => {
    const user = userEvent.setup();
    renderAt("/more/settings");
    await screen.findByLabelText("Capital per trade");
    expect(screen.getByLabelText(/Include brokerage/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Commodities" }));
    await waitFor(() => expect(screen.getByLabelText("Capital per trade")).toHaveValue("7777"));
    await user.click(screen.getByRole("button", { name: "Crypto" }));
    await waitFor(() => expect(screen.getByLabelText("Square off open trades at")).toHaveValue(""));
    expect(screen.queryByLabelText(/Include brokerage/)).not.toBeInTheDocument();
  });
});

describe("start over", () => {
  it("needs the word RESET, and the same balance is a plain reset", async () => {
    const user = userEvent.setup();
    renderAt("/more/settings");
    const button = await screen.findByRole("button", { name: "Reset account" });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("Type RESET to confirm"), "reset");
    expect(button).toBeDisabled(); // case matters
    await user.clear(screen.getByLabelText("Type RESET to confirm"));
    await user.type(screen.getByLabelText("Type RESET to confirm"), "RESET");
    await user.click(button);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/accounts/NSE/reset"))).toBe(true));
    expect(await screen.findByText("Account reset.")).toBeInTheDocument();
  });

  it("a new starting balance re-baselines in one call instead", async () => {
    const user = userEvent.setup();
    renderAt("/more/settings");
    const start = await screen.findByLabelText("Starting balance");
    await user.clear(start);
    await user.type(start, "500000");
    await user.type(screen.getByLabelText("Type RESET to confirm"), "RESET");
    await user.click(screen.getByRole("button", { name: "Reset account" }));
    await waitFor(() => expect(puts("/accounts/NSE")).toHaveLength(1));
    expect(puts("/accounts/NSE")[0].body).toEqual({ starting_balance: 500000 });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("Dhan connection", () => {
  it("needs both fields to connect, never shows a secret back, and reports success", async () => {
    const user = userEvent.setup();
    renderAt("/more/settings?tab=broker");
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByLabelText("Access token")).toHaveAttribute("type", "password");
    await user.type(screen.getByLabelText("Access token"), "secrettoken");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/both/);
    expect(puts("/credentials")).toHaveLength(0);

    await user.type(screen.getByLabelText("Client ID"), "1100001234");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(puts("/credentials")).toHaveLength(1));
    expect(puts("/credentials")[0].body).toEqual({ dhan_client_id: "1100001234", dhan_access_token: "secrettoken" });
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/Client \*\*\*\*1234/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("secrettoken")).not.toBeInTheDocument(); // fields cleared
  });

  it("renews just the daily token when already connected", async () => {
    creds = { ...creds, has_dhan: true, dhan_client_id_masked: "****1234" };
    const user = userEvent.setup();
    renderAt("/more/settings?tab=broker");
    await user.type(await screen.findByLabelText("New access token"), "freshtoken");
    await user.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(puts("/credentials")).toHaveLength(1));
    expect(puts("/credentials")[0].body).toEqual({ dhan_access_token: "freshtoken" });
  });

  it("checks live data, and explains a failure in the person's terms", async () => {
    const user = userEvent.setup();
    renderAt("/more/settings?tab=broker");
    await user.click(await screen.findByRole("button", { name: "Check live data" }));
    expect(await screen.findByText(/Live prices are working. RELIANCE is ₹1,226.00/)).toBeInTheDocument();
    ltp = () => json({ detail: "Add your Dhan keys" }, 403, { "x-error-code": "own_dhan_keys_required" });
    await user.click(screen.getByRole("button", { name: "Check live data" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add your Dhan keys");
  });
});

describe("live trading", () => {
  it("shows the unmet track record and offers no live card for crypto", async () => {
    renderAt("/more/settings?tab=broker");
    const nse = await screen.findByTestId("live-NSE");
    expect(within(nse).getByText("1 of 2")).toBeInTheDocument();
    expect(within(nse).getByText("3 / 30")).toBeInTheDocument();
    expect(screen.getByTestId("live-MCX")).toBeInTheDocument();
    expect(screen.queryByTestId("live-CRYPTO")).not.toBeInTheDocument();
  });

  it("will not turn live on without caps and the acknowledgement, and sends nothing", async () => {
    const user = userEvent.setup();
    renderAt("/more/settings?tab=broker");
    const nse = await screen.findByTestId("live-NSE");
    await user.click(within(nse).getByRole("button", { name: "Turn on live trading" }));
    expect(await within(nse).findByRole("alert")).toHaveTextContent(/single order/);
    await user.type(within(nse).getByLabelText("Largest single order"), "50000");
    await user.type(within(nse).getByLabelText("Daily loss limit"), "5000");
    await user.click(within(nse).getByRole("button", { name: "Turn on live trading" }));
    expect(await within(nse).findByRole("alert")).toHaveTextContent(/real money/);
    expect(puts("/accounts/NSE")).toHaveLength(0);
  });

  it("sends the caps and consent together, and shows the server's full refusal", async () => {
    putAccount = () => json({ detail: "Live trading cannot be enabled: save your Dhan keys; you need 30 paper trades." }, 422);
    const user = userEvent.setup();
    renderAt("/more/settings?tab=broker");
    const nse = await screen.findByTestId("live-NSE");
    await user.type(within(nse).getByLabelText("Largest single order"), "50000");
    await user.type(within(nse).getByLabelText("Daily loss limit"), "5000");
    await user.click(within(nse).getByRole("checkbox"));
    await user.click(within(nse).getByRole("button", { name: "Turn on live trading" }));
    await waitFor(() => expect(puts("/accounts/NSE")).toHaveLength(1));
    expect(puts("/accounts/NSE")[0].body).toEqual({ live_trading_enabled: true, max_order_value: 50000, max_daily_loss: 5000, live_trading_consent: true });
    expect(await within(nse).findByRole("alert")).toHaveTextContent(/save your Dhan keys; you need 30 paper trades/);
    expect(within(nse).queryByText("LIVE")).not.toBeInTheDocument(); // refused: still paper
  });

  it("marks a live account LIVE and switches back to paper in one tap", async () => {
    accounts[0] = mkAccount("NSE", { live_trading_enabled: true, max_order_value: 50000, max_daily_loss: 5000 });
    const user = userEvent.setup();
    renderAt("/more/settings?tab=broker");
    const nse = await screen.findByTestId("live-NSE");
    expect(within(nse).getByText("LIVE")).toBeInTheDocument();
    expect(within(nse).getByText(/Largest single order: ₹50,000/)).toBeInTheDocument();
    await user.click(within(nse).getByRole("button", { name: "Switch back to paper" }));
    await waitFor(() => expect(puts("/accounts/NSE")).toHaveLength(1));
    expect(puts("/accounts/NSE")[0].body).toEqual({ live_trading_enabled: false });
    await waitFor(() => expect(within(screen.getByTestId("live-NSE")).queryByText("LIVE")).not.toBeInTheDocument());
  });
});

describe("advanced: the auto-trader toggle", () => {
  it("is off until switched on, and remembers the choice", async () => {
    const user = userEvent.setup();
    renderAt("/more/settings?tab=advanced");
    const box = await screen.findByLabelText(/Show the auto-trader/);
    expect(box).not.toBeChecked();
    await user.click(box);
    expect(box).toBeChecked();
    expect(localStorage.getItem("web.autotrader.visible")).toBe("true");
    await user.click(box);
    expect(box).not.toBeChecked();
    expect(localStorage.getItem("web.autotrader.visible")).toBe("false");
  });

  it("shows on already switched on", async () => {
    localStorage.setItem("web.autotrader.visible", "true");
    renderAt("/more/settings?tab=advanced");
    expect(await screen.findByLabelText(/Show the auto-trader/)).toBeChecked();
  });
});

describe("the add-keys prompt elsewhere", () => {
  it("points at this screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/accounts")) return json(accounts);
        if (url.includes("/options/sentiment")) return json({ exchanges: {} });
        return json({ detail: "add keys" }, 403, { "x-error-code": "own_dhan_keys_required" });
      }),
    );
    renderAt("/");
    const link = await screen.findByRole("link", { name: "Add Dhan keys" });
    expect(link).toHaveAttribute("href", "/more/settings?tab=broker");
  });
});


describe("the platform data token (admin only)", () => {
  const asAdmin = () => setToken(jwt({ sub: "u1", email: "me@x.com", is_admin: true, exp: Math.floor(Date.now() / 1000) + 3600 }), "me@x.com");
  const posts = (suffix: string) => calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));

  it("is not shown to a person who is not an admin", async () => {
    renderAt("/more/settings?tab=broker");
    await screen.findByText("Not connected");
    expect(screen.queryByTestId("platform-token")).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/dhan/"))).toBe(false); // and nothing about it is even asked for
  });

  it("shows an admin how long the platform token has left", async () => {
    asAdmin();
    renderAt("/more/settings?tab=broker");
    const card = await screen.findByTestId("platform-token");
    expect(await within(card).findByTestId("platform-token-expiry")).toHaveTextContent(/Valid for 19h|Valid for 20h/);
    expect(within(card).getByText(/saved on the card below/)).toBeInTheDocument();
  });

  it("says plainly when the token is long expired (the case that broke the scans for days)", async () => {
    asAdmin();
    platformStatus = { ...platformStatus, token_expires_at: new Date(Date.now() - 5 * 86_400_000).toISOString() };
    renderAt("/more/settings?tab=broker");
    expect(await screen.findByTestId("platform-token-expiry")).toHaveTextContent(/Expired 5 days ago/);
  });

  it("pulls the saved token in at once when asked, and reports what the server decided", async () => {
    asAdmin();
    const user = userEvent.setup();
    renderAt("/more/settings?tab=broker");
    await user.click(await screen.findByRole("button", { name: "Use my saved token now" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Now using the token saved above.");
    expect(posts("/dhan/refresh")).toHaveLength(1);
    refreshResult = () => json({ adopted: false, reason: "the token saved in Settings has already expired" });
    await user.click(screen.getByRole("button", { name: "Use my saved token now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The token saved in Settings has already expired.");
  });

  it("renews on request, and says so when the renewed token could not be saved back", async () => {
    asAdmin();
    const user = userEvent.setup();
    renderAt("/more/settings?tab=broker");
    await user.click(await screen.findByRole("button", { name: "Renew now" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Renewed for a fresh 24 hours and saved back/);
    renewResult = () => json({ renewed: true, saved_back_to_settings: false });
    await user.click(screen.getByRole("button", { name: "Renew now" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/could not be saved back/);
  });

  it("shows Dhan's refusal in its own words when a renewal is rejected", async () => {
    asAdmin();
    renewResult = () => json({ detail: "Dhan rejected the renewal request (401) - the current token may already be expired; generate a new one from Dhan Web" }, 502);
    const user = userEvent.setup();
    renderAt("/more/settings?tab=broker");
    await user.click(await screen.findByRole("button", { name: "Renew now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Dhan rejected the renewal request/);
  });

  it("an admin saving a token on the Dhan card gets the platform to use it straight away, and is told", async () => {
    asAdmin();
    creds = { ...creds, has_dhan: true, dhan_client_id_masked: "****1234" };
    const user = userEvent.setup();
    renderAt("/more/settings?tab=broker");
    await user.type(await screen.findByLabelText("New access token"), "freshtoken");
    await user.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(posts("/dhan/refresh")).toHaveLength(1));
    expect(await screen.findByText(/scans and price feed now use it too/)).toBeInTheDocument();
  });

  it("does not claim the platform uses a token it refused, and says why", async () => {
    asAdmin();
    refreshResult = () => json({ adopted: false, reason: "the token saved in Settings has already expired" });
    creds = { ...creds, has_dhan: true, dhan_client_id_masked: "****1234" };
    const user = userEvent.setup();
    renderAt("/more/settings?tab=broker");
    await user.type(await screen.findByLabelText("New access token"), "stale");
    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(await screen.findByText(/The platform kept its own token: The token saved in Settings has already expired\./)).toBeInTheDocument();
  });

  it("a person who is not an admin saving a token does not touch the platform", async () => {
    creds = { ...creds, has_dhan: true, dhan_client_id_masked: "****1234" };
    const user = userEvent.setup();
    renderAt("/more/settings?tab=broker");
    await user.type(await screen.findByLabelText("New access token"), "mine");
    await user.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT" && c.url.endsWith("/credentials"))).toHaveLength(1));
    expect(posts("/dhan/refresh")).toHaveLength(0);
  });
});
