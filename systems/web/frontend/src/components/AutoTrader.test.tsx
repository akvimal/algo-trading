import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoTrader } from "./AutoTrader";

function json(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { method: string; path: string; body: any };
let calls: Call[];
let indicators: any[];
let rules: any[];
let strategies: any[];
let accounts: Record<string, any>;
let tradesFor: { positions: any[]; groups: any[] };
let accountCreateFails: boolean;
let seq: number;

const sent = (method: string, part: string) => calls.filter((c) => c.method === method && c.path.includes(part));

beforeEach(() => {
  calls = [];
  indicators = [];
  rules = [];
  strategies = [];
  accounts = {};
  tradesFor = { positions: [], groups: [] };
  accountCreateFails = false;
  seq = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname + new URL(url).search;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, path, body });
      const id = () => `id${++seq}`;
      const idOf = (prefix: string) => path.slice(prefix.length + 1).split(/[/?]/)[0];

      if (path.startsWith("/indicators")) {
        if (method === "GET") return json(indicators);
        if (method === "POST") {
          const row = { id: id(), ...body };
          indicators.push(row);
          return json(row, 201);
        }
        const row = indicators.find((i) => i.id === idOf("/indicators"))!;
        if (method === "PATCH") return json(Object.assign(row, body));
        if (method === "DELETE") {
          indicators = indicators.filter((i) => i !== row);
          return json(null, 204);
        }
      }
      if (path.startsWith("/rules")) {
        if (method === "GET") return json(rules);
        if (method === "POST") {
          const row = { id: id(), ...body };
          rules.push(row);
          return json(row, 201);
        }
        const row = rules.find((r) => r.id === idOf("/rules"))!;
        if (method === "PATCH") return json(Object.assign(row, body));
        if (method === "DELETE") {
          rules = rules.filter((r) => r !== row);
          return json(null, 204);
        }
      }
      if (path.startsWith("/strategies")) {
        if (method === "GET") return json(strategies);
        if (method === "POST") {
          const row = { id: id(), status: "draft", last_scan_at: null, ...body };
          strategies.push(row);
          return json(row, 201);
        }
        const row = strategies.find((s) => s.id === idOf("/strategies"))!;
        if (method === "PATCH") {
          const { reset_engine_run, ...rest } = body;
          void reset_engine_run;
          return json(Object.assign(row, rest));
        }
        if (method === "DELETE") {
          strategies = strategies.filter((s) => s !== row);
          return json(null, 204);
        }
      }
      if (path.startsWith("/accounts/strategy/")) {
        const sid = idOf("/accounts/strategy");
        if (path.includes("/trades")) return json(tradesFor);
        if (method === "GET") return accounts[sid] ? json(accounts[sid]) : json({ detail: `no dedicated account for strategy ${sid}` }, 404);
        if (method === "DELETE") {
          delete accounts[sid];
          return json({ status: "deleted", strategy_id: sid });
        }
        if (method === "POST") {
          if (accountCreateFails) return json({ detail: "could not verify the strategy with signal-engine - try again shortly" }, 503);
          accounts[sid] = { strategy_id: sid, segment: body.segment, starting_balance: body.starting_balance, current_balance: body.starting_balance, realized_pnl: 0, unrealized_pnl: 0 };
          return json(accounts[sid]);
        }
      }
      return json({ detail: `unrouted ${method} ${path}` }, 404);
    }),
  );
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const card = () => within(screen.getByTestId("auto-trader"));
const renderCard = (symbol = "NIFTY", segment: "NSE" | "MCX" | "CRYPTO" = "NSE", contracts = true) => render(<AutoTrader segment={segment} symbol={symbol} contracts={contracts} />);
const settled = async () => {
  await screen.findByTestId("auto-trader");
  await waitFor(() => expect(sent("GET", "/strategies")).not.toHaveLength(0));
  await waitFor(() => expect(card().getByRole("button", { name: /Turn on|Turn off/ })).not.toBeDisabled());
};

/** A strategy as the server holds it, as though it had been turned on already. */
function existing(over: Record<string, any> = {}, ruleOver: Record<string, any> = {}) {
  indicators.push({ id: "st", name: "Auto-trade ST: NSE:NIFTY", type: "supertrend", params: { period: 10, multiplier: 3 } });
  rules.push({ id: "r1", name: "Auto-trade: NSE:NIFTY", interval: "5min", regime_indicator_ids: [], ...ruleOver });
  strategies.push({
    id: "s1", name: "Auto-trade: NSE:NIFTY", status: "live", last_scan_at: "2026-09-26T04:00:00Z", rule_id: "r1", instrument_type: "future", option_strike_moneyness: null,
    stop_loss_indicator_params: { period: 10, multiplier: 3 }, fixed_lots: 1, active_windows: [], ...over,
  });
  accounts.s1 = { strategy_id: "s1", segment: "NSE", starting_balance: 100000, current_balance: 101500, realized_pnl: 1500, unrealized_pnl: -200 };
}

describe("for an instrument with no contracts", () => {
  it("says the auto-trader is not available, and asks the server for nothing", () => {
    renderCard("RELIANCE", "NSE", false);
    expect(screen.getByText(/A stock is traded as shares/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Turn on" })).not.toBeInTheDocument();
  });
});

describe("turning it on", () => {
  it("starts off, saying what it would do, and asks for confirmation naming the practice money", async () => {
    const user = userEvent.setup();
    renderCard();
    await settled();
    expect(card().getByTestId("auto-status")).toHaveTextContent("Off");
    expect(card().getByTestId("auto-summary")).toHaveTextContent("5m SuperTrend (10, 3) · future · 1 lot");
    await user.click(card().getByRole("button", { name: "Turn on" }));
    const confirm = within(screen.getByTestId("auto-confirm"));
    expect(confirm.getByText(/enters the current trend straight away/)).toBeInTheDocument();
    expect(confirm.getByText(/₹1,00,000 in its own new account/)).toBeInTheDocument();
    expect(sent("POST", "/")).toHaveLength(0); // nothing is created until they confirm
    await user.click(confirm.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("auto-confirm")).not.toBeInTheDocument();
    expect(sent("POST", "/")).toHaveLength(0);
  });

  it("creates the indicator, rule and strategy, then its own practice account, and only then goes live", async () => {
    const user = userEvent.setup();
    renderCard();
    await settled();
    await user.click(card().getByRole("button", { name: "Turn on" }));
    await user.click(within(screen.getByTestId("auto-confirm")).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(card().getByTestId("auto-status")).toHaveTextContent("On"));

    expect(sent("POST", "/indicators")[0].body).toEqual({ name: "Auto-trade ST: NSE:NIFTY", type: "supertrend", params: { period: 10, multiplier: 3 } });
    expect(sent("POST", "/rules")[0].body).toMatchObject({ name: "Auto-trade: NSE:NIFTY", underlying: "NIFTY", interval: "5min", rule_config: { type: "crossover" } });
    expect(sent("POST", "/strategies")[0].body).toMatchObject({
      name: "Auto-trade: NSE:NIFTY", source_type: "in_house", horizon: "intraday", instrument_type: "future", stop_loss_method: "indicator",
      trailing_stop_enabled: true, fixed_lots: 1, counter_signal_policy: "close_and_flip", seed_on_activation: true,
    });
    const account = sent("POST", "/accounts/strategy/")[0];
    expect(account.body).toEqual({ segment: "NSE", starting_balance: 100000, capital_per_trade: 100000, risk_per_trade_pct: 1 });
    const live = sent("PATCH", "/strategies/").find((c) => c.body.status === "live")!;
    expect(live.body).toEqual({ status: "live", reset_engine_run: true });
    // the account exists before it is allowed to trade
    expect(calls.indexOf(account)).toBeLessThan(calls.indexOf(live));
  });

  it("never goes live when its practice account cannot be made, and says why", async () => {
    const user = userEvent.setup();
    accountCreateFails = true;
    renderCard();
    await settled();
    await user.click(card().getByRole("button", { name: "Turn on" }));
    await user.click(within(screen.getByTestId("auto-confirm")).getByRole("button", { name: "Turn on" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not verify the strategy");
    expect(sent("PATCH", "/strategies/").some((c) => c.body.status === "live")).toBe(false);
    expect(strategies[0].status).toBe("draft");
    expect(card().getByTestId("auto-status")).toHaveTextContent("Off");
  });

  it("refuses a setting the server would refuse, in words, and sends nothing", async () => {
    const user = userEvent.setup();
    renderCard();
    await settled();
    await user.click(card().getByRole("button", { name: "Settings" }));
    await user.clear(card().getByLabelText("Average range (candles)"));
    await user.type(card().getByLabelText("Average range (candles)"), "1");
    await user.click(card().getByRole("button", { name: "Turn on" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("2 to 100 candles");
    expect(screen.queryByTestId("auto-confirm")).not.toBeInTheDocument();
    expect(sent("POST", "/")).toHaveLength(0);
  });

  it("uses the chosen settings: interval, numbers, lots, practice money, strike, gate and windows", async () => {
    const user = userEvent.setup();
    renderCard();
    await settled();
    await user.click(card().getByRole("button", { name: "Settings" }));
    await user.selectOptions(card().getByLabelText("What it trades"), "option");
    await user.selectOptions(card().getByLabelText("Strike"), "OTM1");
    await user.selectOptions(card().getByLabelText("Interval"), "15min");
    await user.clear(card().getByLabelText("Average range (candles)"));
    await user.type(card().getByLabelText("Average range (candles)"), "14");
    await user.clear(card().getByLabelText("Multiplier"));
    await user.type(card().getByLabelText("Multiplier"), "2.5");
    await user.clear(card().getByLabelText("Lots per trade"));
    await user.type(card().getByLabelText("Lots per trade"), "2");
    await user.clear(card().getByLabelText("Practice money"));
    await user.type(card().getByLabelText("Practice money"), "250000");
    await user.click(card().getByLabelText(/trend strength \(ADX\)/));
    await user.click(card().getByRole("button", { name: "Add a window" }));
    await user.click(card().getByRole("button", { name: "Turn on" }));
    await user.click(within(screen.getByTestId("auto-confirm")).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(card().getByTestId("auto-status")).toHaveTextContent("On"));

    expect(sent("POST", "/indicators").map((c) => c.body.type).sort()).toEqual(["adx", "dmi_direction", "supertrend"]);
    expect(sent("POST", "/rules")[0].body).toMatchObject({ interval: "15min", regime_indicator_ids: expect.any(Array) });
    expect(sent("POST", "/rules")[0].body.regime_indicator_ids).toHaveLength(2);
    expect(sent("POST", "/strategies")[0].body).toMatchObject({
      instrument_type: "option", option_position_style: "naked", option_strike_moneyness: "OTM1", fixed_lots: 2, stop_loss_interval: "15min",
      stop_loss_indicator_params: { period: 14, multiplier: 2.5 }, active_windows: [{ start: "09:15", end: "15:15" }],
    });
    expect(sent("POST", "/accounts/strategy/")[0].body.starting_balance).toBe(250000);
  });

  it("offers a naked option only where there is one: not for a crypto pair with no options", async () => {
    const user = userEvent.setup();
    renderCard("SOLUSD", "CRYPTO");
    await settled();
    await user.click(card().getByRole("button", { name: "Settings" }));
    expect(within(card().getByLabelText("What it trades")).getByRole("option", { name: /naked option/ })).toBeDisabled();
  });

  it("remembers what was typed for next time", async () => {
    const user = userEvent.setup();
    const first = renderCard();
    await settled();
    await user.click(card().getByRole("button", { name: "Settings" }));
    await user.clear(card().getByLabelText("Lots per trade"));
    await user.type(card().getByLabelText("Lots per trade"), "3");
    first.unmount();
    renderCard();
    await settled();
    expect(card().getByTestId("auto-summary")).toHaveTextContent("3 lots");
  });
});

describe("when one is already set up", () => {
  it("shows what the server is really running, not a stale draft, and how it is doing", async () => {
    existing({ fixed_lots: 4, stop_loss_indicator_params: { period: 7, multiplier: 2 } }, { interval: "15min" });
    localStorage.setItem("web.autotrader.draft", JSON.stringify({ lots: 9, period: 30 }));
    renderCard();
    expect(await screen.findByText(/last checked/)).toBeInTheDocument();
    await waitFor(() => expect(card().getByTestId("auto-summary")).toHaveTextContent("15m SuperTrend (7, 2) · future · 4 lots"));
    expect(card().getByTestId("auto-status")).toHaveTextContent("On");
    expect(card().getByTestId("auto-account")).toHaveTextContent("₹1,01,500");
    expect(card().getByTestId("auto-account")).toHaveTextContent("started with ₹1,00,000");
    expect(card().getByTestId("auto-account")).toHaveTextContent("+₹1,500");
    expect(card().getByTestId("auto-account")).toHaveTextContent("−₹200");
  });

  it("lists what it traded, newest first, with the live result while open and the reason once closed", async () => {
    existing();
    tradesFor = {
      positions: [
        { id: "a", symbol: "NIFTY-Sep2026-FUT", action: "BUY", status: "OPEN", option_group_id: null, entry_time: "2026-09-26T05:00:00Z", unrealized_pnl: 250, pnl: null },
        { id: "b", symbol: "NIFTY-Sep2026-FUT", action: "SELL", status: "CLOSED", option_group_id: null, entry_time: "2026-09-26T04:00:00Z", exit_time: "2026-09-26T04:45:00Z", pnl: -90, exit_reason: "counter_signal" },
        { id: "leg", symbol: "NIFTY26SEP24000CE", action: "BUY", status: "OPEN", option_group_id: "g", entry_time: "2026-09-26T03:00:00Z", unrealized_pnl: 5, pnl: null },
      ],
      groups: [],
    };
    renderCard();
    const list = within(await screen.findByTestId("auto-trades"));
    const rows = list.getAllByText(/NIFTY/);
    expect(rows).toHaveLength(2); // the option leg is not a row
    expect(list.getByText(/closed · counter signal/)).toBeInTheDocument();
    expect(list.getByText("+₹250")).toBeInTheDocument();
    expect(list.getByText("−₹90")).toBeInTheDocument();
    expect(calls.some((c) => c.path.includes("/accounts/strategy/s1/trades?with_live_pnl=true"))).toBe(true);
  });

  it("says so when it has not traded yet", async () => {
    existing();
    renderCard();
    expect(await screen.findByText("No trades yet.")).toBeInTheDocument();
  });

  it("turns off in one click, without asking, and keeps everything else", async () => {
    const user = userEvent.setup();
    existing();
    renderCard();
    await screen.findByText(/last checked/);
    await user.click(card().getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(card().getByTestId("auto-status")).toHaveTextContent("Off (paused)"));
    expect(sent("PATCH", "/strategies/s1")[0].body).toEqual({ status: "paused" });
    expect(sent("DELETE", "/")).toHaveLength(0);
    expect(card().getByRole("button", { name: "Turn on" })).toBeInTheDocument();
  });

  it("turns on again with the same strategy, indicator and practice account, not new ones", async () => {
    const user = userEvent.setup();
    existing({ status: "paused" });
    renderCard();
    await screen.findByText(/last checked/);
    await user.click(card().getByRole("button", { name: "Turn on" }));
    await user.click(within(screen.getByTestId("auto-confirm")).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(card().getByTestId("auto-status")).toHaveTextContent("On"));
    expect(sent("POST", "/")).toHaveLength(0);
    expect(strategies).toHaveLength(1);
    expect(sent("PATCH", "/indicators/st")).toHaveLength(1);
    expect(sent("PATCH", "/strategies/s1").find((c) => c.body.status === "live")!.body).toEqual({ status: "live", reset_engine_run: true });
  });

  it("offers Apply changes only once a setting differs from what is running, and applies it to the same strategy", async () => {
    const user = userEvent.setup();
    existing();
    renderCard();
    await screen.findByText(/last checked/);
    expect(card().queryByRole("button", { name: "Apply changes" })).not.toBeInTheDocument();
    await user.click(card().getByRole("button", { name: "Settings" }));
    await user.clear(card().getByLabelText("Lots per trade"));
    await user.type(card().getByLabelText("Lots per trade"), "5");
    await user.click(card().getByRole("button", { name: "Apply changes" }));
    expect(within(screen.getByTestId("auto-confirm")).getByText(/Apply these changes/)).toBeInTheDocument();
    await user.click(within(screen.getByTestId("auto-confirm")).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(sent("PATCH", "/strategies/s1").some((c) => c.body.fixed_lots === 5)).toBe(true));
    expect(strategies).toHaveLength(1);
    expect(sent("POST", "/")).toHaveLength(0);
  });

  it("shows the practice money it started with, fixed", async () => {
    const user = userEvent.setup();
    existing();
    renderCard();
    await screen.findByText(/last checked/);
    await user.click(card().getByRole("button", { name: "Settings" }));
    expect(card().getByLabelText("Practice money")).toHaveValue("100000");
    expect(card().getByText("Set when it was first turned on.")).toBeInTheDocument();
  });
});

describe("removing it", () => {
  it("asks first, then removes the strategy, its rule and its indicators, and its practice account when it never traded", async () => {
    const user = userEvent.setup();
    existing();
    indicators.push({ id: "other", name: "Someone else's indicator", type: "rsi", params: {} });
    renderCard();
    await screen.findByText(/last checked/);
    await user.click(card().getByRole("button", { name: "Remove auto-trader" }));
    expect(sent("DELETE", "/")).toHaveLength(0);
    await user.click(within(screen.getByTestId("auto-remove-confirm")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(sent("DELETE", "/strategies/s1")).toHaveLength(1));
    await waitFor(() => expect(sent("DELETE", "/rules/r1")).toHaveLength(1));
    expect(sent("DELETE", "/indicators/st")).toHaveLength(1);
    expect(sent("DELETE", "/indicators/other")).toHaveLength(0); // only its own
    await waitFor(() => expect(sent("DELETE", "/accounts/strategy/s1")).toHaveLength(1));
    expect(accounts.s1).toBeUndefined();
    await waitFor(() => expect(card().getByTestId("auto-status")).toHaveTextContent("Off"));
    expect(card().queryByRole("button", { name: "Remove auto-trader" })).not.toBeInTheDocument();
  });

  it("keeps the practice account when it has traded, so nothing is thrown away", async () => {
    const user = userEvent.setup();
    existing();
    tradesFor = { positions: [{ id: "a", symbol: "NIFTY-Sep2026-FUT", action: "BUY", status: "CLOSED", option_group_id: null, entry_time: "2026-09-26T04:00:00Z", exit_time: "2026-09-26T05:00:00Z", pnl: 10 }], groups: [] };
    renderCard();
    await screen.findByText(/last checked/);
    await user.click(card().getByRole("button", { name: "Remove auto-trader" }));
    await user.click(within(screen.getByTestId("auto-remove-confirm")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(sent("DELETE", "/strategies/s1")).toHaveLength(1));
    await waitFor(() => expect(card().getByTestId("auto-status")).toHaveTextContent("Off"));
    expect(sent("DELETE", "/accounts")).toHaveLength(0);
    expect(accounts.s1).toBeDefined();
  });

  it("keeps the account too when it cannot tell whether it traded", async () => {
    const user = userEvent.setup();
    existing();
    renderCard();
    await screen.findByText(/last checked/);
    tradesFor = null as never; // the trades request will now fail to parse a body
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (String(url).includes("/trades") ? json({ detail: "down" }, 503) : real(url, init))));
    await user.click(card().getByRole("button", { name: "Remove auto-trader" }));
    await user.click(within(screen.getByTestId("auto-remove-confirm")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(sent("DELETE", "/strategies/s1")).toHaveLength(1));
    expect(sent("DELETE", "/accounts")).toHaveLength(0);
  });

  it("can be cancelled", async () => {
    const user = userEvent.setup();
    existing();
    renderCard();
    await screen.findByText(/last checked/);
    await user.click(card().getByRole("button", { name: "Remove auto-trader" }));
    await user.click(within(screen.getByTestId("auto-remove-confirm")).getByRole("button", { name: "Cancel" }));
    expect(sent("DELETE", "/")).toHaveLength(0);
    expect(card().getByRole("button", { name: "Remove auto-trader" })).toBeInTheDocument();
  });
});

describe("one strategy per instrument", () => {
  it("looks for the strategy by market and instrument name, so another instrument's is not shown", async () => {
    existing(); // NSE:NIFTY, running
    renderCard("BANKNIFTY");
    await settled();
    expect(card().getByTestId("auto-status")).toHaveTextContent("Off");
    expect(card().queryByTestId("auto-results")).not.toBeInTheDocument();
  });
});
