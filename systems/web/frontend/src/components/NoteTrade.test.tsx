import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteTrade as Trade } from "../api/planTrade";
import type { StudyNote } from "../api/types";
import { NoteTrade } from "./NoteTrade";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { method: string; url: string; body: any };
let calls: Call[];
let manualResult: any;

const note = (over: Partial<StudyNote> = {}): StudyNote =>
  ({ id: "n1", segment: "NSE", symbol: "RELIANCE", interval: "daily", text: "Buy the bounce off the 50 DMA", tag: "plan", context: null, position_id: null, option_group_id: null, has_snapshot: false, created_at: null, ...over }) as StudyNote;

const pos = { id: "p", status: "OPEN", action: "BUY" as const, horizon: "positional", quantity: 10, entry_price: 1000, exit_price: null, pnl: null, exit_reason: null, stop_loss_price: 950, initial_stop_loss_price: 950, target_price: 1100, segment: "NSE" };
const order = { id: "o1", status: "pending", status_reason: null, trigger_price: 980, stop_loss_price: 950, target_price: 1100, expires_at: "", last_price: 1000 };
const trade = (over: Partial<Trade>): Trade => ({ note_id: "n1", state: "open", order: null, position: pos, r_multiple: null, ...over });

beforeEach(() => {
  calls = [];
  manualResult = { id: "p1", status: "OPEN" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      if (url.includes("/quotes/ltp")) return json({ exchange: "NSE", symbol: "RELIANCE", ltp: 1000, provider: "dhan" });
      if (url.endsWith("/positions/manual")) return json(manualResult);
      if (url.endsWith("/pending-orders") && method === "POST") return json({ ...order, id: "o9", trigger_price: body.trigger_price });
      if (url.includes("/pending-orders/") && method === "DELETE") return json({ ...order, status: "cancelled" });
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const view = (n: StudyNote, t: Trade | undefined, onChanged = vi.fn()) => {
  render(
    <MemoryRouter>
      <NoteTrade note={n} trade={t} onChanged={onChanged} />
    </MemoryRouter>,
  );
  return onChanged;
};

describe("which notes get the panel", () => {
  it("only a plan note", () => {
    view(note({ tag: "observation" }), undefined);
    expect(screen.queryByRole("button", { name: "Trade this plan" })).not.toBeInTheDocument();
  });
  it("is offered on a plan note with no trade yet", () => {
    view(note(), undefined);
    expect(screen.getByRole("button", { name: "Trade this plan" })).toBeInTheDocument();
  });
  it("is not offered on MCX, which has no spot", () => {
    view(note({ segment: "MCX" }), undefined);
    expect(screen.queryByRole("button", { name: "Trade this plan" })).not.toBeInTheDocument();
  });
});

describe("placing the plan", () => {
  it("a Market entry opens a positional spot position at the live price and tells the note to refresh", async () => {
    const user = userEvent.setup();
    const changed = view(note(), undefined);
    await user.click(screen.getByRole("button", { name: "Trade this plan" }));
    expect(await screen.findByText(/Live price 1,000/)).toBeInTheDocument();
    const buy = screen.getByRole("button", { name: "Buy now" });
    expect(buy).toBeDisabled(); // no stop yet
    await user.type(screen.getByLabelText("Stop-loss"), "950");
    await user.type(screen.getByLabelText("Target"), "1100");
    await waitFor(() => expect(buy).toBeEnabled());
    expect(screen.getByText(/Reward : risk 2.0 : 1/)).toBeInTheDocument();
    await user.click(buy);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/positions/manual"))).toBe(true));
    const sent = calls.find((c) => c.url.endsWith("/positions/manual"))!.body;
    expect(sent).toMatchObject({ horizon: "positional", instrument_type: "spot", action: "BUY", price: 1000, stop_loss_price: 950, target_price: 1100, source_note_id: "n1" });
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(await screen.findByRole("status")).toHaveTextContent(/positional account/);
  });

  it("a Limit entry arms a waiting order on the server", async () => {
    const user = userEvent.setup();
    view(note(), undefined);
    await user.click(screen.getByRole("button", { name: "Trade this plan" }));
    await user.click(screen.getByRole("button", { name: "Limit" }));
    await user.type(screen.getByLabelText("Limit price"), "980");
    await user.type(screen.getByLabelText("Stop-loss"), "950");
    await user.click(screen.getByRole("button", { name: "Arm the order" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/pending-orders") && c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/pending-orders"))!.body).toMatchObject({ strategy: "spot", horizon: "positional", trigger_price: 980, source_note_id: "n1", expires_in_minutes: 10080 });
  });

  it("shows why a rejected order was refused and keeps the form open", async () => {
    manualResult = { id: "p1", status: "REJECTED", rejection_reason: "insufficient account balance" };
    const user = userEvent.setup();
    view(note(), undefined);
    await user.click(screen.getByRole("button", { name: "Trade this plan" }));
    await screen.findByText(/Live price 1,000/);
    await user.type(screen.getByLabelText("Stop-loss"), "950");
    await user.click(screen.getByRole("button", { name: "Buy now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("insufficient account balance");
    expect(screen.getByTestId("note-trade-form")).toBeInTheDocument();
  });
});

describe("where the trade stands", () => {
  it("a waiting order can be cancelled with a second click", async () => {
    const user = userEvent.setup();
    const changed = view(note(), trade({ state: "waiting", order, position: null }));
    expect(screen.getByTestId("note-trade-status")).toHaveTextContent("Waiting to buy at 980");
    await user.click(screen.getByRole("button", { name: "Cancel order" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel the order?" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/pending-orders/o1"))).toBe(true));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it("an open trade shows its levels and a way to manage it", () => {
    view(note(), trade({}));
    expect(screen.getByTestId("note-trade-status")).toHaveTextContent("Open from 1,000");
    expect(screen.getByTestId("note-trade-status")).toHaveTextContent("stop 950");
    expect(screen.getByRole("link", { name: "Manage" })).toBeInTheDocument();
  });

  it("a closed trade shows how it ended in R", () => {
    view(note(), trade({ state: "closed", position: { ...pos, status: "CLOSED", exit_price: 1100 }, r_multiple: 2 }));
    expect(screen.getByTestId("note-trade-status")).toHaveTextContent("Closed at 1,100 · +2R");
  });

  it("an order that ended can be armed again", () => {
    view(note(), trade({ state: "ended", position: null, order: { ...order, status: "expired", status_reason: "expired before the price reached the trigger" } }));
    expect(screen.getByText(/Last order expired/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trade this plan" })).toBeInTheDocument();
  });
});
