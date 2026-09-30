import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AuthProvider } from "../auth/AuthContext";
import { setToken } from "../auth/token";
import { FakeWebSocket } from "../test/fakeSocket";
import { MAX_LIVE_SYMBOLS, applyLivePrices, liveSubscriptions, priceKey, resultAt } from "./liveModel";

function jwt(claims: object): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const pos = (over: Record<string, any> = {}) => ({
  id: "p1", symbol: "RELIANCE", exchange: "NSE", segment: "NSE", action: "BUY", horizon: "intraday", instrument_type: "spot", quantity: 10,
  entry_price: 1000, entry_time: new Date().toISOString(), exit_price: null, exit_time: null, pnl: null, live_price: 1005, unrealized_pnl: 50,
  status: "OPEN", stop_loss_price: null, target_price: null, option_group_id: null, ...over,
}) as any;

describe("resultAt and applyLivePrices", () => {
  it("values a long and a short against the entry, the way the server does", () => {
    expect(resultAt({ action: "BUY", entry_price: 1000, quantity: 10 }, 1012)).toBe(120);
    expect(resultAt({ action: "SELL", entry_price: 1000, quantity: 10 }, 1012)).toBe(-120);
    expect(resultAt({ action: "SELL", entry_price: 1000, quantity: 0.5 }, 990)).toBe(5);
  });

  it("subscribes to each open spot or futures symbol once, and to nothing else", () => {
    const subs = liveSubscriptions([
      pos({ id: "a" }), pos({ id: "b" }), // same symbol twice
      pos({ id: "c", symbol: "NIFTY-Sep2026-FUT", instrument_type: "future" }),
      pos({ id: "leg", symbol: "NIFTY26SEP24000CE", option_group_id: "g" }), // a leg belongs to its group
      pos({ id: "done", symbol: "TCS", status: "CLOSED" }),
    ]);
    expect(subs.map((s) => s.symbol).sort()).toEqual(["NIFTY-Sep2026-FUT", "RELIANCE"]);
  });

  it("asks for no more symbols than the socket allows, keeping the newest trades live", () => {
    const many = Array.from({ length: 8 }, (_, i) => pos({ id: `p${i}`, symbol: `S${i}`, entry_time: new Date(Date.UTC(2026, 8, 26, 4, i)).toISOString() }));
    const subs = liveSubscriptions(many);
    expect(subs).toHaveLength(MAX_LIVE_SYMBOLS);
    expect(subs.map((s) => s.symbol)).toEqual(["S7", "S6", "S5", "S4", "S3"]);
  });

  it("re-values an open position at the pushed price and reports how much its account moved", () => {
    const { positions, delta } = applyLivePrices([pos({}), pos({ id: "p2", symbol: "MCXGOLD", segment: "MCX", exchange: "MCX", action: "SELL", entry_price: 100, quantity: 2, unrealized_pnl: 4 })], {
      [priceKey("NSE", "RELIANCE")]: 1020, [priceKey("MCX", "MCXGOLD")]: 99,
    });
    expect(positions[0]).toMatchObject({ live_price: 1020, unrealized_pnl: 200 });
    expect(positions[1]).toMatchObject({ live_price: 99, unrealized_pnl: 2 });
    expect(delta).toEqual({ NSE: 150, MCX: -2 }); // 200 against the server's 50; 2 against its 4
  });

  it("counts the whole result as new when the server had no quote for it", () => {
    expect(applyLivePrices([pos({ unrealized_pnl: null })], { [priceKey("NSE", "RELIANCE")]: 1010 }).delta).toEqual({ NSE: 100 });
  });

  it("leaves alone what has no price yet, a closed position, an option leg, and a price that makes no sense", () => {
    const rows = [pos({ id: "noprice", symbol: "TCS" }), pos({ id: "closed", status: "CLOSED" }), pos({ id: "leg", option_group_id: "g" }), pos({ id: "bad", symbol: "INFY" })];
    const out = applyLivePrices(rows, { [priceKey("NSE", "RELIANCE")]: 2000, [priceKey("NSE", "INFY")]: Number.NaN });
    expect(out.positions[0]).toBe(rows[0]);
    expect(out.positions[1]).toBe(rows[1]);
    expect(out.positions[2]).toBe(rows[2]); // shares RELIANCE's symbol, but it is a leg
    expect(out.positions[3]).toBe(rows[3]);
    expect(out.delta).toEqual({});
  });
});

describe("live results on Today and Portfolio", () => {
  let positions: any[];
  let account: any;

  beforeEach(() => {
    positions = [pos({})];
    account = { segment: "NSE", starting_balance: 200000, current_balance: 200000, realized_pnl: 0, unrealized_pnl: 50, max_daily_loss: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/profile") || url.includes("/auth/me")) return json({ id: "u1", email: "me@x.com", experience: "pro", onboarded_at: "2026-09-01T00:00:00Z", markets: ["NSE"] });
        if (url.endsWith("/accounts")) return json([account]);
        if (url.includes("/positions")) return json(url.includes("status=OPEN") || !url.includes("status=") ? positions : []);
        if (url.includes("/option-groups")) return json([]);
        if (url.includes("/options/sentiment")) return json({ exchanges: {} });
        return json({ detail: `unrouted ${url}` }, 404);
      }),
    );
    setToken(jwt({ sub: "u1", email: "me@x.com", exp: Math.floor(Date.now() / 1000) + 3600 }), "me@x.com");
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderAt = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
  const openSocket = async () => {
    await waitFor(() => expect(FakeWebSocket.last).toBeDefined());
    act(() => FakeWebSocket.last!.open());
    await waitFor(() => expect(FakeWebSocket.last!.sent.some((f) => f.action === "subscribe")).toBe(true));
    return FakeWebSocket.last!;
  };
  const tick = (s: FakeWebSocket, symbol: string, price: number) => act(() => s.push({ type: "tick", exchange: "NSE", symbol, price }));

  it("Today: a pushed price moves the position's result, the day's total and the balance, and marks the page live", async () => {
    renderAt("/");
    const card = within(await screen.findByTestId("position-card"));
    expect(card.getByText("+₹50")).toBeInTheDocument();
    expect(screen.queryByTestId("live-today")).not.toBeInTheDocument(); // not until the socket is up
    const socket = await openSocket();
    expect(socket.sent).toContainEqual({ action: "subscribe", exchange: "NSE", symbol: "RELIANCE" });
    expect(await screen.findByTestId("live-today")).toBeInTheDocument();
    tick(socket, "RELIANCE", 1030);
    await waitFor(() => expect(card.getByText("+₹300")).toBeInTheDocument()); // (1,030 − 1,000) × 10
    expect(within(screen.getByLabelText("Today's profit and loss")).getByText("+₹300")).toBeInTheDocument();
    expect(screen.getByText("₹2,00,300")).toBeInTheDocument(); // 2,00,000 balance + the 300 now open (the server said 50, it has moved 250 since)
    tick(socket, "RELIANCE", 990);
    await waitFor(() => expect(card.getByText("−₹100")).toBeInTheDocument());
  });

  it("Today: another symbol's tick changes nothing", async () => {
    renderAt("/");
    const card = within(await screen.findByTestId("position-card"));
    const socket = await openSocket();
    tick(socket, "TCS", 4000);
    expect(card.getByText("+₹50")).toBeInTheDocument();
  });

  it("Today: while the socket is down the polled figures stand, and it is not marked live", async () => {
    renderAt("/");
    const card = within(await screen.findByTestId("position-card"));
    const socket = await openSocket();
    tick(socket, "RELIANCE", 1030);
    await waitFor(() => expect(card.getByText("+₹300")).toBeInTheDocument());
    act(() => socket.drop());
    await waitFor(() => expect(card.getByText("+₹50")).toBeInTheDocument());
    expect(screen.queryByTestId("live-today")).not.toBeInTheDocument();
  });

  it("Today: a short is valued the other way round", async () => {
    positions = [pos({ action: "SELL", unrealized_pnl: -50 })];
    renderAt("/");
    const card = within(await screen.findByTestId("position-card"));
    const socket = await openSocket();
    tick(socket, "RELIANCE", 980);
    await waitFor(() => expect(card.getByText("+₹200")).toBeInTheDocument());
  });

  it("Today: subscribes to nothing when there are no open positions", async () => {
    positions = [];
    renderAt("/");
    await screen.findByText("Nothing open here");
    const socket = FakeWebSocket.last;
    if (socket) expect(socket.sent.filter((f) => f.action === "subscribe")).toEqual([]);
  });

  it("Portfolio: the Positions tab is live too, and says so", async () => {
    renderAt("/portfolio?tab=positions");
    const card = within(await screen.findByTestId("position-card"));
    expect(card.getByText("+₹50")).toBeInTheDocument();
    const socket = await openSocket();
    expect(await screen.findByTestId("live-positions")).toBeInTheDocument();
    tick(socket, "RELIANCE", 1015);
    await waitFor(() => expect(card.getByText("+₹150")).toBeInTheDocument());
  });
});
