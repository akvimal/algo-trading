import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StockAnalysis } from "../api/analysis";
import type { StudyNote } from "../api/types";
import { clearIdeaAnalysisCache } from "../hooks/useIdeaAnalysis";
import { PublishIdea } from "./PublishIdea";

const composeAnalysisCard = vi.fn();
vi.mock("../chart/analysisCard", async (orig) => ({ ...(await orig<typeof import("../chart/analysisCard")>()), composeAnalysisCard: (...a: unknown[]) => composeAnalysisCard(...a) }));
const CARD = "data:image/png;base64,CARD";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const note = (over: Partial<StudyNote> = {}): StudyNote => ({
  id: "n1", segment: "NSE", symbol: "CUPID", interval: "1d", text: "Pullback to the 50-day average.", tag: "plan", context: null,
  position_id: null, option_group_id: null, has_snapshot: false, created_at: "2026-10-12T05:00:00Z", ...over,
});

const analysis = (): StockAnalysis => ({
  symbol: "CUPID", as_of: "2026-10-12", price: 366.1,
  verdict: { bias: "bullish", confidence: 0.9, agreement: "mixed", headline: "The trend is up; the business read is mixed", reading: "r" },
  technical: { bias: "bullish", confidence: 1, trend_strength: "trending", points: ["one", "two"], support: [], resistance: [] },
  fundamental: { available: true, bias: "neutral", confidence: 0.65, summary: "Strong growth, costly.", pros: ["p1"], cons: ["c1"], reasons: [], fetched_at: null, note: null, needs_key: false },
  signals: [],
});

let calls: { url: string; method: string; body: any }[];

beforeEach(() => {
  clearIdeaAnalysisCache();
  composeAnalysisCard.mockReset();
  composeAnalysisCard.mockResolvedValue(CARD);
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (url.includes("/analysis/")) return json(analysis());
      if (url.includes("/positions") || url.includes("/option-groups")) return json([]);
      if (url.includes("/study-notes/") && url.includes("/snapshot")) return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), { status: 200 });
      if (url.endsWith("/ideas/preview")) return json({ text: `💡 ${body.symbol}`, messages: 1, has_image: Boolean(body.snapshot_png_base64), destination_hint: "…7890" });
      if (url.endsWith("/ideas/publish")) return json({ note_id: "n1", published: true, published_at: "2026-10-12T06:00:00Z", unpublished_at: null, destination_hint: "…7890", has_image: true });
      return json({ detail: `unrouted ${url}` }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const lastPreview = () => [...calls].reverse().find((c) => c.url.endsWith("/ideas/preview"))!.body;
const withSnapshot = (over: Partial<StudyNote> = {}) => note({ has_snapshot: true, has_clean_snapshot: true, ...over });
const openIt = async (n: StudyNote = note()) => {
  render(<PublishIdea note={n} state={undefined} onChanged={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Publish idea" }));
  await screen.findByTestId("idea-preview");
};

describe("the analysis card as the post's picture", () => {
  it("is built from the analysis and sent as the picture, and the preview shows that very picture", async () => {
    const user = userEvent.setup();
    await openIt();
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    expect(await screen.findByTestId("analysis-card-preview")).toHaveAttribute("src", CARD);
    expect(composeAnalysisCard).toHaveBeenCalledTimes(1);
    expect(composeAnalysisCard.mock.calls[0][0]).toMatchObject({ title: "CUPID · 1d", chart: null, analysis: { verdict: "The trend is up; the business read is mixed" } });
    await waitFor(() => expect(lastPreview().snapshot_png_base64).toBe(CARD));
    await user.click(screen.getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/ideas/publish"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/ideas/publish"))!.body.snapshot_png_base64).toBe(CARD);
  });

  it("puts the note's own chart (the chart-only one) on top of the card", async () => {
    const user = userEvent.setup();
    await openIt(withSnapshot());
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    await screen.findByTestId("analysis-card-preview");
    expect(calls.some((c) => c.url.includes("/study-notes/n1/snapshot?variant=clean"))).toBe(true);
    expect(composeAnalysisCard.mock.calls[0][0].chart).toMatch(/^data:image\/png;base64,/);
  });

  it("switches the plain chart picture off while the card, which already has the chart on it, goes out", async () => {
    const user = userEvent.setup();
    await openIt(withSnapshot());
    const plain = screen.getByRole("checkbox", { name: /Include the chart image/ });
    await user.click(plain);
    expect(plain).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    await screen.findByTestId("analysis-card-preview");
    expect(plain).toBeDisabled();
    expect(plain).not.toBeChecked();
    await waitFor(() => expect(lastPreview().snapshot_png_base64).toBe(CARD)); // the card, not the plain chart
    expect(screen.getByText(/already has the chart on it/)).toBeInTheDocument();
  });

  it("goes out as text, and says so, when the browser cannot draw the card", async () => {
    composeAnalysisCard.mockResolvedValue(null);
    const user = userEvent.setup();
    await openIt();
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    expect(await screen.findByText(/could not draw the picture, so the analysis goes out as text/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish now" })).toBeEnabled());
    expect(lastPreview().analysis).toBeDefined();
    expect(lastPreview()).not.toHaveProperty("snapshot_png_base64");
  });

  it("is not built when the analysis is not included", async () => {
    await openIt();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/ideas/preview"))).toBe(true));
    expect(composeAnalysisCard).not.toHaveBeenCalled();
    expect(screen.queryByTestId("analysis-card-preview")).not.toBeInTheDocument();
  });

  it("holds the Publish button until the card is built", async () => {
    let release: (v: string) => void = () => undefined;
    composeAnalysisCard.mockReturnValue(new Promise<string>((resolve) => (release = resolve)));
    const user = userEvent.setup();
    await openIt();
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    await waitFor(() => expect(composeAnalysisCard).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Publish now" })).toBeDisabled();
    release(CARD);
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish now" })).toBeEnabled());
    expect(await screen.findByTestId("analysis-card-preview")).toBeInTheDocument();
  });
});
