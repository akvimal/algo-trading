import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AuthProvider } from "../auth/AuthContext";
import { setToken } from "../auth/token";
import { FakeWebSocket } from "../test/fakeSocket";

function jwt(claims: object): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { url: string; method: string; body: any };
let calls: Call[];
let account: Record<string, any>;
let regime: Record<string, any>;
let placeManual: (body: any) => Response;
let placeOption: (body: any) => Response;
let waiting: Record<string, any>[];
let lotSize: number;
let resolveFor: (u: string) => Record<string, any>;
let attachFails: boolean;

const candles = Array.from({ length: 30 }, (_, i) => ({
  exchange: "NSE", symbol: "X", interval: "15min", open: 1000 + i, high: 1005 + i, low: 995 + i, close: 1002 + i, volume: 1, timestamp: `2026-09-25T${String(9 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}:00+05:30`, provider: "dhan",
}));

beforeEach(() => {
  calls = [];
  lotSize = 1;
  attachFails = false;
  waiting = [];
  account = {
    segment: "NSE", starting_balance: 200000, current_balance: 200000, realized_pnl: 0, unrealized_pnl: 0, capital_per_trade: 100000,
    max_daily_loss: null, live_trading_enabled: false, apply_charges: false, require_stop_loss: false, square_off_time: null,
    risk_per_trade_pct: 1, min_reward_risk_ratio: 2, enforce_risk_based_lots: false, slippage_bps: 0, max_order_value: null, live_trading_consent_at: null,
  };
  regime = { regime: "trending_up", adx: 30, atr_percentile: 40, trend: "up", advice: "x" };
  placeManual = () => json({ id: "p1", status: "OPEN" });
  placeOption = () => json({ id: "g1", status: "OPEN" });
  resolveFor = (u) => ({ chart_symbol: u, chart_exchange: "NSE", trade_symbol: u, trade_exchange: "NSE", lot_size: lotSize, expiry: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (url.includes("/instruments/resolve")) return json(resolveFor(new URL(url).searchParams.get("underlying")!));
      if (url.includes("/quotes/ltp")) return json({ exchange: "NSE", symbol: "X", ltp: 1000, provider: "dhan" });
      if (url.includes("/candles/history")) return json(candles);
      if (url.includes("/regime")) return json(regime);
      if (url.endsWith("/accounts")) return json([account]);
      if (url.includes("/pending-orders") && method === "POST")
        return json({ id: "w1", segment: "NSE", symbol: body.symbol, action: body.action, strategy: body.strategy, trigger_price: body.trigger_price, stop_loss_price: body.stop_loss_price ?? null, target_price: body.target_price ?? null, status: "pending", status_reason: null, expires_at: "2026-09-27T00:00:00Z", last_price: null }, 201);
      if (url.includes("/pending-orders") && method === "DELETE") {
        waiting = [];
        return json({ id: "w1", status: "cancelled" });
      }
      if (url.includes("/pending-orders")) return json(waiting);
      if (url.endsWith("/positions/manual")) return placeManual(body);
      if (url.endsWith("/option-groups/manual")) return placeOption(body);
      if (url.includes("/spot-stop-loss") || url.includes("/spot-target")) return attachFails ? json({ detail: "no" }, 409) : json({ ok: true });
      if (url.includes("/positions") || url.includes("/option-groups")) return json([]);
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
const posts = (part: string) => calls.filter((c) => c.method === "POST" && c.url.includes(part));
const puts = (part: string) => calls.filter((c) => c.method === "PUT" && c.url.includes(part));

async function ticket() {
  // The live price arrives after the account; a ticket used before it would (rightly) refuse to place.
  await waitFor(() => expect(screen.getByTestId("price")).toHaveTextContent("1,000"));
  return within(await screen.findByTestId("ticket"));
}

describe("the page", () => {
  it("shows the price, a chart with a written summary, and the guided ticket", async () => {
    renderAt("/trade?symbol=RELIANCE&segment=NSE");
    await waitFor(() => expect(screen.getByTestId("price")).toHaveTextContent("1,000"));
    await waitFor(() => expect(screen.getByRole("img", { name: /Price chart of 30 candles/ })).toBeInTheDocument());
    const t = await ticket();
    expect(t.getByText("Paper order")).toBeInTheDocument();
    expect(t.getByText("Before you place")).toBeInTheDocument();
    expect(t.getByLabelText("Number of shares")).toBeInTheDocument(); // a stock: shares, not lots
    expect(t.queryByRole("button", { name: "Option" })).not.toBeInTheDocument(); // no options on a stock
  });

  it("offers futures and options on an index, in lots", async () => {
    lotSize = 65;
    renderAt("/trade?symbol=NIFTY");
    const t = await ticket();
    expect(await t.findByLabelText("Number of lots")).toBeInTheDocument();
    expect(t.getByRole("button", { name: "Option spread" })).toBeInTheDocument();
    expect(t.getByText(/One lot is 65 units/)).toBeInTheDocument();
  });

  it("marks the plan on the chart and shows the risk in rupees as you type", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.type(t.getByLabelText("Target"), "1030");
    const summary = within(t.getByTestId("summary"));
    expect(summary.getByText("100 (auto)")).toBeInTheDocument();
    expect(summary.getByText("₹1,000")).toBeInTheDocument(); // risk
    expect(summary.getByText("₹3,000")).toBeInTheDocument(); // reward
    expect(summary.getByText("3.0 : 1")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Marked levels: .*Stop 990.*Target 1,030/ })).toBeInTheDocument();
  });

  it("scores the setup: with the trend is in favour, against it is not", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.type(t.getByLabelText("Target"), "1030");
    const checks = within(await t.findByTestId("checks"));
    await waitFor(() => expect(checks.getByText("Regime: trending up")).toBeInTheDocument());
    expect(checks.getByText(/4 of 4 in favour/)).toBeInTheDocument();
    await user.click(t.getByRole("button", { name: "Sell" }));
    await user.clear(t.getByLabelText("Stop-loss"));
    await user.clear(t.getByLabelText("Target"));
    await user.type(t.getByLabelText("Stop-loss"), "1010");
    await user.type(t.getByLabelText("Target"), "970");
    expect(await checks.findByText("You are trading against the trend.")).toBeInTheDocument();
    expect(checks.getByRole("img", { name: "Against" })).toBeInTheDocument();
  });
});

describe("placing", () => {
  it("places a market order at the live price, sized by the server from the stop, and links to Portfolio", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.type(t.getByLabelText("Target"), "1030");
    await user.selectOptions(t.getByLabelText(/Why this trade/), "Breakout");
    await user.click(t.getByRole("button", { name: "4" }));
    await user.click(t.getByRole("button", { name: /Buy RELIANCE, paper order/ }));
    await waitFor(() => expect(posts("/positions/manual")).toHaveLength(1));
    expect(posts("/positions/manual")[0].body).toMatchObject({
      segment: "NSE", symbol: "RELIANCE", action: "BUY", instrument_type: "spot", price: 1000, order_type: "market",
      stop_loss_price: 990, target_price: 1030, setup_tag: "Breakout", confidence: 4, risk_managed: true, trend_followed: true, entry_interval: "15min",
    });
    expect("quantity" in posts("/positions/manual")[0].body).toBe(false);
    expect(await t.findByText("Paper order placed.")).toBeInTheDocument();
    expect(t.getByRole("link", { name: "See it in Portfolio" })).toHaveAttribute("href", "/portfolio?tab=positions");
  });

  it("will not place without a stop-loss when the account requires one, and says why", async () => {
    account.require_stop_loss = true;
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    const button = t.getByRole("button", { name: /Buy RELIANCE/ });
    expect(button).toBeDisabled();
    expect(t.getByText(/require a stop-loss/)).toBeInTheDocument();
    await user.type(t.getByLabelText("Stop-loss (required)"), "990");
    expect(button).toBeEnabled();
  });

  it("blocks a stop on the wrong side before it reaches the server", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "1010");
    expect(t.getByText(/stop-loss must be below/)).toBeInTheDocument();
    expect(t.getByRole("button", { name: /Buy RELIANCE/ })).toBeDisabled();
    expect(posts("/positions/manual")).toHaveLength(0);
  });

  it("shows the server's reason when it rejects the order, and keeps the ticket", async () => {
    placeManual = () => json({ id: "p1", status: "REJECTED", rejection_reason: "insufficient account balance" });
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.click(t.getByRole("button", { name: /Buy RELIANCE/ }));
    expect(await t.findByRole("alert")).toHaveTextContent("insufficient account balance");
    expect(t.getByText("Not placed")).toBeInTheDocument();
    expect(t.getByLabelText("Stop-loss")).toHaveValue("990");
  });

  it("shows a request error (for example a 422) in words", async () => {
    placeManual = () => json({ detail: "stop_loss_price must be below entry" }, 422);
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.click(t.getByRole("button", { name: /Buy RELIANCE/ }));
    expect(await t.findByRole("alert")).toHaveTextContent("stop_loss_price must be below entry");
  });

  it("sends the size when typed by hand", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.type(t.getByLabelText("Number of shares"), "7");
    await user.click(t.getByRole("button", { name: /Buy RELIANCE/ }));
    await waitFor(() => expect(posts("/positions/manual")).toHaveLength(1));
    expect(posts("/positions/manual")[0].body).toMatchObject({ quantity: 7, risk_managed: false });
  });
});

describe("waiting orders", () => {
  it("arms a limit order on the server at the typed level, and lists it with a cancel", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.click(t.getByRole("button", { name: "Wait for a price" }));
    await user.type(t.getByLabelText("Enter when the price reaches"), "980");
    await user.type(t.getByLabelText("Stop-loss"), "970");
    waiting = [{ id: "w1", segment: "NSE", symbol: "RELIANCE", action: "BUY", strategy: "future", trigger_price: 980, stop_loss_price: 970, target_price: null, status: "pending", status_reason: null, expires_at: "x", last_price: null }];
    await user.click(t.getByRole("button", { name: /Buy RELIANCE, wait for price/ }));
    await waitFor(() => expect(posts("/pending-orders")).toHaveLength(1));
    expect(posts("/pending-orders")[0].body).toMatchObject({ segment: "NSE", symbol: "RELIANCE", action: "BUY", trigger_price: 980, stop_loss_price: 970, strategy: "future" });
    expect(await t.findByText(/placed when the price reaches 980/)).toBeInTheDocument();
    expect(t.queryByRole("link", { name: "See it in Portfolio" })).not.toBeInTheDocument(); // a waiting order is not a position yet
    const list = within(await screen.findByTestId("waiting"));
    expect(list.getByText("980")).toBeInTheDocument();
    await user.click(list.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/pending-orders/w1"))).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("waiting")).not.toBeInTheDocument());
  });

  it("needs a price for a limit order", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const t = await ticket();
    await user.click(t.getByRole("button", { name: "Wait for a price" }));
    expect(t.getByText(/Enter the price you want/)).toBeInTheDocument();
    expect(t.getByRole("button", { name: /wait for price/ })).toBeDisabled();
  });
});

describe("options", () => {
  const spread = async () => {
    lotSize = 65;
    const user = userEvent.setup();
    renderAt("/trade?symbol=NIFTY");
    const t = await ticket();
    await user.click(await t.findByRole("button", { name: "Option spread" }));
    await user.selectOptions(t.getByLabelText("Strike"), "OTM1");
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.type(t.getByLabelText("Target"), "1030");
    await user.click(t.getByRole("button", { name: /Buy NIFTY/ }));
    return { user, t };
  };

  it("opens the spread, then attaches the stop and target on the underlying", async () => {
    const { t } = await spread();
    await waitFor(() => expect(posts("/option-groups/manual")).toHaveLength(1));
    expect(posts("/option-groups/manual")[0].body).toMatchObject({ segment: "NSE", symbol: "NIFTY", option_position_style: "spread", option_strike_moneyness: "OTM1", order_type: "market" });
    await waitFor(() => expect(puts("/option-groups/g1/spot-stop-loss")).toHaveLength(1));
    expect(puts("/option-groups/g1/spot-stop-loss")[0].body).toEqual({ spot_stop_loss_price: 990 });
    expect(puts("/option-groups/g1/spot-target")[0].body).toEqual({ spot_target_price: 1030 });
    expect(await t.findByText("Paper order placed.")).toBeInTheDocument();
    expect(t.queryByText(/did not attach/)).not.toBeInTheDocument();
  });

  it("says so when the stop would not attach, rather than pretending it is protected", async () => {
    attachFails = true;
    const { t } = await spread();
    expect(await t.findByText(/stop-loss and target did not attach/)).toBeInTheDocument();
  });
});

describe("safety", () => {
  it("never shows an order ticket for an account that is live", async () => {
    account.live_trading_enabled = true;
    renderAt("/trade?symbol=RELIANCE");
    expect(await screen.findByText(/set to live trading/)).toBeInTheDocument();
    expect(screen.queryByTestId("ticket")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/more/settings?tab=broker");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("starts a clean ticket when the instrument changes", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    let t = await ticket();
    await user.type(t.getByLabelText("Stop-loss"), "990");
    await user.click(screen.getByRole("button", { name: "Bank Nifty" }));
    t = await ticket();
    await waitFor(() => expect(t.getByLabelText("Stop-loss")).toHaveValue(""));
  });
});

describe("Scan to Trade", () => {
  it("opens the stock that the scan linked to", async () => {
    renderAt("/trade?symbol=M%26M&segment=NSE");
    expect(await screen.findByRole("heading", { name: "Trade" })).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("underlying=M%26M"))).toBe(true);
  });
});

describe("live price push", () => {
  const openSocket = async () => {
    await waitFor(() => expect(FakeWebSocket.last).toBeDefined());
    await waitFor(() => expect(FakeWebSocket.last!.readyState === FakeWebSocket.OPEN || FakeWebSocket.last!.sent.length === 0).toBe(true));
    act(() => FakeWebSocket.last!.open());
    return FakeWebSocket.last!;
  };

  it("subscribes to the series it is charting, and follows the price as it moves", async () => {
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price")).toHaveTextContent("1,000"));
    const socket = await openSocket();
    await waitFor(() => expect(socket.sent).toContainEqual({ action: "subscribe", exchange: "NSE", symbol: "RELIANCE" }));
    expect(screen.getByTestId("feed")).toHaveTextContent("Live");
    act(() => socket.push({ type: "tick", exchange: "NSE", symbol: "RELIANCE", price: 1012.5 }));
    expect(screen.getByTestId("price")).toHaveTextContent("1,012.5");
    // the chart moves with it, not only at the next candle download
    expect(screen.getByRole("img", { name: /Last close 1,012\.5/ })).toBeInTheDocument();
  });

  it("uses the pushed price for a market order and for the risk on the ticket", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const socket = await openSocket();
    await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    act(() => socket.push({ type: "tick", exchange: "NSE", symbol: "RELIANCE", price: 1010 }));
    await waitFor(() => expect(screen.getByTestId("price")).toHaveTextContent("1,010"));
    const t = within(await screen.findByTestId("ticket"));
    await user.type(t.getByLabelText("Stop-loss"), "1000");
    expect(within(t.getByTestId("summary")).getByText("1,010")).toBeInTheDocument(); // entry
    await user.click(t.getByRole("button", { name: /Buy RELIANCE/ }));
    await waitFor(() => expect(posts("/positions/manual")).toHaveLength(1));
    expect(posts("/positions/manual")[0].body).toMatchObject({ price: 1010, stop_loss_price: 1000 });
  });

  it("ignores a tick for some other symbol", async () => {
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price")).toHaveTextContent("1,000"));
    const socket = await openSocket();
    act(() => socket.push({ type: "tick", exchange: "NSE", symbol: "TCS", price: 4000 }));
    expect(screen.getByTestId("price")).toHaveTextContent("1,000");
  });

  it("says it is polling when the socket is down, and goes back to Live when it returns", async () => {
    renderAt("/trade?symbol=RELIANCE");
    await waitFor(() => expect(screen.getByTestId("price")).toHaveTextContent("1,000"));
    expect(screen.getByTestId("feed")).toHaveTextContent("every 5 seconds");
    const socket = await openSocket();
    expect(screen.getByTestId("feed")).toHaveTextContent("Live");
    act(() => socket.drop());
    expect(screen.getByTestId("feed")).toHaveTextContent("every 5 seconds");
  });

  it("does not carry the old symbol's price to the new one", async () => {
    const user = userEvent.setup();
    renderAt("/trade?symbol=RELIANCE");
    const socket = await openSocket();
    await waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    act(() => socket.push({ type: "tick", exchange: "NSE", symbol: "RELIANCE", price: 1555 }));
    expect(screen.getByTestId("price")).toHaveTextContent("1,555");
    await user.click(screen.getByRole("button", { name: "Bank Nifty" }));
    await waitFor(() => expect(screen.getByTestId("price")).toHaveTextContent("1,000")); // this symbol's own quote
    expect(screen.getByTestId("price")).not.toHaveTextContent("1,555");
  });
});
