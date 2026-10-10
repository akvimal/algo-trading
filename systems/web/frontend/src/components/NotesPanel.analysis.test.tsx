import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
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
vi.mock("../chart/snapshot", async (orig) => ({ ...(await orig<typeof import("../chart/snapshot")>()), composeSnapshot: vi.fn().mockResolvedValue("data:image/png;base64,X") }));

const CTX: NoteContext = { price: 366.1, interval: "1d" };
const stock = (): StockAnalysis => ({
  symbol: "CUPID", as_of: "2026-10-12", price: 366.1,
  verdict: { bias: "bullish", confidence: 0.5, agreement: "aligned", headline: "The trend and the business both point up", reading: "x" },
  technical: { bias: "bullish", confidence: 0.5, trend_strength: "trending", points: ["Weekly: above its 50-week average"], support: [], resistance: [] },
  fundamental: { available: true, bias: "bullish", confidence: 0.7, summary: "Solid.", pros: ["Debt free"], cons: ["Costly"], reasons: [], fetched_at: null, note: null, needs_key: false },
  signals: [],
});
const saved = (b: { text: string; tag: string }): StudyNote => ({ id: "saved1", segment: "NSE", symbol: "CUPID", interval: "1d", text: b.text, tag: b.tag as never, context: CTX, position_id: null, option_group_id: null, has_snapshot: false, created_at: new Date().toISOString() });

function panel(segment: "NSE" | "MCX" = "NSE", symbol = "CUPID") {
  return render(
    <MemoryRouter>
      <NotesPanel segment={segment} symbol={symbol} interval="1d" getContext={() => CTX} getChartImage={() => ({ url: "data:image/png;base64,CHART" })} aiRead={null} />
    </MemoryRouter>,
  );
}

async function ready(user: ReturnType<typeof userEvent.setup>, segment: "NSE" | "MCX" = "NSE", symbol = "CUPID") {
  panel(segment, symbol);
  await user.click(screen.getByTestId("notes-toggle"));
  await user.type(await screen.findByLabelText("Note"), "Pullback to the 50-day average");
  await user.click(screen.getByRole("button", { name: "plan" }));
  await user.click(screen.getByRole("checkbox", { name: /Publish as an idea/ }));
}

beforeEach(() => {
  clearIdeaAnalysisCache();
  for (const m of [listNotes, addNote, previewIdea, publishIdea, getAnalysis]) m.mockReset();
  listNotes.mockResolvedValue([]);
  addNote.mockImplementation(async (b) => saved(b));
  previewIdea.mockImplementation(async (b) => ({ text: `💡 ${b.symbol}\n\n${b.text}${b.analysis ? "\n\n🔎 AI analysis" : ""}`, messages: 1, has_image: false, destination_hint: "…7890" }));
  publishIdea.mockResolvedValue({ note_id: "saved1", published: true });
  getAnalysis.mockResolvedValue(stock());
});

describe("saving a note and publishing it with the AI analysis", () => {
  it("offers the analysis only once Publish is ticked, and only for an NSE stock", async () => {
    const user = userEvent.setup();
    panel();
    await user.click(screen.getByTestId("notes-toggle"));
    await user.type(await screen.findByLabelText("Note"), "A plan");
    await user.click(screen.getByRole("button", { name: "plan" }));
    expect(screen.queryByRole("checkbox", { name: /Include the AI analysis/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Publish as an idea/ }));
    expect(screen.getByRole("checkbox", { name: /Include the AI analysis/ })).not.toBeChecked();
    expect(getAnalysis).not.toHaveBeenCalled(); // nothing is read until it is ticked
  });

  it("is not offered for commodities", async () => {
    const user = userEvent.setup();
    await ready(user, "MCX", "GOLDM");
    expect(screen.queryByRole("checkbox", { name: /Include the AI analysis/ })).not.toBeInTheDocument();
  });

  it("shows the analysis in the preview, and saves then publishes with it", async () => {
    const user = userEvent.setup();
    await ready(user);
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    expect(getAnalysis).toHaveBeenCalledWith("CUPID");
    await waitFor(() => expect(screen.getByText(/🔎 AI analysis/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(publishIdea).toHaveBeenCalledTimes(1));
    expect(addNote).toHaveBeenCalledTimes(1);
    const sent = publishIdea.mock.calls[0][0];
    expect(sent.note_id).toBe("saved1");
    expect(sent.analysis).toMatchObject({ verdict: "The trend and the business both point up", agreement: "aligned", business_bias: "bullish", pros: ["Debt free"], cons: ["Costly"] });
    expect(await screen.findByText("Saved and published.")).toBeInTheDocument();
  });

  it("publishes without it when it was not ticked", async () => {
    const user = userEvent.setup();
    await ready(user);
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(publishIdea).toHaveBeenCalledTimes(1));
    expect(publishIdea.mock.calls[0][0]).not.toHaveProperty("analysis");
  });

  it("cannot be saved while the analysis is still being read", async () => {
    let release: (v: StockAnalysis) => void = () => undefined;
    getAnalysis.mockReturnValue(new Promise<StockAnalysis>((resolve) => (release = resolve)));
    const user = userEvent.setup();
    await ready(user);
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    expect(await screen.findByText(/Reading the analysis/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
    release(stock());
    await waitFor(() => expect(screen.getByRole("button", { name: "Save note" })).toBeEnabled());
  });

  it("says why the analysis could not be read and holds the save until it is unticked", async () => {
    getAnalysis.mockRejectedValue(new ApiError(502, "Could not load CUPID's price history right now."));
    const user = userEvent.setup();
    await ready(user);
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/price history.*Untick it/);
    expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /Include the AI analysis/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save note" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(publishIdea).toHaveBeenCalledTimes(1));
    expect(publishIdea.mock.calls[0][0]).not.toHaveProperty("analysis");
  });
});
