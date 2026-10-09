import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertChannel, PriceAlert } from "../api/priceAlerts";
import { AlertsPage } from "./AlertsPage";

function json(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: "a1", exchange: "NSE", symbol: "NIFTY", target_price: 23100, direction: "above", note: null, repeat: false, active: true, last_side: "below",
  created_at: "2026-10-06T04:00:00Z", last_triggered_at: null, trigger_count: 0, delivery_failures: 0, last_error: null, ...over,
});

let channel: AlertChannel;
let alerts: PriceAlert[];
let calls: { url: string; method: string; body: any }[];
let failNext: { status: number; detail: string } | null;
let currentPrice: number | null;
let zoneWatches: any[];
let zoneAlertsAll = "all";
let zoneEvents: any[];

beforeEach(() => {
  channel = { bot_configured: true, chat_set: true, chat_id_hint: "…6789" };
  alerts = [];
  calls = [];
  failNext = null;
  currentPrice = 71_240;
  zoneWatches = [];
  zoneAlertsAll = "all";
  zoneEvents = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (failNext && method !== "GET") {
        const f = failNext;
        failNext = null;
        return json({ detail: f.detail }, f.status);
      }
      if (url.endsWith("/zone-watches") && method === "GET") return json({ watches: zoneWatches, events: zoneEvents, alerts: zoneAlertsAll });
      if (url.endsWith("/zone-alerts") && method === "PUT") {
        zoneAlertsAll = body.alerts;
        return json({ alerts: body.alerts });
      }
      const zalert = url.match(/\/zone-alerts\/([\w-]+)$/);
      if (zalert && method === "PUT") {
        zoneWatches = zoneWatches.map((w) => (w.id === zalert[1] ? { ...w, alerts: body.alerts } : w));
        return json(zoneWatches.find((w) => w.id === zalert[1]));
      }
      const zdel = url.match(/\/zone-watches\/([\w-]+)$/);
      if (zdel && method === "DELETE") {
        zoneWatches = zoneWatches.filter((w) => w.id !== zdel[1]);
        return json(null, 204);
      }
      if (url.includes("/notifications/history")) return json([]);
      if (url.endsWith("/notifications")) return json({ chat_ready: true, categories: [] });
      if (url.endsWith("/price-alerts/channel") && method === "GET") return json(channel);
      if (url.endsWith("/price-alerts/channel") && method === "PUT") {
        channel = body.telegram_chat_id ? { ...channel, chat_set: true, chat_id_hint: `…${body.telegram_chat_id.slice(-4)}` } : { ...channel, chat_set: false, chat_id_hint: null };
        return json(channel);
      }
      if (url.endsWith("/price-alerts/test-telegram") && method === "POST") return json({ sent: true });
      if (url.endsWith("/price-alerts") && method === "GET") return json(alerts);
      if (url.endsWith("/price-alerts") && method === "POST") {
        const made = alert({ id: `n${alerts.length}`, symbol: body.symbol, direction: body.direction, target_price: body.target_price, exchange: body.exchange, repeat: body.repeat, note: body.note ?? null });
        alerts = [...alerts, made];
        return json({ ...made, current_price: currentPrice }, 201); // the list never carries it
      }
      const del = url.match(/\/price-alerts\/([\w-]+)$/);
      if (del && method === "DELETE") {
        alerts = alerts.filter((a) => a.id !== del[1]);
        return json(null, 204);
      }
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderPage = () => render(<MemoryRouter><AlertsPage /></MemoryRouter>);
const writes = (method: string) => calls.filter((c) => c.method === method);

describe("AlertsPage", () => {
  it("shows the chat as connected and can send a test message", async () => {
    renderPage();
    const card = await screen.findByTestId("telegram-card");
    expect(within(card).getByText("Connected …6789")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Send a test message" }));
    expect(await within(card).findByText("Test message sent. Check Telegram.")).toBeInTheDocument();
    expect(writes("POST").some((c) => c.url.endsWith("/test-telegram"))).toBe(true);
  });

  it("walks a new person through connecting Telegram, and keeps the form closed until they have", async () => {
    channel = { bot_configured: true, chat_set: false, chat_id_hint: null };
    renderPage();
    const card = await screen.findByTestId("telegram-card");
    expect(within(card).getByText("Not set up")).toBeInTheDocument();
    expect(within(card).getByText(/press Start/)).toBeInTheDocument();
    expect(within(screen.getByTestId("new-alert")).getByRole("button", { name: "Add alert" })).toBeDisabled();
    expect(screen.getByText(/Connect Telegram above first/)).toBeInTheDocument();

    await userEvent.type(within(card).getByLabelText("Your Telegram chat id"), "@bob");
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("is a number");
    expect(writes("PUT")).toHaveLength(0); // never sent

    await userEvent.clear(within(card).getByLabelText("Your Telegram chat id"));
    await userEvent.type(within(card).getByLabelText("Your Telegram chat id"), "987654321");
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes("PUT")[0].body).toEqual({ telegram_chat_id: "987654321" }));
    expect(await screen.findByText("Connected …4321")).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByTestId("new-alert")).getByRole("button", { name: "Add alert" })).toBeEnabled());
  });

  it("says plainly when the server has no bot", async () => {
    channel = { bot_configured: false, chat_set: false, chat_id_hint: null };
    renderPage();
    expect(await screen.findByText(/no Telegram bot set up yet/)).toBeInTheDocument();
  });

  it("adds an alert with the chosen market, direction, price, note and repeat, and clears the form", async () => {
    renderPage();
    const form = await screen.findByTestId("new-alert");
    await userEvent.click(within(form).getByRole("button", { name: "Commodities" }));
    await userEvent.type(within(form).getByLabelText("Symbol"), "goldm");
    await userEvent.click(within(form).getByRole("button", { name: "Crosses either way" }));
    await userEvent.type(within(form).getByLabelText("Price"), "71,250");
    await userEvent.type(within(form).getByLabelText("Note (optional)"), "range top");
    await userEvent.click(within(form).getByLabelText("Keep watching after it fires"));
    await userEvent.click(within(form).getByRole("button", { name: "Add alert" }));
    await waitFor(() => expect(writes("POST")[0].body).toEqual({ exchange: "MCX", symbol: "GOLDM", target_price: 71250, direction: "cross", repeat: true, note: "range top" }));
    const added = await screen.findByTestId("added-alert");
    expect(within(added).getByText("Added: GOLDM crosses 71,250 either way")).toBeInTheDocument();
    expect(within(added).getByText("GOLDM is 71,240 now. It fires when the price crosses 71,250 either way, 10 away (0.01%).")).toBeInTheDocument();
    expect(within(form).getByLabelText("Symbol")).toHaveValue("");
    expect(await screen.findAllByTestId("alert-row")).toHaveLength(1);
  });

  it("checks the form before asking the server", async () => {
    renderPage();
    const form = await screen.findByTestId("new-alert");
    await userEvent.click(within(form).getByRole("button", { name: "Add alert" }));
    expect(await within(form).findByText("Enter the symbol, for example NIFTY.")).toBeInTheDocument();
    expect(within(form).getByText("Enter a price above zero.")).toBeInTheDocument();
    expect(writes("POST")).toHaveLength(0);
  });

  it("shows the server's reason when an alert is refused, such as an unknown symbol", async () => {
    renderPage();
    const form = await screen.findByTestId("new-alert");
    await userEvent.type(within(form).getByLabelText("Symbol"), "ZZNOSUCH");
    await userEvent.type(within(form).getByLabelText("Price"), "100");
    failNext = { status: 422, detail: "Could not get a price for NSE:ZZNOSUCH. Check the symbol, or try again in a moment." };
    await userEvent.click(within(form).getByRole("button", { name: "Add alert" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Could not get a price for NSE:ZZNOSUCH");
    expect(within(form).getByLabelText("Symbol")).toHaveValue("ZZNOSUCH"); // what they typed is kept
  });

  it("lists each alert with where it stands, including one whose message could not be sent", async () => {
    alerts = [
      alert({ id: "live", symbol: "NIFTY" }),
      alert({ id: "stuck", symbol: "BANKNIFTY", direction: "below", target_price: 50000, delivery_failures: 3, last_error: "the bot cannot message this chat (start the bot first)" }),
      alert({ id: "done", symbol: "GOLDM", active: false, trigger_count: 1, last_triggered_at: "2026-10-05T05:00:00Z", created_at: "2026-10-01T00:00:00Z" }),
    ];
    renderPage();
    const rows = await screen.findAllByTestId("alert-row");
    expect(rows).toHaveLength(3);
    const stuck = rows.find((r) => within(r).queryByText(/BANKNIFTY/))!;
    expect(within(stuck).getByText("Could not send")).toBeInTheDocument();
    expect(within(stuck).getByText(/failed 3 times: the bot cannot message this chat/)).toBeInTheDocument();
    expect(within(rows.find((r) => within(r).queryByText(/GOLDM/))!).getByText("Fired")).toBeInTheDocument();
    expect(within(rows.find((r) => within(r).queryByText(/NIFTY goes above/))!).getByText("Watching")).toBeInTheDocument();
  });

  it("removes an alert", async () => {
    alerts = [alert()];
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Remove alert: NIFTY goes above 23,100/ }));
    await waitFor(() => expect(writes("DELETE")).toHaveLength(1));
    await waitFor(() => expect(screen.queryAllByTestId("alert-row")).toHaveLength(0));
    expect(screen.getByText("No alerts yet. Add one above.")).toBeInTheDocument();
  });

  it("says when the test message could not be sent, and why", async () => {
    renderPage();
    const card = await screen.findByTestId("telegram-card");
    failNext = { status: 503, detail: "Could not send: the bot cannot message this chat (start the bot first)." };
    await userEvent.click(within(card).getByRole("button", { name: "Send a test message" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("start the bot first");
  });

  it("can change or remove the connected chat", async () => {
    renderPage();
    const card = await screen.findByTestId("telegram-card");
    await userEvent.click(within(card).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(writes("PUT")[0].body).toEqual({ telegram_chat_id: "" }));
    expect(await within(card).findByText("Not set up")).toBeInTheDocument();
  });

  it("warns right after adding when the price is already past the level, since it then waits for a cross back", async () => {
    currentPrice = 23_200;
    renderPage();
    const form = await screen.findByTestId("new-alert");
    await userEvent.type(within(form).getByLabelText("Symbol"), "nifty");
    await userEvent.type(within(form).getByLabelText("Price"), "23100");
    await userEvent.click(within(form).getByRole("button", { name: "Add alert" })); // "Goes above" is the default
    const added = await screen.findByTestId("added-alert");
    expect(within(added).getByText(/NIFTY is 23,200 now\. It is already above 23,100, so this fires only after the price drops below it/)).toBeInTheDocument();
  });

  it("still confirms the alert when the server returns no price", async () => {
    currentPrice = null;
    renderPage();
    const form = await screen.findByTestId("new-alert");
    await userEvent.type(within(form).getByLabelText("Symbol"), "nifty");
    await userEvent.type(within(form).getByLabelText("Price"), "23100");
    await userEvent.click(within(form).getByRole("button", { name: "Add alert" }));
    expect(await screen.findByText("It will fire when the price crosses that level.")).toBeInTheDocument();
  });

  it("does not show the created-alert message on the alerts that are listed", async () => {
    alerts = [alert()];
    renderPage();
    await screen.findAllByTestId("alert-row");
    expect(screen.queryByTestId("added-alert")).not.toBeInTheDocument();
  });
});

describe("the zones the server is watching", () => {
  const goldm = { id: "z1", exchange: "MCX", symbol: "GOLDM-05Nov2026-FUT", kind: "zone", lo: 147116, hi: 147673, role: "support", interval: "15min", last_state: "above" };

  it("says what it does, and that none are armed yet when the person has drawn none", async () => {
    renderPage();
    expect(await screen.findByText(/None armed yet/)).toBeInTheDocument();
    expect(screen.getByTestId("zones-help")).toHaveTextContent(/watched here with every tab closed.*whether it held or broke.*wick/);
  });

  it("lists each armed zone with its role and band, and the latest things that happened to them", async () => {
    zoneWatches = [goldm, { ...goldm, id: "z2", kind: "line", lo: 149000, hi: 149000, role: "resistance" }];
    zoneEvents = [{ symbol: "GOLDM-05Nov2026-FUT", exchange: "MCX", kind: "zone", lo: 147116, hi: 147673, role: "support", event: "held", at: "2026-10-06T10:30:00Z", extreme: 147629, close: 148000 }];
    renderPage();
    const rows = await screen.findAllByTestId("zone-watch");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("GOLDM-05Nov2026-FUT");
    expect(rows[0]).toHaveTextContent("support");
    expect(rows[0]).toHaveTextContent("1,47,116–1,47,673");
    expect(rows[1]).toHaveTextContent("level");
    expect(screen.getByTestId("zone-events")).toHaveTextContent(/GOLDM-05Nov2026-FUT 1,47,116–1,47,673 tested and held at 1,48,000/);
  });

  it("turns Telegram messages for every zone down, and for one zone on its own, without removing anything", async () => {
    zoneWatches = [goldm];
    renderPage();
    const user = userEvent.setup();
    const all = await screen.findByRole("combobox", { name: "Telegram messages for all zones" });
    expect(all).toHaveValue("all");
    await user.selectOptions(all, "close");
    await waitFor(() => expect(writes("PUT").some((c) => c.url.endsWith("/zone-alerts") && c.body.alerts === "close")).toBe(true));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Telegram messages for all zones" })).toHaveValue("close"));
    await user.selectOptions(screen.getByRole("combobox", { name: /Messages for GOLDM-05Nov2026-FUT/ }), "off");
    await waitFor(() => expect(writes("PUT").some((c) => c.url.endsWith("/zone-alerts/z1") && c.body.alerts === "off")).toBe(true));
    await waitFor(() => expect(screen.getByRole("combobox", { name: /Messages for GOLDM-05Nov2026-FUT/ })).toHaveValue("off"));
    expect(screen.getByTestId("zone-watch")).toBeInTheDocument(); // still armed
    expect(writes("DELETE")).toHaveLength(0);
  });

  it("stops watching a zone when asked, and the list reflects it", async () => {
    zoneWatches = [goldm];
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Stop watching GOLDM-05Nov2026-FUT/ }));
    await waitFor(() => expect(screen.queryByTestId("zone-watch")).not.toBeInTheDocument());
    expect(writes("DELETE").some((c) => c.url.endsWith("/zone-watches/z1"))).toBe(true);
  });
});
