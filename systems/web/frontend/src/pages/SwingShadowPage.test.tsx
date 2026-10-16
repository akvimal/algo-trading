import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SwingShadowPage } from "./SwingShadowPage";

const calls: string[] = [];
const row = (o: Record<string, unknown>) => ({
  snapshot_date: "2026-10-15", symbol: "PAGEIND", direction: "LONG", taken: true, skip_reason: null, score: 7, tier: "A", ref_close: 100, stop_price: 95, risk_pct: 5,
  criteria: { flow: { value: "call buying / put writing", pass: true, source: "premium_flow" }, oi_surge: { value: 1.8, pass: true }, events: { value: null, pass: null } },
  result: null, entry_price: null, exit_price: null, exit_day: null, r_multiple: null, mfe_r: null, mae_r: null, ...o,
});
let rows: unknown[] = [];

vi.mock("../api/http", async () => {
  const actual = await vi.importActual<typeof import("../api/http")>("../api/http");
  return {
    ...actual,
    api: async (_s: string, path: string) => {
      calls.push(path);
      if (path.startsWith("/oi-swing/summary")) {
        const b = { n: 3, resolved: 2, wins: 1, avg_r: 0.4 };
        return { nights: 4, first_night: "2026-10-12", last_night: "2026-10-15", taken: b, skipped: { n: 20, resolved: 18, wins: 9, avg_r: 0.1 }, by_direction: {} };
      }
      return { snapshot_date: "2026-10-15", rows };
    },
  };
});

beforeEach(() => {
  calls.length = 0;
  rows = [];
});

describe("the swing shadow log", () => {
  it("says so plainly when a night has nothing logged", async () => {
    render(<SwingShadowPage />);
    expect(await screen.findByText("Nothing logged for this night")).toBeInTheDocument();
  });

  it("shows the verdict, the stop and the outcome, and opens every criterion's value", async () => {
    rows = [row({}), row({ symbol: "CIPLA", direction: "SHORT", taken: false, skip_reason: "failed: market", result: "time", exit_day: 3, r_multiple: 0.47, mfe_r: 1.1, mae_r: 0.3 })];
    render(<SwingShadowPage />);
    const list = await screen.findByTestId("shadow-rows");
    expect(list).toHaveTextContent("would take");
    expect(list).toHaveTextContent("still running");
    expect(list).toHaveTextContent("failed: market");
    expect(list).toHaveTextContent("time on day 3, 0.47R");
    await userEvent.click(screen.getByText("PAGEIND"));
    expect(await screen.findByTestId("criteria-PAGEIND")).toHaveTextContent("Option flow: call buying / put writing");
    expect(screen.getByTestId("criteria-PAGEIND")).toHaveTextContent("Events: n/a"); // unevaluated is shown, not hidden
  });

  it("totals the would-take rows against the turned-away control", async () => {
    render(<SwingShadowPage />);
    const box = await screen.findByTestId("shadow-summary");
    expect(box).toHaveTextContent("Would have taken");
    expect(box).toHaveTextContent("Turned away (the control)");
    expect(box).toHaveTextContent("avg 0.40R");
  });

  it("filters by decision and walks to other nights", async () => {
    render(<SwingShadowPage />);
    await screen.findByText("Nothing logged for this night");
    await userEvent.click(screen.getByRole("button", { name: "Would take" }));
    await waitFor(() => expect(calls[calls.length - 1]).toContain("decision=taken"));
    await userEvent.click(screen.getByRole("button", { name: "Previous night" }));
    await waitFor(() => expect(calls[calls.length - 1]).toMatch(/day=\d{4}-\d{2}-\d{2}/));
  });
});
