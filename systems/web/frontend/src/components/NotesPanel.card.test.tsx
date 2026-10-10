import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StockAnalysis } from "../api/analysis";
import type { NoteContext, StudyNote } from "../api/types";
import { clearIdeaAnalysisCache } from "../hooks/useIdeaAnalysis";
import { NotesPanel } from "./NotesPanel";

const listNotes = vi.fn();
const addNote = vi.fn();
vi.mock("../api/notes", () => ({ listNotes: (...a: unknown[]) => listNotes(...a), addNote: (...a: unknown[]) => addNote(...a), deleteNote: vi.fn(), fetchSnapshotUrl: vi.fn() }));

const previewIdea = vi.fn();
const publishIdea = vi.fn();
vi.mock("../api/ideas", async (orig) => ({ ...(await orig<typeof import("../api/ideas")>()), previewIdea: (...a: unknown[]) => previewIdea(...a), publishIdea: (...a: unknown[]) => publishIdea(...a) }));

const getAnalysis = vi.fn();
vi.mock("../api/analysis", async (orig) => ({ ...(await orig<typeof import("../api/analysis")>()), getAnalysis: (...a: unknown[]) => getAnalysis(...a) }));

vi.mock("../auth/AuthContext", async (orig) => ({ ...(await orig<typeof import("../auth/AuthContext")>()), useIsAdmin: () => true }));
vi.mock("../chart/snapshot", async (orig) => ({ ...(await orig<typeof import("../chart/snapshot")>()), composeSnapshot: vi.fn().mockResolvedValue("data:image/png;base64,CLEAN") }));

const composeAnalysisCard = vi.fn();
vi.mock("../chart/analysisCard", async (orig) => ({ ...(await orig<typeof import("../chart/analysisCard")>()), composeAnalysisCard: (...a: unknown[]) => composeAnalysisCard(...a) }));
const CARD = "data:image/png;base64,CARD";
const getChartImage = vi.fn();

const CTX: NoteContext = { price: 366.1, interval: "1d" };
const stock = (): StockAnalysis => ({
  symbol: "CUPID", as_of: "2026-10-12", price: 366.1,
  verdict: { bias: "bullish", confidence: 0.5, agreement: "aligned", headline: "The trend and the business both point up", reading: "x" },
  technical: { bias: "bullish", confidence: 0.5, trend_strength: "trending", points: ["Weekly: above its 50-week average"], support: [], resistance: [] },
  fundamental: { available: true, bias: "bullish", confidence: 0.7, summary: "Solid.", pros: ["Debt free"], cons: ["Costly"], reasons: [], fetched_at: null, note: null, needs_key: false },
  signals: [],
});
const saved = (b: { text: string; tag: string }): StudyNote => ({ id: "saved1", segment: "NSE", symbol: "CUPID", interval: "1d", text: b.text, tag: b.tag as never, context: CTX, position_id: null, option_group_id: null, has_snapshot: false, created_at: new Date().toISOString() });

async function ready(user: ReturnType<typeof userEvent.setup>) {
  render(
    <MemoryRouter>
      <NotesPanel segment="NSE" symbol="CUPID" interval="1d" getContext={() => CTX} getChartImage={(...a: unknown[]) => getChartImage(...a)} aiRead={null} />
    </MemoryRouter>,
  );
  await user.click(screen.getByTestId("notes-toggle"));
  await user.type(await screen.findByLabelText("Note"), "Pullback to the 50-day average");
  await user.click(screen.getByRole("button", { name: "plan" }));
  await user.click(screen.getByRole("checkbox", { name: /Publish as an idea/ }));
  await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
}

beforeEach(() => {
  clearIdeaAnalysisCache();
  for (const m of [listNotes, addNote, previewIdea, publishIdea, getAnalysis, composeAnalysisCard, getChartImage]) m.mockReset();
  listNotes.mockResolvedValue([]);
  addNote.mockImplementation(async (b) => saved(b));
  previewIdea.mockImplementation(async (b) => ({ text: `💡 ${b.symbol}`, messages: 1, has_image: Boolean(b.snapshot_png_base64), destination_hint: "…7890" }));
  publishIdea.mockResolvedValue({ note_id: "saved1", published: true });
  getAnalysis.mockResolvedValue(stock());
  composeAnalysisCard.mockResolvedValue(CARD);
  getChartImage.mockReturnValue({ url: "data:image/png;base64,CHART", scale: 1 });
});

describe("the analysis card as the picture of a note saved and published together", () => {
  it("is built on the chart without the person's own trade lines, shown in the preview, and posted as the picture", async () => {
    const user = userEvent.setup();
    await ready(user);
    expect(await screen.findByTestId("analysis-card-preview")).toHaveAttribute("src", CARD);
    expect(getChartImage).toHaveBeenCalledWith({ withoutTrades: true }); // a post must never show the person's own trades
    expect(composeAnalysisCard.mock.calls[0][0]).toMatchObject({ title: "CUPID · 1d", chart: "data:image/png;base64,CLEAN" });
    await waitFor(() => expect(previewIdea.mock.calls[previewIdea.mock.calls.length - 1][0].snapshot_png_base64).toBe(CARD));
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(publishIdea).toHaveBeenCalledTimes(1));
    expect(publishIdea.mock.calls[0][0].snapshot_png_base64).toBe(CARD);
    expect(publishIdea.mock.calls[0][0].analysis.verdict).toBe("The trend and the business both point up");
  });

  it("keeps the card to the post: the note itself is saved without a picture unless a snapshot was asked for", async () => {
    const user = userEvent.setup();
    await ready(user);
    await screen.findByTestId("analysis-card-preview");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(addNote).toHaveBeenCalledTimes(1));
    expect(addNote.mock.calls[0][0]).not.toHaveProperty("snapshot_png_base64");
  });

  it("still builds the card (without a chart) when the chart is not ready", async () => {
    getChartImage.mockReturnValue({ problem: "the chart is not on screen yet" });
    const user = userEvent.setup();
    await ready(user);
    await screen.findByTestId("analysis-card-preview");
    expect(composeAnalysisCard.mock.calls[0][0].chart).toBeNull();
  });

  it("goes out as text when the browser cannot draw the card, and says so", async () => {
    composeAnalysisCard.mockResolvedValue(null);
    const user = userEvent.setup();
    await ready(user);
    expect(await screen.findByText(/could not draw the picture/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save note" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(publishIdea).toHaveBeenCalledTimes(1));
    expect(publishIdea.mock.calls[0][0]).toHaveProperty("analysis");
    expect(publishIdea.mock.calls[0][0]).not.toHaveProperty("snapshot_png_base64");
  });
});
