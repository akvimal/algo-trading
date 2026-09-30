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

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let review: () => Response;

const base = (over: object) => ({
  id: "t1", symbol: "TCS", exchange: "NSE", segment: "NSE", action: "BUY", horizon: "intraday", instrument_type: "spot", quantity: 1,
  entry_price: 1, entry_time: "2026-09-26T03:00:00Z", exit_price: 2, exit_time: "2026-09-26T05:00:00Z", pnl: 180, status: "CLOSED",
  stop_loss_price: null, target_price: null, option_group_id: null, exit_reason: "target", reviewed_at: null, strategy_id: null, ...over,
});
let positions: object[];
let groups: object[];

const checklist = [
  { id: "c1", label: "Stayed per plan", phase: "review", segments: [], sort_order: 1, active: true },
  { id: "c2", label: "Only MCX rule", phase: "review", segments: ["MCX"], sort_order: 2, active: true },
  { id: "c3", label: "Plan item", phase: "plan", segments: [], sort_order: 3, active: true },
];

beforeEach(() => {
  calls = [];
  review = () => json({ ok: true });
  positions = [base({ id: "t1" })];
  groups = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/review")) return review();
      if (method === "PUT") return json({ ok: true });
      if (url.includes("/checklist-items")) return json(checklist);
      if (url.includes("/equity-history/")) return json({ segment: "NSE", days: 90, points: [], stats: null });
      if (url.includes("/performance/")) return json({ segment: "NSE", scope: "epoch", since: null, performance: null, equity: null, discipline: { score: null, window_days: 30, window_start: null, trade_count: 0, planned: { rate: null, trades: 0 }, plan_adherence: { rate: null, trades: 0 }, plan_review: { rate: null, trades: 0, before_rate: null, after_rate: null }, outcome: { rate: null, trades: 0, win_rate: null, avg_r: null } } });
      if (url.includes("/live-eligibility/")) return json({ segment: "NSE", enforced: false, eligible: false, requirements: [] });
      if (url.includes("/option-groups")) return json(groups);
      if (url.includes("/positions")) return json(positions);
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
  setToken(jwt({ sub: "u1", email: "me@x.com", exp: Math.floor(Date.now() / 1000) + 3600 }), "me@x.com");
});
afterEach(() => vi.unstubAllGlobals());

async function openFirstTrade(path = "/portfolio?tab=history") {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  const history = await screen.findByTestId("history");
  await user.click(within(history).getAllByRole("button", { expanded: false })[0]);
  const journal = await screen.findByTestId("trade-journal");
  return { user, journal };
}
const puts = () => calls.filter((c) => c.method === "PUT");

describe("tags, confidence and notes", () => {
  it("sets a setup, and tapping it again clears it", async () => {
    const { user, journal } = await openFirstTrade();
    await user.click(within(journal).getByRole("button", { name: "Breakout" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toMatchObject({ url: expect.stringContaining("/positions/t1/tags"), body: { setup_tag: "Breakout" } });
    expect(within(journal).getByRole("button", { name: "Breakout" })).toHaveAttribute("aria-pressed", "true");

    await user.click(within(journal).getByRole("button", { name: "Breakout" }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1].body).toEqual({ setup_tag: "" });
    expect(within(journal).getByRole("button", { name: "Breakout" })).toHaveAttribute("aria-pressed", "false");
  });

  it("sends only the confidence when confidence is chosen", async () => {
    const { user, journal } = await openFirstTrade();
    await user.click(within(journal).getByRole("button", { name: "4" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].body).toEqual({ confidence: 4 });
  });

  it("saves a trimmed note, and only once it has changed", async () => {
    const { user, journal } = await openFirstTrade();
    const save = within(journal).getByRole("button", { name: "Save note" });
    expect(save).toBeDisabled();
    await user.type(within(journal).getByLabelText("Note"), "  chased it  ");
    await user.click(save);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toMatchObject({ url: expect.stringContaining("/positions/t1/notes"), body: { notes: "chased it" } });
    await waitFor(() => expect(within(journal).getByRole("button", { name: "Save note" })).toBeDisabled());
  });

  it("shows the server's message when a save fails, and keeps the choice unset", async () => {
    const { user, journal } = await openFirstTrade();
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "position not found" }, 404)));
    await user.click(within(journal).getByRole("button", { name: "News" }));
    expect(await within(journal).findByRole("alert")).toHaveTextContent("position not found");
    expect(within(journal).getByRole("button", { name: "News" })).toHaveAttribute("aria-pressed", "false");
  });

  it("uses the option-group routes for an options trade", async () => {
    positions = [];
    groups = [{ id: "g1", underlying_symbol: "NIFTY", strategy_type: "naked_call", action: "BUY", horizon: "intraday", quantity: 1, net_debit: 1, status: "CLOSED", pnl: 100, entry_time: "2026-09-26T03:00:00Z", exit_time: "2026-09-26T05:00:00Z", segment: "NSE", reviewed_at: null, strategy_id: null }];
    const { user, journal } = await openFirstTrade();
    await user.click(within(journal).getByRole("button", { name: "Breakout" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].url).toContain("/option-groups/g1/tags");
  });
});

describe("review", () => {
  it("cannot be saved until the person answers, and a loss must be accepted", async () => {
    positions = [base({ id: "t1", pnl: -450 })];
    const { user, journal } = await openFirstTrade();
    const save = within(journal).getByRole("button", { name: "Save review" });
    expect(save).toBeDisabled();
    await user.click(within(journal).getByRole("button", { name: "Yes" }));
    await user.click(save);
    expect(await within(journal).findByRole("alert")).toHaveTextContent(/accept this loss/);
    expect(calls.some((c) => c.url.includes("/review"))).toBe(false); // caught before the request
    await user.click(within(journal).getByLabelText("I accept this loss"));
    await user.click(save);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/review"))).toBe(true));
  });

  it("asks what went differently when the plan was not followed", async () => {
    const { user, journal } = await openFirstTrade();
    await user.click(within(journal).getByRole("button", { name: "No" }));
    await user.click(within(journal).getByRole("button", { name: "Save review" }));
    expect(await within(journal).findByRole("alert")).toHaveTextContent(/differently/);
    await user.type(within(journal).getByLabelText("What did you do differently?"), "moved my stop");
    await user.click(within(journal).getByRole("button", { name: "Save review" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].body).toMatchObject({ violation: true, notes: "moved my stop", accepted_loss: false });
  });

  it("sends the review checklist as a snapshot: this segment's review items only", async () => {
    const { user, journal } = await openFirstTrade();
    await within(journal).findByLabelText("Stayed per plan");
    expect(within(journal).queryByLabelText("Only MCX rule")).not.toBeInTheDocument();
    expect(within(journal).queryByLabelText("Plan item")).not.toBeInTheDocument();
    await user.click(within(journal).getByLabelText("Stayed per plan"));
    await user.click(within(journal).getByRole("button", { name: "Yes" }));
    await user.click(within(journal).getByRole("button", { name: "Save review" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toMatchObject({
      url: expect.stringContaining("/positions/t1/review"),
      body: { violation: false, accepted_loss: false, checklist: [{ label: "Stayed per plan", checked: true }] },
    });
  });

  it("refreshes the list after saving so the trade shows as reviewed", async () => {
    const { user, journal } = await openFirstTrade();
    const before = calls.filter((c) => c.url.includes("/positions")).length;
    positions = [base({ id: "t1", reviewed_at: "2026-09-26T07:00:00Z", review_violation: false })];
    await user.click(within(journal).getByRole("button", { name: "Yes" }));
    await user.click(within(journal).getByRole("button", { name: "Save review" }));
    expect(await screen.findByText("You followed your plan.")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.includes("/positions")).length).toBeGreaterThan(before);
    expect(screen.queryByRole("button", { name: "Save review" })).not.toBeInTheDocument();
  });

  it("shows the server's refusal and lets the person try again", async () => {
    review = () => json({ detail: "position already reviewed" }, 409);
    const { user, journal } = await openFirstTrade();
    await user.click(within(journal).getByRole("button", { name: "Yes" }));
    await user.click(within(journal).getByRole("button", { name: "Save review" }));
    expect(await within(journal).findByRole("alert")).toHaveTextContent("position already reviewed");
    expect(within(journal).getByRole("button", { name: "Save review" })).toBeEnabled();
  });

  it("shows a done review read-only, with no form", async () => {
    positions = [base({ id: "t1", reviewed_at: "2026-09-26T07:00:00Z", review_violation: true, review_notes: "moved my stop" })];
    const { journal } = await openFirstTrade();
    expect(within(journal).getByText(/did not follow your plan/)).toBeInTheDocument();
    expect(within(journal).getByText(/moved my stop/)).toBeInTheDocument();
    expect(within(journal).queryByRole("button", { name: "Save review" })).not.toBeInTheDocument();
  });

  it("does not offer a hand review for a strategy's trade, and never counts it as owed", async () => {
    positions = [base({ id: "t1", strategy_id: "s1" })];
    const { journal } = await openFirstTrade();
    expect(within(journal).getByText(/came from a strategy/)).toBeInTheDocument();
    expect(within(journal).queryByRole("button", { name: "Save review" })).not.toBeInTheDocument();
  });
});

describe("Review tab journal", () => {
  it("lists trades to review and opens the same form", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/portfolio?tab=review"]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/1 of 1 closed trades still need a review/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /TCS/ }));
    expect(await screen.findByRole("button", { name: "Save review" })).toBeInTheDocument();
  });
});
