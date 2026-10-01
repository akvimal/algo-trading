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

const dv2 = (score: number | null) => ({
  segment: "NSE", scope: "epoch", score, trade_count: score == null ? 3 : 8,
  emotions: { greed: 88, fear: 64, patience: 71 }, categories: { risk: 90, entry: 70, management: 75, day: 80 },
  mistakes: { oversized: 2, tight_trail: 1, untagged: 1 }, week_mistakes: { oversized: 2 }, target_and_stop_moved: 0,
  emotion_counts: { fearful: 3, calm: 1 }, needs_emotion: score == null ? 0 : 1,
  credentials: [
    { key: "loss_acceptor", label: "Loss Acceptor", blurb: "Took the loss as planned.", unit: "losses taken as planned in a row", count: 12, level: "bronze", next_level: "silver", next_at: 25, best_count: 12, best_level: "bronze", lapsed: false, available: true, detail: null },
    { key: "risk_keeper", label: "Risk Keeper", blurb: "Traded at the system size.", unit: "trades at the system size in a row", count: 3, level: null, next_level: "bronze", next_at: 20, best_count: 22, best_level: "bronze", lapsed: true, available: true, detail: null },
    { key: "day_closer", label: "Day Closer", blurb: "You stopped at your loss limit.", unit: "loss-limit days respected in a row", count: 0, level: null, next_level: "bronze", next_at: 3, best_count: 0, best_level: null, lapsed: false, available: false, detail: "Set a daily loss limit on this account to earn it." },
    { key: "calm_under_pressure", label: "Calm Under Pressure", blurb: "Few fear mistakes.", unit: "recent trades measured", count: 30, level: "bronze", next_level: "silver", next_at: 50, best_count: 30, best_level: "bronze", lapsed: false, available: true, detail: "Fear mistakes in your last 30 trades: 13%" },
  ],
  coaching: { mistake: "oversized", emotion: "greed", count: 2, line: "This week you took more size than the system's risk sizing allowed (2 times in 4 trades). That is the one habit to work on next." },
  trades: [
    { id: "t1", kind: "position", symbol: "TCS", action: "BUY", exit_time: "2026-09-26T05:00:00Z", exit_reason: "stop_loss", exit_kind: "tight_trail", planned_rr: 2, exit_r: 0.6, score: 72, pnl: 180, mistakes: ["tight_trail"], flags: [], checks: [], what_if: { extra_r: 1.4, target_reached: true }, emotion_tag: null, needs_emotion: true },
    { id: "t2", kind: "position", symbol: "INFY", action: "BUY", exit_time: "2026-09-26T04:30:00Z", exit_reason: "stop_loss", exit_kind: "clean_stop", planned_rr: 2, exit_r: -1, score: 100, pnl: -450, mistakes: [], flags: [], checks: [], what_if: null, emotion_tag: "calm", needs_emotion: false },
  ],
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
    "/discipline/": () => json(dv2(score)),
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
    expect(screen.getByRole("meter", { name: "Greed" })).toHaveAttribute("aria-valuenow", "88");
    expect(screen.getByRole("meter", { name: "Fear" })).toHaveAttribute("aria-valuenow", "64");
    expect(screen.getByRole("meter", { name: "Patience" })).toHaveAttribute("aria-valuenow", "71");
    expect(screen.getByTestId("coaching-line")).toHaveTextContent("took more size than the system's risk sizing allowed");
    expect(screen.getByText("Sized above plan · 2")).toBeInTheDocument(); // the costliest habits, in plain words
    expect(within(screen.getByRole("table")).getByText("Breakout")).toBeInTheDocument();
    expect(screen.getByText(/3 of 3 closed trades still need a review/)).toBeInTheDocument();
    expect(screen.getByText("₹50")).toBeInTheDocument(); // charges
  });

  it("does not show a score of zero when there are too few trades", async () => {
    happy(null);
    renderAt("/portfolio?tab=review");
    expect(await screen.findByText("Not enough trades yet")).toBeInTheDocument();
    expect(screen.getByText(/at least 5 closed trades/)).toBeInTheDocument();
  });

  it("asks how you felt after a loss or an early exit, saves the answer, and shows the mix", async () => {
    const puts: { url: string; body: unknown }[] = [];
    let answered = false;
    const base = globalThis.fetch;
    happy(62);
    const routed = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT" && url.includes("/tags")) {
        puts.push({ url, body: JSON.parse(String(init.body)) });
        answered = true;
        return json({ id: "t1" });
      }
      if (url.includes("/discipline/") && answered) {
        const d = dv2(62) as any;
        d.trades[0] = { ...d.trades[0], emotion_tag: "fearful", needs_emotion: false };
        d.needs_emotion = 0;
        return json(d);
      }
      return routed(url, init);
    }));
    void base;
    const user = userEvent.setup();
    renderAt("/portfolio?tab=review");
    expect(await screen.findByTestId("feeling-nudge")).toHaveTextContent("1 trade is waiting for one tap on how you felt");
    expect(screen.getByText("Fearful · 3")).toBeInTheDocument(); // the mix so far
    const group = within(screen.getByRole("group", { name: "How did you feel about TCS?" }));
    expect(group.getByText("How did you feel?")).toBeInTheDocument();
    await user.click(group.getByRole("button", { name: "Fearful" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].url).toContain("/positions/t1/tags");
    expect(puts[0].body).toEqual({ emotion_tag: "fearful" });
    await waitFor(() => expect(screen.queryByTestId("feeling-nudge")).not.toBeInTheDocument());
    expect(within(screen.getByRole("group", { name: "How did you feel about TCS?" })).getByRole("button", { name: "Fearful" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not ask about a trade that went to plan, but lets an answer be seen and changed", async () => {
    happy(62);
    renderAt("/portfolio?tab=review");
    await screen.findByText("62");
    const infy = within(screen.getByRole("group", { name: "How did you feel about INFY?" }));
    expect(infy.queryByText("How did you feel?")).not.toBeInTheDocument();
    expect(infy.getByRole("button", { name: "Calm" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the credentials shelf: levels, progress to the next, a lapse, and what needs setting up", async () => {
    happy(62);
    renderAt("/portfolio?tab=review");
    await screen.findByText("62");
    const shelf = within(screen.getByTestId("credentials-shelf"));
    expect(shelf.getByText(/do not affect going live/)).toBeInTheDocument();
    const acceptor = within(screen.getByTestId("credential-loss_acceptor"));
    expect(acceptor.getByText("Bronze")).toBeInTheDocument();
    expect(acceptor.getByRole("meter", { name: "Loss Acceptor" })).toHaveAttribute("aria-valuenow", "48"); // 12 of 25
    expect(acceptor.getByText(/12 of 25 losses taken as planned in a row/)).toBeInTheDocument();
    const keeper = within(screen.getByTestId("credential-risk_keeper"));
    expect(keeper.getByText("Not yet")).toBeInTheDocument();
    expect(keeper.getByText(/You held Bronze before. The run broke at 22/)).toBeInTheDocument();
    const closer = within(screen.getByTestId("credential-day_closer"));
    expect(closer.getByText(/Set a daily loss limit on this account/)).toBeInTheDocument();
    expect(closer.queryByRole("meter")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("credential-calm_under_pressure")).getByText(/Fear mistakes in your last 30 trades: 13%/)).toBeInTheDocument();
  });

  it("shows what price did after an early exit, and each trade's exit in plain words", async () => {
    happy(62);
    renderAt("/portfolio?tab=review");
    await screen.findByText("62");
    const list = within(screen.getByTestId("discipline-trades"));
    expect(list.getByText(/Trailed too tight/)).toBeInTheDocument();
    expect(list.getByText(/Stopped out as planned/)).toBeInTheDocument();
    expect(list.getByTestId("what-if")).toHaveTextContent("Price went another 1.4R your way after you left, and reached your target.");
  });
});
