import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpreadBotSection } from "./SpreadBotSection";

const calls: { path: string; method: string; body: unknown }[] = [];
let settings: Record<string, unknown>;
let decisions: unknown[];

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
      return decisions;
    },
  };
});

beforeEach(() => {
  calls.length = 0;
  settings = { enabled: false, risk_pct: 1, symbols: ["NIFTY", "BANKNIFTY"], entry_from: "09:45", entry_to: "13:30", min_votes: 3, width_strikes: 2, max_trades_per_day: 2 };
  decisions = [];
});

describe("the spread bot settings", () => {
  it("is off until switched on, and says so plainly when nothing has been decided", async () => {
    render(<SpreadBotSection />);
    expect(await screen.findByLabelText(/Credit-spread bot/)).not.toBeChecked();
    expect(await screen.findByText("No decisions yet")).toBeInTheDocument();
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
});
