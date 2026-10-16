import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpreadBotSection } from "./SpreadBotSection";

const calls: { path: string; method: string; body: unknown }[] = [];
let settings: Record<string, unknown>;
let decisions: unknown[];
let groups: unknown[] = [];

vi.mock("../../api/http", async () => {
  const actual = await vi.importActual<typeof import("../../api/http")>("../../api/http");
  return {
    ...actual,
    api: async (_service: string, path: string, init?: { method?: string; json?: unknown }) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.json });
      if (path.startsWith("/spread-bot/settings")) {
        if (init?.method === "PUT") {
          settings = { ...settings, ...(init.json as object) };
        }
        return settings;
      }
      if (path.startsWith("/option-groups")) return groups;
      return decisions;
    },
  };
});

beforeEach(() => {
  calls.length = 0;
  settings = { enabled: false, risk_pct: 1, symbols: ["NIFTY", "BANKNIFTY"], entry_from: "09:45", entry_to: "13:30", min_votes: 3, width_strikes: 2, max_trades_per_day: 2 };
  decisions = [];
  groups = [];
});

describe("the spread bot settings", () => {
  it("is off until switched on, and says so plainly when nothing has been decided", async () => {
    render(<SpreadBotSection />);
    expect(await screen.findByLabelText(/Credit-spread bot/)).not.toBeChecked();
    expect(await screen.findByText("Nothing here")).toBeInTheDocument();
  });

  it("switches on with one tick and saves its limits", async () => {
    render(<SpreadBotSection />);
    await userEvent.click(await screen.findByLabelText(/Credit-spread bot/));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && (c.body as any).enabled === true)).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
  });

  it("lists each decision with why and the four reads behind it", async () => {
    decisions = [{ id: 1, symbol: "NIFTY", decided_at: "2026-10-12T05:30:00Z", outcome: "skipped", reason: "the reads disagree (trend bullish; structure bearish)", votes: { trend: 1, oi: 0, structure: -1, premarket: 0 }, group_id: null }];
    render(<SpreadBotSection />);
    const list = await screen.findByTestId("bot-decisions");
    expect(list).toHaveTextContent("the reads disagree");
    expect(list).toHaveTextContent("Trend: bullish · OI: no lean · Structure: bearish · Pre-market: no lean");
  });

  it("filters the decisions by kind and walks back to other days", async () => {
    render(<SpreadBotSection />);
    await screen.findByText("Nothing here");
    const last = () => {
      const list = calls.filter((c) => c.path.startsWith("/spread-bot/decisions") && c.path.includes("limit=1000")); // not the trades' own "entered" lookup
      return list[list.length - 1].path;
    };
    expect(last()).toMatch(/day=\d{4}-\d{2}-\d{2}$/);
    await userEvent.click(screen.getByRole("button", { name: "Skipped" }));
    await waitFor(() => expect(last()).toContain("&outcome=skipped&status=false"));
    await userEvent.click(screen.getByRole("button", { name: "Status checks" }));
    await waitFor(() => expect(last()).toContain("&status=true"));
    const today = (screen.getByLabelText("Day") as HTMLInputElement).value;
    expect(screen.getByRole("button", { name: "Next day" })).toBeDisabled(); // nothing after today
    await userEvent.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(last()).not.toContain(`day=${today}`));
    expect(screen.getByRole("button", { name: "Today" })).toBeInTheDocument();
  });

  it("totals only the bot's own trades and lists why each ended", async () => {
    groups = [
      { id: "a", setup_tag: "spread-bot", underlying_symbol: "NIFTY", strategy_type: "bull_put_spread", status: "CLOSED", quantity: 3, pnl: 1200, entry_time: "2026-10-13T04:00:00Z", exit_time: "2026-10-13T08:00:00Z", exit_reason: "target" },
      { id: "b", setup_tag: "spread-bot", underlying_symbol: "BANKNIFTY", strategy_type: "bear_call_spread", status: "CLOSED", quantity: 2, pnl: -500, entry_time: "2026-10-12T04:00:00Z", exit_time: "2026-10-12T08:00:00Z", exit_reason: "stop_loss" },
      { id: "c", setup_tag: null, underlying_symbol: "ITC", strategy_type: "bear_call_spread", status: "CLOSED", quantity: 1, pnl: 9999, entry_time: "2026-10-12T04:00:00Z", exit_time: "2026-10-12T08:00:00Z", exit_reason: "target" },
    ];
    render(<SpreadBotSection />);
    const box = await screen.findByTestId("bot-results");
    expect(box).toHaveTextContent("+₹700");
    expect(box).toHaveTextContent("Win rate 50%");
    expect(box).toHaveTextContent("ended by stop loss");
    expect(box).not.toHaveTextContent("ITC");
  });
});
