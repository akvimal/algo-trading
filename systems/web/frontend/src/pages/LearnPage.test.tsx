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
  it("draws readiness as a ring, one tile per check, and names the single next step", async () => {
    renderPage();
    const tiles = await screen.findAllByTestId("requirement");
    expect(tiles).toHaveLength(3);
    expect(tiles.map((t) => t.getAttribute("data-met"))).toEqual(["true", "false", "false"]);
    expect(screen.getByRole("img", { name: "1 of 3 readiness checks met" })).toBeInTheDocument();
    const next = screen.getByTestId("next-step");
    expect(next).toHaveTextContent("Paper trades"); // the quickest unmet check, not the first row
    expect(within(next).getByRole("link", { name: "Place a paper trade" })).toHaveAttribute("href", "/trade");
    expect(screen.getByText(/For now they are a guide/)).toBeInTheDocument();
  });

  it("draws meters from the numbers the server sends", async () => {
    elig = {
      segment: "NSE", enforced: true, eligible: false,
      requirements: [
        { ...req("trades", "Paper trades recorded with costs", false), actual: "12 trades", required: "30 trades", value: 12, target: 30 },
        { ...req("days", "Days on the current record", false), actual: "9 days", required: "14 days", value: 9, target: 14 },
        { ...req("drawdown", "Max drawdown", true), actual: "5.0%", required: "<= 20%", value: 5, target: 20, higher_is_better: false },
        { ...req("profit", "Net profit after costs", true), actual: "1200.00", required: "> 0", value: 1200, target: 0 },
      ],
    };
    renderPage();
    await screen.findAllByTestId("requirement");
    expect(screen.getByRole("img", { name: "12 trades, 30 trades" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "9 of 14 days" })).toBeInTheDocument();
    expect(screen.getByText("▲ +1,200")).toBeInTheDocument();
    expect(screen.queryByText(/do not block you/)).toBeNull();
  });

  it("says every check is met when they all are, with no next step", async () => {
    elig = { ...elig, eligible: true, requirements: elig.requirements.map((r) => ({ ...r, met: true })) };
    renderPage();
    await screen.findAllByTestId("requirement");
    expect(screen.getByText(/Every check is met on paper/)).toBeInTheDocument();
    expect(screen.queryByTestId("next-step")).toBeNull();
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
