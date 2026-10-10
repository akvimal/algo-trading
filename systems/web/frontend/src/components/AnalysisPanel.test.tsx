import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StockAnalysis } from "../api/analysis";
import { AnalysisPanel } from "./AnalysisPanel";
import { ladder, readAge } from "./analysisModel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const FETCHED = new Date(Date.now() - 3 * 86_400_000).toISOString();

const analysis = (over: Partial<StockAnalysis> = {}): StockAnalysis => ({
  symbol: "CUPID",
  as_of: "2026-10-12",
  price: 366.1,
  verdict: {
    bias: "bullish", confidence: 0.64, agreement: "conflicting",
    headline: "Price is rising, but the business case is weak",
    reading: "The chart and the business disagree. A move can still happen, but the case for it is weaker, so size and expectations should be smaller.",
  },
  technical: {
    bias: "bullish", confidence: 0.8, trend_strength: "trending",
    points: ["Weekly: price is above its 50-week average", "Trend strength is strong (ADX 31, rising)", "Volume is above its 20-bar average"],
    support: [{ low: 340, high: 348, basis: "support pivot", timeframe: "daily", distance_pct: 5 }],
    resistance: [{ low: 380, high: 392, basis: "resistance pivot", timeframe: "weekly", distance_pct: 3.8 }, { low: 410, high: 420, basis: "resistance pivot", timeframe: "weekly", distance_pct: 12 }],
  },
  fundamental: {
    available: true, bias: "neutral", confidence: 0.65, summary: "Strong growth, but a very high price to book and no dividend.",
    pros: ["Profit growth 31% a year", "Working capital days down"], cons: ["Trades at 109 times book value"], reasons: ["High valuation"],
    fetched_at: FETCHED, note: null, needs_key: false,
  },
  signals: [
    { category: "trend", direction: "bullish", text: "weekly close above EMA50" },
    { category: "structure", direction: "bearish", text: "close to resistance" },
  ],
  ...over,
});

let calls: string[];
let reply: () => Response;

beforeEach(() => {
  calls = [];
  reply = () => json(analysis());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return reply();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  render(
    <MemoryRouter>
      <AnalysisPanel symbol="CUPID" />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole("button", { name: "AI analysis" }));
  return await screen.findByTestId("analysis-verdict");
};

describe("the analysis card", () => {
  it("does nothing until the button is pressed", () => {
    render(
      <MemoryRouter>
        <AnalysisPanel symbol="CUPID" />
      </MemoryRouter>,
    );
    expect(calls).toEqual([]);
  });

  it("leads with one verdict: the headline, whether the two sides agree, the overall lean, and what that means", async () => {
    const verdict = await open(userEvent.setup());
    expect(calls[0]).toMatch(/\/analysis\/CUPID$/);
    expect(verdict).toHaveTextContent("Price is rising, but the business case is weak");
    expect(screen.getByTestId("analysis-agreement")).toHaveTextContent("Chart and business disagree");
    expect(screen.getByTestId("analysis-agreement")).toHaveClass("warn");
    expect(verdict).toHaveTextContent("Overall ▲ Bullish · 64%");
    expect(verdict).toHaveTextContent(/so size and expectations should be smaller/);
    expect(verdict).toHaveClass("up");
  });

  it("puts the chart and the business side by side, each with its own lean", async () => {
    await open(userEvent.setup());
    const chart = within(screen.getByRole("region", { name: "The chart" }));
    expect(chart.getByText(/▲ Bullish · 80%/)).toBeInTheDocument();
    expect(chart.getByText("Trend strength is strong (ADX 31, rising)")).toBeInTheDocument();
    const business = within(screen.getByRole("region", { name: "The business" }));
    expect(business.getByText(/◆ Neutral · 65%/)).toBeInTheDocument();
    expect(business.getByText(/very high price to book/)).toBeInTheDocument();
    expect(within(business.getByRole("list", { name: "Strengths" })).getAllByRole("listitem")).toHaveLength(2);
    expect(within(business.getByRole("list", { name: "Concerns" })).getByText("Trades at 109 times book value")).toBeInTheDocument();
  });

  it("shows where the price sits: resistance above, the price, support below, with the distance to each", async () => {
    await open(userEvent.setup());
    const rows = within(screen.getByTestId("analysis-ladder")).getAllByText(/./, { selector: ".ladder-label" }).map((e) => e.textContent);
    expect(rows).toEqual(["▲ weekly resistance", "▲ weekly resistance", "● Price now", "▼ daily support"]);
    const ladderText = screen.getByTestId("analysis-ladder").textContent ?? "";
    expect(ladderText).toContain("+3.8%");
    expect(ladderText).toContain("−5.0%");
    expect(ladderText.indexOf("410")).toBeLessThan(ladderText.indexOf("380")); // the furthest resistance first, so it reads like the chart
  });

  it("keeps every signal one tap away", async () => {
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByText(/Every signal behind it \(2 \+ 1 business reasons\)/));
    expect(screen.getByText("weekly close above EMA50")).toBeInTheDocument();
    expect(screen.getByText("High valuation")).toBeInTheDocument();
  });
});

describe("without the business read", () => {
  const noBusiness = (needsKey: boolean) =>
    analysis({
      verdict: { bias: "bullish", confidence: 0.8, agreement: "technical_only", headline: "The trend is up (business read not available)", reading: "This is the chart only." },
      fundamental: { available: false, bias: null, confidence: null, summary: null, pros: [], cons: [], reasons: [], fetched_at: null, note: "Fundamentals are read by AI and need an OpenRouter key: add yours in Settings.", needs_key: needsKey },
    });

  it("still shows the chart, says why the business side is empty, and points to Settings when it is the key", async () => {
    reply = () => json(noBusiness(true));
    await open(userEvent.setup());
    expect(screen.getByTestId("analysis-agreement")).toHaveTextContent("Chart only");
    const business = within(screen.getByRole("region", { name: "The business" }));
    expect(business.getByText(/need an OpenRouter key/)).toBeInTheDocument();
    expect(business.getByRole("link", { name: "Add your key in Settings" })).toHaveAttribute("href", "/more/settings?tab=broker");
    expect(within(screen.getByRole("region", { name: "The chart" })).getByText(/Weekly: price is above/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /See what the AI read/ })).not.toBeInTheDocument(); // there is no page read to look at
  });

  it("offers no Settings link when the key is not the problem", async () => {
    reply = () => json(noBusiness(false));
    await open(userEvent.setup());
    expect(screen.queryByRole("link", { name: "Add your key in Settings" })).not.toBeInTheDocument();
  });
});

describe("refreshing and failing", () => {
  it("asks for a fresh capture, and says so when nothing changed", async () => {
    const user = userEvent.setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls.some((c) => c.endsWith("?refresh=true"))).toBe(true));
    expect(await screen.findByText(/kept as it was/)).toBeInTheDocument();
  });

  it("shows nothing about it when the page was captured again", async () => {
    const user = userEvent.setup();
    await open(user);
    reply = () => json(analysis({ fundamental: { ...analysis().fundamental, fetched_at: new Date().toISOString() } }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByText(/Business read from screener.in today/)).toBeInTheDocument());
    expect(screen.queryByText(/kept as it was/)).not.toBeInTheDocument();
  });

  it("explains a stock with too little history, and offers to try again", async () => {
    reply = () => json({ detail: "NEWCO has too little price history for a weekly and daily read" }, 422);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AnalysisPanel symbol="NEWCO" />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: "AI analysis" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/too little price history/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("keeps the earlier analysis on screen when a refresh fails", async () => {
    const user = userEvent.setup();
    await open(user);
    reply = () => json({ detail: "Could not load CUPID's price history right now. Try again in a moment." }, 502);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/price history/);
    expect(screen.getByTestId("analysis-verdict")).toHaveTextContent("Price is rising");
  });
});

describe("the model", () => {
  it("lists the ladder with the furthest resistance first and the nearest support right under the price", () => {
    const rows = ladder(analysis());
    expect(rows.map((r) => `${r.kind}:${r.low}`)).toEqual(["resistance:410", "resistance:380", "price:366.1", "support:340"]);
    expect(rows.find((r) => r.kind === "support")!.distancePct).toBe(-5);
  });

  it("says how old a read is", () => {
    const now = new Date("2026-10-12T10:00:00Z");
    expect(readAge("2026-10-12T02:00:00Z", now)).toBe("today");
    expect(readAge("2026-10-11T08:00:00Z", now)).toBe("yesterday");
    expect(readAge("2026-10-02T08:00:00Z", now)).toBe("10 days ago");
    expect(readAge(null, now)).toBe("");
  });
});
