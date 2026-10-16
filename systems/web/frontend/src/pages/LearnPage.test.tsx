import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEligibility, MistakeSummary } from "../api/types";
import { LearnPage } from "./LearnPage";

vi.mock("../auth/ProfileContext", () => ({ useProfile: () => ({ markets: ["NSE", "MCX"] }) }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const req = (key: string, label: string, met: boolean) => ({ key, label, required: "x", actual: "y", met });
let elig: LiveEligibility;
let summary: MistakeSummary;
let calls: string[];

const block = (n: number, pnl: number) => ({ n, pnl, avg_loss: null });
const blank = (): MistakeSummary => ({
  segment: "NSE", reviewed: 0, pending: 0,
  by_level: { study: block(0, 0), plan: block(0, 0), execution: block(0, 0), clean: block(0, 0) },
  by_tag: {}, clean: { ...block(0, 0), lost: 0 }, flawed: block(0, 0), trades_since_last: {},
});

beforeEach(() => {
  calls = [];
  elig = { segment: "NSE", enforced: false, eligible: false, requirements: [req("costs", "Realistic costs switched on", true), req("trades", "Paper trades recorded with costs", false), req("discipline", "Discipline score", false)] };
  summary = blank();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/live-eligibility/")) return json(elig);
      if (url.includes("/trade-review/summary/")) return json(summary);
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderPage = () => render(<MemoryRouter initialEntries={["/learn"]}><LearnPage /></MemoryRouter>);

describe("LearnPage", () => {
  it("shows each live-readiness check, ticked or not, with what an unmet one means", async () => {
    renderPage();
    const rows = await screen.findAllByTestId("requirement");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText(/Realistic costs/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/A handful of trades proves nothing/)).toBeInTheDocument();
    expect(within(rows[0]).queryByText(/Paper results without charges/)).toBeNull(); // a met check needs no explanation
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.getByText(/For now they are a guide/)).toBeInTheDocument();
  });

  it("asks for a review first when there are no reviewed trades", async () => {
    summary = { ...blank(), pending: 3 };
    renderPage();
    expect(await screen.findByText("No reviewed trades yet")).toBeInTheDocument();
    expect(screen.getByTestId("review-first")).toHaveTextContent("3 closed trades are not reviewed yet");
    expect(screen.getByRole("link", { name: "Review now" })).toHaveAttribute("href", "/portfolio?segment=NSE&tab=review");
  });

  it("ranks the person's own mistakes, names the one to start with, and shows the clean run", async () => {
    summary = {
      ...blank(), reviewed: 12,
      by_tag: { no_stop: { ...block(6, -14200), level: "plan" }, against_trend: { ...block(4, -3000), level: "study" }, revenge: { ...block(2, -900), level: "execution" } },
      trades_since_last: { no_stop: 0, against_trend: 3, revenge: 14 },
    };
    renderPage();
    const focus = await screen.findByTestId("focus");
    expect(focus).toHaveTextContent("Against the trend"); // the earliest step still being repeated, not the costliest
    expect(focus).toHaveTextContent("Read the trend on your context interval first");
    const rows = screen.getAllByTestId("habit-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("No stop"); // still repeated, costliest first
    expect(rows[1]).toHaveTextContent("Against the trend");
    expect(rows[2]).toHaveTextContent("Revenge trade or overtrading"); // fixed goes last
    expect(rows[1]).toHaveTextContent("3 of 10 clean");
    expect(rows[2]).toHaveTextContent("Fixed");
  });

  it("lists every habit with its rule, and the learning path with its lessons marked as coming", async () => {
    renderPage();
    await screen.findByText("No reviewed trades yet");
    expect(screen.getByText(/Every habit and its rule/)).toBeInTheDocument();
    await userEvent.click(screen.getByText(/Part A: Reading the market/));
    const lessons = within(screen.getByTestId("path")).getAllByTestId("lesson");
    expect(lessons).toHaveLength(26); // 12 + 7 + 2 + 5
    expect(screen.getAllByText("Coming soon")[0]).toBeInTheDocument();
  });

  it("reloads for another account when it is picked", async () => {
    renderPage();
    await screen.findAllByTestId("requirement");
    await userEvent.click(screen.getByRole("button", { name: "Commodities" }));
    await waitFor(() => expect(calls.some((c) => c.includes("/live-eligibility/MCX"))).toBe(true));
    expect(calls.some((c) => c.includes("/trade-review/summary/MCX"))).toBe(true);
  });
});
