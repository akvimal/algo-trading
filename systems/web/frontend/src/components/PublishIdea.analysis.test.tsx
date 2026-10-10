import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StockAnalysis } from "../api/analysis";
import type { StudyNote } from "../api/types";
import { clearIdeaAnalysisCache } from "../hooks/useIdeaAnalysis";
import { PublishIdea } from "./PublishIdea";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const note = (over: Partial<StudyNote> = {}): StudyNote => ({
  id: "n1", segment: "NSE", symbol: "CUPID", interval: "1d", text: "Pullback to the 50-day average.", tag: "plan", context: null,
  position_id: null, option_group_id: null, has_snapshot: false, created_at: "2026-10-12T05:00:00Z", ...over,
});

const analysis = (): StockAnalysis => ({
  symbol: "CUPID", as_of: "2026-10-12", price: 366.1,
  verdict: { bias: "bullish", confidence: 0.9, agreement: "mixed", headline: "The trend is up; the business read is mixed", reading: "long text that is not sent" },
  technical: {
    bias: "bullish", confidence: 1, trend_strength: "trending", points: ["one", "two", "three", "four"],
    support: [{ low: 340, high: 348, basis: "support", timeframe: "daily", distance_pct: 5.2 }, { low: 300, high: 305, basis: "support", timeframe: "daily", distance_pct: 18 }],
    resistance: [],
  },
  fundamental: { available: true, bias: "neutral", confidence: 0.65, summary: "Strong growth, costly.", pros: ["p1", "p2", "p3"], cons: ["c1", "c2", "c3"], reasons: ["r"], fetched_at: "2026-10-10T05:00:00Z", note: null, needs_key: false },
  signals: [],
});

let calls: { url: string; method: string; body: any }[];
let analysisReply: () => Response;

beforeEach(() => {
  clearIdeaAnalysisCache();
  calls = [];
  analysisReply = () => json(analysis());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (url.includes("/analysis/")) return analysisReply();
      if (url.includes("/positions") || url.includes("/option-groups")) return json([]);
      if (url.endsWith("/ideas/preview")) {
        return json({ text: `💡 ${body.symbol}\n\n${body.text}${body.analysis ? `\n\n🔎 AI analysis: ${body.analysis.verdict}` : ""}\n\nDisclaimer.`, messages: 1, has_image: false, destination_hint: "…7890" });
      }
      if (url.endsWith("/ideas/publish")) return json({ note_id: "n1", published: true, published_at: "2026-10-12T06:00:00Z", unpublished_at: null, destination_hint: "…7890", has_image: false });
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const lastPreview = () => [...calls].reverse().find((c) => c.url.endsWith("/ideas/preview"))!.body;
const openIt = async (n: StudyNote = note()) => {
  render(<PublishIdea note={n} state={undefined} onChanged={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Publish idea" }));
  await screen.findByTestId("idea-preview");
};

describe("publishing with the AI analysis", () => {
  it("is offered for an NSE stock, off until ticked, and nothing is read until then", async () => {
    await openIt();
    const box = screen.getByRole("checkbox", { name: /Include the AI analysis/ });
    expect(box).not.toBeChecked();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/ideas/preview"))).toBe(true));
    expect(calls.some((c) => c.url.includes("/analysis/"))).toBe(false);
    expect(lastPreview()).not.toHaveProperty("analysis");
  });

  it("is not offered for a commodity or crypto note, whose analysis is not available", async () => {
    await openIt(note({ segment: "MCX", symbol: "GOLDM" }));
    expect(screen.queryByRole("checkbox", { name: /Include the AI analysis/ })).not.toBeInTheDocument();
  });

  it("reads the analysis when ticked and the preview then shows it, sent as a short form of the analysis and nothing else", async () => {
    const user = userEvent.setup();
    await openIt();
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    await waitFor(() => expect(lastPreview()).toHaveProperty("analysis"));
    expect(calls.some((c) => c.url.endsWith("/analysis/CUPID"))).toBe(true);
    expect(lastPreview().analysis).toEqual({
      verdict: "The trend is up; the business read is mixed", agreement: "mixed", overall: "bullish", overall_strength: "strong", chart_bias: "bullish",
      chart_points: ["one", "two", "three", "four"], price: 366.1, as_of: "2026-10-12", business_bias: "neutral", business_confidence: 0.65,
      business_summary: "Strong growth, costly.", pros: ["p1", "p2"], cons: ["c1", "c2"],
      support: { low: 340, high: 348, distance_pct: 5.2 }, resistance: null,
    });
    expect(await screen.findByText(/🔎 AI analysis: The trend is up/)).toBeInTheDocument();
  });

  it("publishes exactly what was previewed, with the analysis", async () => {
    const user = userEvent.setup();
    await openIt();
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    await screen.findByText(/🔎 AI analysis/);
    await user.click(screen.getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/ideas/publish"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/ideas/publish"))!.body.analysis.verdict).toBe("The trend is up; the business read is mixed");
  });

  it("waits for the analysis before building a preview or allowing the post", async () => {
    let release: () => void = () => undefined;
    analysisReply = () => {
      throw new Error("replaced below");
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        if (url.includes("/analysis/")) return new Promise<Response>((resolve) => (release = () => resolve(json(analysis()))));
        if (url.includes("/positions") || url.includes("/option-groups")) return json([]);
        if (url.endsWith("/ideas/preview")) return json({ text: `💡 x${body.analysis ? "\n\n🔎 AI analysis" : ""}`, messages: 1, has_image: false, destination_hint: "…7890" });
        return json({}, 404);
      }),
    );
    const user = userEvent.setup();
    await openIt();
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(/up to a minute/);
    expect(screen.queryByText(/Building the preview/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish now" })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish now" })).toBeEnabled());
    expect(await screen.findByText(/🔎 AI analysis/)).toBeInTheDocument();
  });

  it("says when the analysis cannot be read, blocks the post, and lets the person untick it to publish without", async () => {
    analysisReply = () => json({ detail: "CUPID has too little price history for a weekly and daily read" }, 422);
    const user = userEvent.setup();
    await openIt();
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/too little price history.*Untick it to publish without the analysis/);
    expect(screen.getByRole("button", { name: "Publish now" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish now" })).toBeEnabled());
    expect(lastPreview()).not.toHaveProperty("analysis");
  });

  it("does not read the same stock again when it is unticked and ticked", async () => {
    const user = userEvent.setup();
    await openIt();
    const box = screen.getByRole("checkbox", { name: /Include the AI analysis/ });
    await user.click(box);
    await screen.findByText(/🔎 AI analysis/);
    await user.click(box);
    await user.click(box);
    await screen.findByText(/🔎 AI analysis/);
    expect(calls.filter((c) => c.url.includes("/analysis/"))).toHaveLength(1);
  });
});
