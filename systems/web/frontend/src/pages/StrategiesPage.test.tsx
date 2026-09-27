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
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { method: string; url: string; body: any };
let calls: Call[];
let watchlists: any[];
let indicators: any[];
let rules: any[];
let strategies: any[];
let signals: any[];
let seq: number;

const sent = (method: string, part: string) => calls.filter((c) => c.method === method && c.url.includes(part));

beforeEach(() => {
  calls = [];
  watchlists = [];
  indicators = [];
  rules = [];
  strategies = [];
  signals = [];
  seq = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      const id = () => `id${++seq}`;
      const idOf = (prefix: string) => url.slice(url.indexOf(prefix) + prefix.length + 1).split(/[/?]/)[0];

      if (url.includes("/watchlists")) {
        if (method === "GET") return json(watchlists);
        if (method === "POST") {
          const row = { id: id(), symbol_count: body.symbols.split(",").filter((s: string) => s.trim()).length, created_at: "", updated_at: "", ...body };
          watchlists.push(row);
          return json(row, 201);
        }
        const row = watchlists.find((w) => w.id === idOf("/watchlists"))!;
        if (method === "PUT") return json(Object.assign(row, { symbols: body.symbols, symbol_count: body.symbols.split(",").filter((s: string) => s.trim()).length }));
        if (method === "DELETE") {
          watchlists = watchlists.filter((w) => w !== row);
          return json(null, 204);
        }
      }
      if (url.includes("/indicators")) {
        if (method === "GET") return json(indicators);
        if (method === "POST") {
          const row = { id: id(), created_at: "", updated_at: "", ...body };
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
      if (url.includes("/rules")) {
        if (method === "GET") return json(rules);
        if (method === "POST") {
          const row = { id: id(), created_at: "", updated_at: "", ...body };
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
      if (url.includes("/strategies")) {
        if (method === "GET") return json(strategies);
        if (method === "POST") {
          const row = { id: id(), status: "draft", last_scan_at: null, last_signal_at: null, created_by: null, created_at: "", updated_at: "", rule: rules.find((r) => r.id === body.rule_id) ?? null, ...body };
          strategies.push(row);
          return json(row, 201);
        }
        const row = strategies.find((s) => s.id === idOf("/strategies"))!;
        if (method === "PATCH") {
          const { reset_engine_run, ...rest } = body;
          void reset_engine_run;
          if (rest.rule_id !== undefined) rest.rule = rules.find((r) => r.id === rest.rule_id) ?? null;
          return json(Object.assign(row, rest));
        }
        if (method === "DELETE") {
          strategies = strategies.filter((s) => s !== row);
          return json(null, 204);
        }
      }
      if (url.includes("/signals")) return json(signals);
      return json({ detail: `unrouted ${method} ${url}` }, 404);
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
const goTo = async (label: string) => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: label }));
  return user;
};

describe("Watchlists", () => {
  it("creates one and lists it, then edits its symbols, then deletes it", async () => {
    const user = userEvent.setup();
    renderAt("/more/strategies?tab=watchlists");
    await user.click(await screen.findByRole("button", { name: "New watchlist" }));
    await user.type(screen.getByLabelText("Name"), "My picks");
    await user.type(screen.getByLabelText("Symbols"), "GOLDM, SILVER");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("POST", "/watchlists")).toHaveLength(1));
    expect(sent("POST", "/watchlists")[0].body).toEqual({ name: "My picks", symbols: "GOLDM, SILVER" });
    const row = within(await screen.findByTestId("watchlist-row"));
    expect(row.getByText("My picks")).toBeInTheDocument();
    expect(row.getByText("2 symbols")).toBeInTheDocument();

    await user.click(row.getByRole("button", { name: "Edit symbols" }));
    const field = screen.getByLabelText("Symbols");
    await user.clear(field);
    await user.type(field, "GOLDM, SILVER, CRUDEOIL");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("PUT", "/watchlists")).toHaveLength(1));
    expect(await within(screen.getByTestId("watchlist-row")).findByText("3 symbols")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Yes, delete" }));
    await waitFor(() => expect(sent("DELETE", "/watchlists")).toHaveLength(1));
    expect(screen.queryByTestId("watchlist-row")).not.toBeInTheDocument();
  });

  it("refuses to save with no symbols, and sends nothing", async () => {
    const user = userEvent.setup();
    renderAt("/more/strategies?tab=watchlists");
    await user.click(await screen.findByRole("button", { name: "New watchlist" }));
    await user.type(screen.getByLabelText("Name"), "Empty");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter at least one symbol");
    expect(sent("POST", "/watchlists")).toHaveLength(0);
  });
});

describe("Indicators", () => {
  it("creates an RSI indicator with its two params, then edits one, then deletes it", async () => {
    const user = userEvent.setup();
    renderAt("/more/strategies?tab=indicators");
    await user.click(await screen.findByRole("button", { name: "New indicator" }));
    await user.type(screen.getByLabelText("Name"), "RSI 14");
    await user.clear(screen.getByLabelText("Period"));
    await user.type(screen.getByLabelText("Period"), "14");
    await user.clear(screen.getByLabelText("Signal line (SMA of RSI) period"));
    await user.type(screen.getByLabelText("Signal line (SMA of RSI) period"), "9");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("POST", "/indicators")).toHaveLength(1));
    expect(sent("POST", "/indicators")[0].body).toEqual({ name: "RSI 14", type: "rsi", params: { period: 14, sma_period: 9 } });
    const row = within(await screen.findByTestId("indicator-row"));
    expect(row.getByText("RSI 14")).toBeInTheDocument();
    expect(row.getByText("RSI")).toBeInTheDocument();

    await user.click(row.getByRole("button", { name: "Edit" }));
    const period = screen.getByLabelText("Period");
    await user.clear(period);
    await user.type(period, "21");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("PATCH", "/indicators")).toHaveLength(1));
    expect(sent("PATCH", "/indicators")[0].body).toEqual({ params: { period: 21, sma_period: 9 } });

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Yes, delete" }));
    await waitFor(() => expect(sent("DELETE", "/indicators")).toHaveLength(1));
  });

  it("switching kind shows that kind's own fields with sensible defaults", async () => {
    const user = userEvent.setup();
    renderAt("/more/strategies?tab=indicators");
    await user.click(await screen.findByRole("button", { name: "New indicator" }));
    await user.selectOptions(screen.getByLabelText("Kind"), "ADX (trend strength)");
    expect(screen.getByLabelText("Period")).toHaveValue("14");
    expect(screen.getByLabelText("Trend threshold")).toHaveValue("20");
    expect(screen.queryByLabelText("Signal line (SMA of RSI) period")).not.toBeInTheDocument();
  });

  it("refuses an out-of-range param, in words", async () => {
    const user = userEvent.setup();
    renderAt("/more/strategies?tab=indicators");
    await user.click(await screen.findByRole("button", { name: "New indicator" }));
    await user.type(screen.getByLabelText("Name"), "Bad RSI");
    await user.clear(screen.getByLabelText("Period"));
    await user.type(screen.getByLabelText("Period"), "1");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("more than 2");
    expect(sent("POST", "/indicators")).toHaveLength(0);
  });
});

describe("Rules", () => {
  beforeEach(() => {
    indicators = [{ id: "ind1", name: "RSI 14", type: "rsi", params: { period: 14, sma_period: 9 }, created_at: "", updated_at: "" }];
  });

  it("creates a crossover rule against an existing indicator", async () => {
    const user = userEvent.setup();
    renderAt("/more/strategies?tab=rules");
    await user.click(await screen.findByRole("button", { name: "New rule" }));
    await user.type(screen.getByLabelText("Name"), "RSI cross NIFTY");
    await user.type(screen.getByLabelText("Underlying"), "NIFTY");
    await user.selectOptions(screen.getByLabelText("Indicator to cross"), "RSI 14");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("POST", "/rules")).toHaveLength(1));
    expect(sent("POST", "/rules")[0].body).toMatchObject({ name: "RSI cross NIFTY", underlying: "NIFTY", underlying_type: "symbol", rule_config: { type: "crossover", indicator_id: "ind1" } });
    expect(within(await screen.findByTestId("rule-row")).getByText("RSI cross NIFTY")).toBeInTheDocument();
  });

  it("creates a range-breakout rule, no indicator needed", async () => {
    const user = userEvent.setup();
    renderAt("/more/strategies?tab=rules");
    await user.click(await screen.findByRole("button", { name: "New rule" }));
    await user.type(screen.getByLabelText("Name"), "GOLDM range break");
    await user.selectOptions(screen.getByLabelText("Market"), "MCX");
    await user.type(screen.getByLabelText("Underlying"), "GOLDM");
    await user.selectOptions(screen.getByLabelText("Rule type"), "Range breakout — closes past its own N-bar high/low");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("POST", "/rules")).toHaveLength(1));
    expect(sent("POST", "/rules")[0].body.rule_config).toEqual({ type: "range_breakout", breakout_period: 20 });
  });

  it("refuses a universe scan outside NSE", async () => {
    const user = userEvent.setup();
    renderAt("/more/strategies?tab=rules");
    await user.click(await screen.findByRole("button", { name: "New rule" }));
    await user.type(screen.getByLabelText("Name"), "x");
    await user.selectOptions(screen.getByLabelText("Market"), "MCX");
    await user.selectOptions(screen.getByLabelText("Scans"), "Index constituents");
    await user.type(screen.getByLabelText("Underlying"), "NIFTYBANK");
    await user.selectOptions(screen.getByLabelText("Indicator to cross"), "RSI 14");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("only works on NSE");
    expect(sent("POST", "/rules")).toHaveLength(0);
  });

  it("shows a multi-condition rule read-only, edit disabled with an explanation", async () => {
    rules = [{ id: "r1", name: "Chartink-style scan", description: null, segment: "NSE", underlying: "NIFTY", underlying_type: "symbol", interval: "daily", rule_config: { type: "multi_condition", direction: "bullish", conditions: [{}] }, regime_indicator_ids: [], created_at: "", updated_at: "" }];
    renderAt("/more/strategies?tab=rules");
    const row = within(await screen.findByTestId("rule-row"));
    expect(row.getByText(/Bullish multi-condition scan/)).toBeInTheDocument();
    expect(row.getByRole("button", { name: "Edit" })).toBeDisabled();
  });

  it("offers regime indicators to gate a rule, excluding RSI", async () => {
    indicators = [...indicators, { id: "ind2", name: "ADX 14", type: "adx", params: { period: 14, trend_threshold: 20 }, created_at: "", updated_at: "" }];
    const user = userEvent.setup();
    renderAt("/more/strategies?tab=rules");
    await user.click(await screen.findByRole("button", { name: "New rule" }));
    expect(screen.getByText("ADX 14")).toBeInTheDocument();
    expect(screen.queryByText("RSI 14", { selector: "span" })).not.toBeInTheDocument(); // RSI is crossover-only, not offered as a gate
    await user.click(screen.getByLabelText("ADX 14"));
    await user.type(screen.getByLabelText("Name"), "y");
    await user.type(screen.getByLabelText("Underlying"), "NIFTY");
    await user.selectOptions(screen.getByLabelText("Indicator to cross"), "RSI 14");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("POST", "/rules")).toHaveLength(1));
    expect(sent("POST", "/rules")[0].body.regime_indicator_ids).toEqual(["ind2"]);
  });
});

describe("Strategies", () => {
  beforeEach(() => {
    rules = [{ id: "r1", name: "RSI cross NIFTY", description: null, segment: "NSE", underlying: "NIFTY", underlying_type: "symbol", interval: "5min", rule_config: { type: "crossover", indicator_id: "ind1" }, regime_indicator_ids: [], created_at: "", updated_at: "" }];
  });

  it("creates an in-house strategy against an existing rule, with a stop-loss", async () => {
    const user = userEvent.setup();
    renderAt("/more/strategies?tab=strategies");
    await user.click(await screen.findByRole("button", { name: "New strategy" }));
    await user.type(screen.getByLabelText("Name"), "NIFTY RSI strategy");
    await user.selectOptions(screen.getByLabelText("Rule"), "RSI cross NIFTY");
    await user.selectOptions(screen.getByLabelText("Stop-loss"), "A flat percent from entry");
    await user.clear(screen.getByLabelText("Stop percent"));
    await user.type(screen.getByLabelText("Stop percent"), "1.5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("POST", "/strategies")).toHaveLength(1));
    expect(sent("POST", "/strategies")[0].body).toMatchObject({
      name: "NIFTY RSI strategy", source_type: "in_house", rule_id: "r1", stop_loss_method: "percent", stop_loss_percent: 1.5, segment: "NSE", instrument_type: "future",
    });
    const row = within(await screen.findByTestId("strategy-row"));
    expect(row.getByText("NIFTY RSI strategy")).toBeInTheDocument();
    expect(row.getByText("draft")).toBeInTheDocument();
  });

  it("creates an external strategy with no rule, naming its provider", async () => {
    const user = userEvent.setup();
    renderAt("/more/strategies?tab=strategies");
    await user.click(await screen.findByRole("button", { name: "New strategy" }));
    await user.type(screen.getByLabelText("Name"), "Chartink momentum");
    await user.click(screen.getByLabelText(/In-house/));
    await user.type(screen.getByLabelText("Provider"), "chartink");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("POST", "/strategies")).toHaveLength(1));
    expect(sent("POST", "/strategies")[0].body).toMatchObject({ source_type: "chartink", rule_id: null });
  });

  it("refuses spot on CRYPTO", async () => {
    const user = userEvent.setup();
    renderAt("/more/strategies?tab=strategies");
    await user.click(await screen.findByRole("button", { name: "New strategy" }));
    await user.type(screen.getByLabelText("Name"), "x");
    await user.selectOptions(screen.getByLabelText("Rule"), "RSI cross NIFTY");
    await user.selectOptions(screen.getByLabelText("Market"), "CRYPTO");
    expect(screen.getByRole<HTMLOptionElement>("option", { name: "Shares (spot)" }).disabled).toBe(true);
  });

  it("goes live, then pauses, without touching any other field", async () => {
    strategies = [{
      id: "s1", name: "x", source_type: "in_house", source_rule_name: null, exchange: "NSE", horizon: "intraday", instrument_type: "future",
      rule_id: "r1", rule: { id: "r1", name: "RSI cross NIFTY", segment: "NSE" }, stop_loss_method: null, stop_loss_interval: null, stop_loss_percent: null,
      stop_loss_indicator_type: null, stop_loss_indicator_params: null, target_percent: null, trailing_stop_enabled: false, exit_condition: null,
      option_position_style: "spread", option_strike_moneyness: "ATM", option_sl_scope: "combined", fixed_lots: null, use_margin: false,
      contract_day_filter: "any", segment: "NSE", duplicate_signal_policy: "skip", counter_signal_policy: "close_and_flip", active_windows: [],
      active_weekdays: [], seed_on_activation: false, status: "draft", last_scan_at: null, last_signal_at: null, created_by: null, created_at: "", updated_at: "",
    }];
    const user = userEvent.setup();
    renderAt("/more/strategies?tab=strategies");
    const row = within(await screen.findByTestId("strategy-row"));
    await user.click(row.getByRole("button", { name: "Go live" }));
    await waitFor(() => expect(sent("PATCH", "/strategies/s1")).toHaveLength(1));
    expect(sent("PATCH", "/strategies/s1")[0].body).toEqual({ status: "live" });
    expect(await row.findByText("live")).toBeInTheDocument();
    await user.click(row.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(sent("PATCH", "/strategies/s1")).toHaveLength(2));
    expect(sent("PATCH", "/strategies/s1")[1].body).toEqual({ status: "paused" });
  });
});

describe("Signals", () => {
  it("lists recent signals read-only, with the strategy name resolved", async () => {
    strategies = [{
      id: "s1", name: "NIFTY RSI strategy", source_type: "in_house", source_rule_name: null, exchange: "NSE", horizon: "intraday", instrument_type: "future",
      rule_id: null, rule: null, stop_loss_method: null, stop_loss_interval: null, stop_loss_percent: null, stop_loss_indicator_type: null,
      stop_loss_indicator_params: null, target_percent: null, trailing_stop_enabled: false, exit_condition: null, option_position_style: "spread",
      option_strike_moneyness: "ATM", option_sl_scope: "combined", fixed_lots: null, use_margin: false, contract_day_filter: "any", segment: "NSE",
      duplicate_signal_policy: "skip", counter_signal_policy: "close_and_flip", active_windows: [], active_weekdays: [], seed_on_activation: false,
      status: "live", last_scan_at: null, last_signal_at: null, created_by: null, created_at: "", updated_at: "",
    }];
    signals = [{ signal_id: "sig1", strategy_id: "s1", symbol: "NIFTY", exchange: "NSE", action: "BUY", price: 23100, source: "in_house", received_at: "2026-09-27T04:00:00Z", horizon: "intraday", instrument_type: "future", status: "OPEN", rejection_reason: null }];
    renderAt("/more/strategies?tab=signals");
    const row = within(await screen.findByTestId("signal-row"));
    expect(row.getByText(/NIFTY @/)).toBeInTheDocument();
    expect(row.getByText(/NIFTY RSI strategy/)).toBeInTheDocument();
    expect(row.getByText("OPEN")).toBeInTheDocument();
  });

  it("says so when there are none", async () => {
    renderAt("/more/strategies?tab=signals");
    expect(await screen.findByText("No signals yet")).toBeInTheDocument();
  });
});

describe("navigating between tabs", () => {
  it("switches sections without losing what is already loaded", async () => {
    watchlists = [{ id: "w1", name: "My picks", symbols: "GOLDM", symbol_count: 1, created_at: "", updated_at: "" }];
    renderAt("/more/strategies?tab=watchlists");
    expect(await screen.findByText("My picks")).toBeInTheDocument();
    await goTo("Indicators");
    expect(screen.getByRole("button", { name: "New indicator" })).toBeInTheDocument();
    await goTo("Watchlists");
    expect(await screen.findByText("My picks")).toBeInTheDocument();
    expect(sent("GET", "/watchlists")).toHaveLength(1); // not reloaded on returning to the tab
  });

  it("is reached from More", async () => {
    const user = userEvent.setup();
    renderAt("/more");
    await user.click(await screen.findByRole("link", { name: /Strategies/ }));
    expect(await screen.findByRole("heading", { name: "Strategies" })).toBeInTheDocument();
  });
});
