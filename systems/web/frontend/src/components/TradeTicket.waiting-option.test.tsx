import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileProvider } from "../auth/ProfileContext";
import { EMPTY_TICKET, type Ticket } from "../pages/tradeModel";
import { TradeTicket } from "./TradeTicket";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { method: string; url: string; body: any };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/pending-orders") && method === "POST") return json({ id: "o1", status: "pending", trigger_price: 23100 });
      if (url.endsWith("/option-groups/manual")) return json({ id: "g1", status: "OPEN" });
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const ctx = { price: 23000, lotSize: 65, capital: 100000, riskPct: 1, minRR: 2, requireStop: false, segment: "NSE" as const, symbol: "NIFTY" };

// The Scan page's F&O option ticket: the leg table has already chosen the strikes and the expiry.
function Harness({ start }: { start: Partial<Ticket> }) {
  const [t, setT] = useState<Ticket>({ ...EMPTY_TICKET, strategy: "spread", primaryStrike: 23200, secondStrike: 23300, expiry: "2026-10-27", spreadWidth: 2, ...start });
  return (
    <MemoryRouter>
      <ProfileProvider>
      <TradeTicket ticket={t} onChange={setT} ctx={ctx} meta={{ instrument: "future", interval: "15min", trendFollowed: false }} regime={null} budget={null} onPlaced={() => {}} optionsForced hideStrategyChips hideMoneynessField hideOptionExtras />
      </ProfileProvider>
    </MemoryRouter>
  );
}

describe("a waiting order on the F&O option ticket", () => {
  it("offers Market and 'Wait for a price' (it used to offer only Market)", () => {
    render(<Harness start={{}} />);
    expect(screen.getByRole("button", { name: "Market" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Wait for a price" })).toBeInTheDocument();
  });

  it("shows the entry level and the underlying stop and target only for a waiting order", async () => {
    const user = userEvent.setup();
    render(<Harness start={{}} />);
    expect(screen.queryByLabelText(/Enter when the price reaches/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Stop-loss")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Wait for a price" }));
    expect(screen.getByLabelText(/Enter when the price reaches/)).toBeInTheDocument();
    expect(screen.getByLabelText("Stop-loss")).toBeInTheDocument();
    expect(screen.getByLabelText("Target")).toBeInTheDocument();
    expect(screen.getByTestId("waiting-option-note")).toHaveTextContent(/leg table/);
  });

  it("arms the order with the exact strikes and expiry the table showed, and the reason", async () => {
    const user = userEvent.setup();
    render(<Harness start={{}} />);
    await user.click(screen.getByRole("button", { name: "Wait for a price" }));
    await user.type(screen.getByLabelText(/Enter when the price reaches/), "23100");
    await user.type(screen.getByLabelText("Stop-loss"), "22900");
    await user.type(screen.getByLabelText("Target"), "23400");
    await user.type(screen.getByPlaceholderText("What made you take this trade?"), "retest of the breakout");
    await user.click(screen.getByRole("button", { name: /wait for price/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/pending-orders"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/pending-orders"))!.body).toMatchObject({
      strategy: "spread", symbol: "NIFTY", trigger_price: 23100, stop_loss_price: 22900, target_price: 23400,
      primary_strike: 23200, second_strike: 23300, expiry: "2026-10-27", spread_width: 2, notes: "retest of the breakout",
    });
    expect(await screen.findByText(/Waiting/)).toBeInTheDocument();
  });

  it("will not arm without a level to wait for", async () => {
    const user = userEvent.setup();
    render(<Harness start={{}} />);
    await user.click(screen.getByRole("button", { name: "Wait for a price" }));
    expect(screen.getByRole("button", { name: /wait for price/ })).toBeDisabled();
  });

  it("a credit spread still cannot wait", () => {
    render(<Harness start={{ strategy: "credit_spread" }} />);
    expect(screen.getByRole("button", { name: "Wait for a price" })).toBeDisabled();
  });
});
