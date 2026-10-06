import { render, screen, waitFor } from "@testing-library/react";
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
    await userEvent.click(await screen.findByText("Why, and the numbers"));
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
});
