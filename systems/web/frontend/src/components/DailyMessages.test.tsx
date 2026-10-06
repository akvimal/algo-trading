import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Delivery, Notifications } from "../api/notifications";
import { DEFAULT_TOP_N, deliveryProblem, deliveryTime, statusTone, topNOptions } from "../pages/notificationsModel";
import { DailyMessages } from "./DailyMessages";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const cat = (key: string, label: string, over: object = {}) => ({ key, label, description: `${label} description`, schedule: `${label} schedule`, admin_only: false, enabled: false, params: {}, ...over });

let state: Notifications;
let history: Delivery[];
let calls: { url: string; method: string; body: any }[];
let failNext: { status: number; detail: string; path: string } | null;

beforeEach(() => {
  state = { chat_ready: true, categories: [cat("premarket", "Pre-market bias"), cat("oi_buildup", "Strong OI buildup", { params: { top_n: 10 } })] };
  history = [];
  calls = [];
  failNext = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (failNext && method !== "GET" && url.includes(failNext.path)) {
        const f = failNext;
        failNext = null;
        return json({ detail: f.detail }, f.status);
      }
      if (url.includes("/notifications/history")) return json(history);
      if (url.endsWith("/send-now") && method === "POST") return json({ sent: true });
      const put = url.match(/\/notifications\/(\w+)$/);
      if (put && method === "PUT") {
        state = { ...state, categories: state.categories.map((c) => (c.key === put[1] ? { ...c, enabled: body.enabled, params: body.params ?? c.params } : c)) };
        return json(state);
      }
      if (url.endsWith("/notifications")) return json(state);
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const writes = (method: string) => calls.filter((c) => c.method === method);
const delivery = (over: Partial<Delivery> = {}): Delivery => ({
  category: "premarket", label: "Pre-market bias", manual: false, created_at: "2026-10-06T03:15:00Z", sent_at: "2026-10-06T03:15:02Z", status: "sent", attempts: 1, last_error: null, first_line: "☀️ Pre-market · Tue 6 Oct", ...over,
});

describe("DailyMessages", () => {
  it("lists each message with when it is sent and its description, all switched off to begin with", async () => {
    render(<DailyMessages />);
    const pre = await screen.findByTestId("daily-premarket");
    expect(within(pre).getByText("Pre-market bias schedule")).toBeInTheDocument();
    expect(within(pre).getByLabelText("Off")).not.toBeChecked();
    expect(within(screen.getByTestId("daily-oi_buildup")).getByLabelText("Off")).not.toBeChecked();
  });

  it("marks the operator category and shows it only when the server offers it", async () => {
    state = { ...state, categories: [...state.categories, cat("ops", "Operator alerts", { admin_only: true })] };
    render(<DailyMessages />);
    expect(within(await screen.findByTestId("daily-ops")).getByText("Operator")).toBeInTheDocument();
  });

  it("switches a message on and saves it", async () => {
    render(<DailyMessages />);
    const pre = await screen.findByTestId("daily-premarket");
    await userEvent.click(within(pre).getByLabelText("Off"));
    await waitFor(() => expect(writes("PUT")[0].body).toEqual({ enabled: true }));
    expect(writes("PUT")[0].url).toMatch(/\/notifications\/premarket$/);
    expect(await within(screen.getByTestId("daily-premarket")).findByLabelText("On")).toBeChecked();
  });

  it("keeps the digest size when it is switched on, and saves a new size without changing on or off", async () => {
    render(<DailyMessages />);
    const oi = await screen.findByTestId("daily-oi_buildup");
    await userEvent.click(within(oi).getByLabelText("Off"));
    await waitFor(() => expect(writes("PUT")[0].body).toEqual({ enabled: true, params: { top_n: 10 } }));
    await userEvent.selectOptions(await within(screen.getByTestId("daily-oi_buildup")).findByLabelText("How many per side"), "5");
    await waitFor(() => expect(writes("PUT")[1].body).toEqual({ enabled: true, params: { top_n: 5 } }));
  });

  it("will not let anything be switched on until Telegram is connected, and says so", async () => {
    state = { ...state, chat_ready: false };
    render(<DailyMessages />);
    const pre = await screen.findByTestId("daily-premarket");
    expect(within(pre).getByLabelText("Off")).toBeDisabled();
    expect(within(pre).getByRole("button", { name: "Send me the latest now" })).toBeDisabled();
    expect(screen.getByText(/Connect Telegram above to receive them/)).toBeInTheDocument();
  });

  it("sends the latest one on request and says when that could not be done, and why", async () => {
    render(<DailyMessages />);
    const pre = await screen.findByTestId("daily-premarket");
    await userEvent.click(within(pre).getByRole("button", { name: "Send me the latest now" }));
    await waitFor(() => expect(writes("POST")[0].url).toMatch(/\/notifications\/premarket\/send-now$/));
    expect(await within(screen.getByTestId("daily-premarket")).findByText("Sent. Check Telegram.")).toBeInTheDocument();
    failNext = { status: 404, path: "send-now", detail: "No stock showed a strong two-sided shift in the latest scan." };
    await userEvent.click(within(screen.getByTestId("daily-oi_buildup")).getByRole("button", { name: "Send me the latest now" }));
    expect(await within(screen.getByTestId("daily-oi_buildup")).findByRole("alert")).toHaveTextContent("No stock showed a strong two-sided shift");
  });

  it("shows a refused change instead of pretending it worked", async () => {
    render(<DailyMessages />);
    const pre = await screen.findByTestId("daily-premarket");
    failNext = { status: 403, path: "/notifications/premarket", detail: "admin access required" };
    await userEvent.click(within(pre).getByLabelText("Off"));
    expect(await within(screen.getByTestId("daily-premarket")).findByRole("alert")).toHaveTextContent("admin access required");
    expect(within(screen.getByTestId("daily-premarket")).getByLabelText("Off")).not.toBeChecked();
  });

  it("lists what was delivered, what is still being retried and what was given up on, with the reason", async () => {
    history = [
      delivery(),
      delivery({ category: "oi_buildup", label: "Strong OI buildup", status: "retrying", sent_at: null, attempts: 2, last_error: "could not reach Telegram", first_line: "📊 Strong OI buildup · 6 Oct close" }),
      delivery({ status: "gave_up", sent_at: null, attempts: 5, last_error: "the bot cannot message this chat (start the bot first)", manual: true }),
    ];
    render(<DailyMessages />);
    const rows = await screen.findAllByTestId("delivery");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("Sent")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Retrying")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Could not send yet: could not reach Telegram. It will try again.")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Not delivered")).toBeInTheDocument();
    expect(within(rows[2]).getByText(/Gave up after 5 tries: the bot cannot message this chat/)).toBeInTheDocument();
    expect(within(rows[2]).getByText(/sent on request/)).toBeInTheDocument();
  });

  it("says plainly when nothing has been sent yet", async () => {
    render(<DailyMessages />);
    expect(await screen.findByText("Nothing sent yet.")).toBeInTheDocument();
  });
});

describe("notificationsModel", () => {
  it("offers the usual digest sizes, plus the current one if it is something else", () => {
    expect(topNOptions(10)).toEqual([5, 10, 15, 20]);
    expect(topNOptions(7)).toEqual([5, 7, 10, 15, 20]);
    expect(topNOptions(undefined)).toEqual([5, 10, 15, 20]);
    expect(DEFAULT_TOP_N).toBe(10);
  });
  it("colours a delivery by how it went, and says what went wrong", () => {
    expect([statusTone("sent"), statusTone("retrying"), statusTone("gave_up")]).toEqual(["up", "warn", "dn"]);
    expect(deliveryProblem({ status: "sent", last_error: null, attempts: 1 })).toBeNull();
    expect(deliveryProblem({ status: "retrying", last_error: null, attempts: 1 })).toBe("Could not send yet. It will try again.");
  });
  it("dates a message by when it was sent, or first tried if it never was", () => {
    expect(deliveryTime({ sent_at: "2026-10-06T03:15:02Z", created_at: "2026-10-06T03:15:00Z" })).toMatch(/^6 Oct 08:45/);
    expect(deliveryTime({ sent_at: null, created_at: "2026-10-06T10:35:00Z" })).toMatch(/^6 Oct 16:05/);
  });
});
