import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PremarketInput, PremarketReport } from "../api/types";
import { PremarketCard } from "./PremarketCard";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const input = (key: string, label: string, change: number, over: Partial<PremarketInput> = {}): PremarketInput => ({
  key, label, group: "us", ok: true, value: 100, change, unit: "pct", source: "yahoo", error: null, ...over,
});

const report = (over: Partial<PremarketReport> = {}): PremarketReport => ({
  day: "2026-10-06",
  generated_at: new Date().toISOString(),
  bias: "bullish",
  agree: true,
  model: "test/model",
  ai_error: null,
  inputs: [input("gift_nifty", "GIFT Nifty", 0.33, { group: "india" }), input("brent", "Brent crude", 1.2, { group: "commodity" })],
  rules: { score: 0.4, bias: "bullish", coverage: 1, gift_gap_pct: 0.33, factors: [] },
  ai: { bias: "bullish", confidence: 72, one_liner: "Gap up on a firm US close.", reasons: ["GIFT Nifty is +0.33%"], risks: [], watch: "Hold above 22,600." },
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

function stub(routes: (url: string, method: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => routes(url, init?.method ?? "GET")));
}

describe("PremarketCard", () => {
  it("shows the verdict, confidence and headline", async () => {
    stub(() => json(report()));
    render(<PremarketCard />);
    expect(await screen.findByTestId("premarket-bias")).toHaveTextContent("Bullish");
    expect(screen.getByText("72% confident")).toBeInTheDocument();
    expect(screen.getByText("Gap up on a firm US close.")).toBeInTheDocument();
    expect(screen.queryByTestId("premarket-disagree")).not.toBeInTheDocument();
  });

  it("does not print 0% confident for a model that did not give a confidence", async () => {
    stub(() => json(report({ ai: { bias: "bullish", confidence: 0, one_liner: "Gap up.", reasons: [], risks: [], watch: "" } })));
    render(<PremarketCard />);
    expect(await screen.findByTestId("premarket-bias")).toHaveTextContent("Bullish");
    expect(screen.queryByText(/% confident/)).not.toBeInTheDocument();
  });

  it("says so when the AI and the fixed rules disagree", async () => {
    stub(() => json(report({ bias: "bearish", agree: false, ai: { bias: "bearish", confidence: 60, one_liner: "x", reasons: [], risks: [], watch: "" } })));
    render(<PremarketCard />);
    expect(await screen.findByTestId("premarket-disagree")).toHaveTextContent(/rules read this as bullish.*AI as bearish/);
  });

  it("explains an empty state instead of showing an error when no report exists yet", async () => {
    stub(() => json({ detail: "no pre-market report for that day yet" }, 404));
    render(<PremarketCard />);
    expect(await screen.findByText(/No pre-market report yet/)).toBeInTheDocument();
  });

  it("treats a malformed answer as no report rather than crashing", async () => {
    stub(() => json([]));
    render(<PremarketCard />);
    expect(await screen.findByText(/No pre-market report yet/)).toBeInTheDocument();
  });

  it("colours crude's rise as bad news and prints yields in basis points", async () => {
    stub(() => json(report({ inputs: [input("brent", "Brent crude", 1.2, { group: "commodity" }), input("us10y", "US 10Y yield", 3.4, { unit: "bp", group: "yield" })] })));
    render(<PremarketCard />);
    await userEvent.click(await screen.findByText("Reasoning and numbers"));
    expect(screen.getByText("+1.20%")).toHaveClass("dn");
    expect(screen.getByText("+3.4 bp")).toHaveClass("dn");
  });

  it("replaces the report with the refreshed one", async () => {
    let refreshed = false;
    stub((_url, method) => {
      if (method === "POST") {
        refreshed = true;
        return json(report({ bias: "neutral", ai: null, agree: null, ai_error: "No OpenRouter key - showing the rule-based bias only." }));
      }
      return json(report());
    });
    render(<PremarketCard />);
    await screen.findByTestId("premarket-bias");
    await userEvent.click(screen.getByRole("button", { name: /refresh the pre-market report/i }));
    await waitFor(() => expect(screen.getByTestId("premarket-bias")).toHaveTextContent("Neutral"));
    expect(refreshed).toBe(true);
    expect(screen.getByText(/No OpenRouter key/)).toBeInTheDocument();
  });

  it("shows the server's wait message when a refresh is rate limited", async () => {
    stub((_url, method) => (method === "POST" ? json({ detail: "Just refreshed - try again in 20s." }, 429) : json(report())));
    render(<PremarketCard />);
    await screen.findByTestId("premarket-bias");
    await userEvent.click(screen.getByRole("button", { name: /refresh the pre-market report/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("try again in 20s");
    expect(screen.getByTestId("premarket-bias")).toHaveTextContent("Bullish");
  });

  describe("domestic backdrop", () => {
    const macro: NonNullable<PremarketReport["macro"]> = {
      indicators: [
        { key: "cpi", label: "Inflation (CPI, YoY)", unit: "pct", ok: true, value: 4.82, previous: 4.44, change: 0.38, period: "2026-08-31", error: null },
        { key: "repo", label: "RBI repo rate", unit: "pct", ok: true, value: 5.25, previous: 5.25, change: 0, period: "2026-09-30", error: null },
        { key: "fx_reserves", label: "FX reserves", unit: "usd_bn", ok: true, value: 747.56, previous: 765.9, change: -18.34, period: "2026-09-25", error: null },
        { key: "iip", label: "Industrial production (IIP, YoY)", unit: "pct", ok: false, value: null, previous: null, change: null, period: null, error: "x" },
      ],
      derived: { real_rate: 0.43, spread_10y_repo: 1.97, india_10y: 7.2 },
      rbi: [{ title: "Preserving Financial Stability - Address by the Governor", url: "https://rbi.example/s1", published: "2026-10-03T05:30:00Z", kind: "speech" }],
    };

    it("shows the prints against the ones before, the real rate, and linked RBI items, and the model's reading of them", async () => {
      const ai = { bias: "bullish" as const, confidence: 70, one_liner: "x", reasons: [], risks: [], watch: "", macro_context: "Inflation is edging up but the real rate stays positive." };
      stub(() => json(report({ ai, macro })));
      render(<PremarketCard />);
      await userEvent.click(await screen.findByText("Reasoning and numbers"));
      const box = screen.getByTestId("premarket-backdrop");
      expect(within(box).getByText("Inflation is edging up but the real rate stays positive.")).toBeInTheDocument();
      expect(within(box).getByText("4.82%")).toBeInTheDocument();
      expect(within(box).getByText("Aug 2026 · up 0.38 from 4.44%")).toBeInTheDocument();
      expect(within(box).getByText("Sep 2026 · unchanged at 5.25%")).toBeInTheDocument();
      expect(within(box).getByText("$747.6bn")).toBeInTheDocument();
      expect(within(box).getByText("+0.43 pts")).toBeInTheDocument();
      expect(within(box).getByText("+1.97 pts")).toBeInTheDocument();
      expect(within(box).getByRole("link", { name: /Preserving Financial Stability/ })).toHaveAttribute("href", "https://rbi.example/s1");
      // A print the feed could not give is left out rather than shown as a dash row.
      expect(within(box).queryByText(/Industrial production/)).not.toBeInTheDocument();
    });

    it("shows no backdrop section for an older report that has none", async () => {
      stub(() => json(report({ macro: null })));
      render(<PremarketCard />);
      await userEvent.click(await screen.findByText("Reasoning and numbers"));
      expect(screen.queryByTestId("premarket-backdrop")).not.toBeInTheDocument();
    });

    it("says so when the macro figures could not be loaded but the RBI items could", async () => {
      const down = { ...macro, indicators: macro.indicators.map((i) => ({ ...i, ok: false })), derived: { real_rate: null, spread_10y_repo: null, india_10y: null } };
      stub(() => json(report({ macro: down })));
      render(<PremarketCard />);
      await userEvent.click(await screen.findByText("Reasoning and numbers"));
      expect(screen.getByText("The macro figures could not be loaded for this report.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Preserving Financial Stability/ })).toBeInTheDocument();
    });
  });
});
