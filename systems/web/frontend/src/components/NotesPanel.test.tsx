import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { NoteContext, StudyNote } from "../api/types";
import { NotesPanel } from "./NotesPanel";

const listNotes = vi.fn();
const addNote = vi.fn();
const deleteNote = vi.fn();
const fetchSnapshotUrl = vi.fn();
vi.mock("../api/notes", () => ({
  listNotes: (...a: unknown[]) => listNotes(...a),
  addNote: (...a: unknown[]) => addNote(...a),
  deleteNote: (...a: unknown[]) => deleteNote(...a),
  fetchSnapshotUrl: (...a: unknown[]) => fetchSnapshotUrl(...a),
}));

const composeSnapshot = vi.fn();
const downloadDataUrl = vi.fn();
const copyDataUrl = vi.fn();
vi.mock("../chart/snapshot", async (orig) => ({
  ...(await orig<typeof import("../chart/snapshot")>()),
  composeSnapshot: (...a: unknown[]) => composeSnapshot(...a),
  downloadDataUrl: (...a: unknown[]) => downloadDataUrl(...a),
  copyDataUrl: (...a: unknown[]) => copyDataUrl(...a),
}));

const CTX: NoteContext = { price: 22550.5, interval: "5min", regime: { regime: "ranging", adx: 14, atr_percentile: 40 } };
const note = (over: Partial<StudyNote> = {}): StudyNote => ({
  id: "n1", segment: "NSE", symbol: "NIFTY", interval: "5min", text: "Waiting for a retest", tag: "plan", context: CTX, position_id: null, option_group_id: null,
  has_snapshot: false, created_at: new Date().toISOString(), ...over,
});

function panel(over: Partial<React.ComponentProps<typeof NotesPanel>> = {}) {
  return render(
    <NotesPanel segment="NSE" symbol="NIFTY" interval="5min" getContext={() => CTX} getChartImage={() => "data:image/png;base64,CHART"} aiRead={null} {...over} />,
  );
}
const openIt = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByTestId("notes-toggle"));

beforeEach(() => {
  for (const m of [listNotes, addNote, deleteNote, fetchSnapshotUrl, composeSnapshot, downloadDataUrl, copyDataUrl]) m.mockReset();
  listNotes.mockResolvedValue([]);
  addNote.mockImplementation(async (b) => note({ text: b.text, tag: b.tag }));
  composeSnapshot.mockResolvedValue("data:image/png;base64,COMPOSED");
  copyDataUrl.mockResolvedValue("copied");
});

describe("NotesPanel", () => {
  it("stays shut, and loads nothing, until it is opened", async () => {
    const user = userEvent.setup();
    panel();
    expect(listNotes).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Note")).not.toBeInTheDocument();
    await openIt(user);
    expect(listNotes).toHaveBeenCalledWith("NSE", "NIFTY");
    expect(await screen.findByText(/No notes on NIFTY yet/)).toBeInTheDocument();
  });

  it("shows the thread under day headings with each note's tag and the market when it was written", async () => {
    listNotes.mockResolvedValue([note()]);
    const user = userEvent.setup();
    panel();
    await openIt(user);
    const row = within(await screen.findByTestId("note"));
    expect(row.getByText("Waiting for a retest")).toBeInTheDocument();
    expect(row.getByText("plan")).toBeInTheDocument();
    expect(row.getByText("Ranging · ADX 14")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
  });

  it("saves a note with its tag and the market as it is now, then clears the box and reloads the thread", async () => {
    const user = userEvent.setup();
    panel();
    await openIt(user);
    await user.type(screen.getByLabelText("Note"), "Plan: buy above 22600");
    await user.click(screen.getByRole("button", { name: "plan" }));
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(addNote).toHaveBeenCalledTimes(1));
    expect(addNote.mock.calls[0][0]).toEqual({ segment: "NSE", symbol: "NIFTY", interval: "5min", text: "Plan: buy above 22600", tag: "plan", context: CTX });
    expect(addNote.mock.calls[0][0]).not.toHaveProperty("snapshot_png_base64"); // not asked for
    await waitFor(() => expect(screen.getByLabelText("Note")).toHaveValue(""));
    expect(listNotes.mock.calls.length).toBeGreaterThan(1);
  });

  it("cannot save an empty note", async () => {
    const user = userEvent.setup();
    panel();
    await openIt(user);
    expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
    await user.type(screen.getByLabelText("Note"), "   ");
    expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
  });

  it("saves with Ctrl+Enter", async () => {
    const user = userEvent.setup();
    panel();
    await openIt(user);
    await user.type(screen.getByLabelText("Note"), "quick thought{Control>}{Enter}{/Control}");
    await waitFor(() => expect(addNote).toHaveBeenCalledTimes(1));
  });

  it("attaches a snapshot - the chart with the note and the AI read's line on it - only when the box is ticked", async () => {
    const user = userEvent.setup();
    panel({ aiRead: { one_liner: "Sell rallies.", bias: "bearish" } as never });
    await openIt(user);
    await user.type(screen.getByLabelText("Note"), "Retest then short");
    await user.click(screen.getByRole("button", { name: "plan" }));
    await user.click(screen.getByLabelText(/Attach a snapshot/));
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(addNote).toHaveBeenCalledTimes(1));
    expect(composeSnapshot).toHaveBeenCalledWith(expect.objectContaining({ chart: "data:image/png;base64,CHART", note: "Retest then short", tag: "plan", aiLine: "Sell rallies.", title: "NIFTY · 5m" }));
    expect(addNote.mock.calls[0][0].snapshot_png_base64).toBe("data:image/png;base64,COMPOSED");
  });

  it("still saves the words when the chart is not ready for a snapshot, and says so", async () => {
    const user = userEvent.setup();
    panel({ getChartImage: () => null });
    await openIt(user);
    await user.type(screen.getByLabelText("Note"), "thought");
    await user.click(screen.getByLabelText(/Attach a snapshot/));
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(addNote).toHaveBeenCalledTimes(1));
    expect(addNote.mock.calls[0][0]).not.toHaveProperty("snapshot_png_base64");
  });

  it("shows the server's message when saving fails and keeps what was typed", async () => {
    addNote.mockRejectedValue(new ApiError(422, "the market context attached to this note is too large"));
    const user = userEvent.setup();
    panel();
    await openIt(user);
    await user.type(screen.getByLabelText("Note"), "keep me");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByTestId("notes-status")).toHaveTextContent("too large");
    expect(screen.getByLabelText("Note")).toHaveValue("keep me");
  });

  it("downloads or copies a snapshot of the chart with what is typed, without saving a note", async () => {
    const user = userEvent.setup();
    panel();
    await openIt(user);
    await user.type(screen.getByLabelText("Note"), "for the group");
    await user.click(screen.getByRole("button", { name: "Download snapshot" }));
    await waitFor(() => expect(downloadDataUrl).toHaveBeenCalledWith("data:image/png;base64,COMPOSED", expect.stringMatching(/^NIFTY-5min-\d{4}-\d{2}-\d{2}-\d{4}\.png$/)));
    await user.click(screen.getByRole("button", { name: "Copy snapshot" }));
    expect(await screen.findByText(/Snapshot copied/)).toBeInTheDocument();
    expect(composeSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ note: "for the group" }));
    expect(addNote).not.toHaveBeenCalled();
  });

  it("points to Download when the browser cannot copy images", async () => {
    copyDataUrl.mockResolvedValue("unsupported");
    const user = userEvent.setup();
    panel();
    await openIt(user);
    await user.click(screen.getByRole("button", { name: "Copy snapshot" }));
    expect(await screen.findByTestId("notes-status")).toHaveTextContent("Use Download instead");
  });

  it("deletes a note only after a second click", async () => {
    listNotes.mockResolvedValue([note()]);
    deleteNote.mockResolvedValue(undefined);
    const user = userEvent.setup();
    panel();
    await openIt(user);
    await user.click(await screen.findByRole("button", { name: "Delete note" }));
    expect(deleteNote).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm delete note" }));
    await waitFor(() => expect(deleteNote).toHaveBeenCalledWith("n1"));
  });

  it("loads a note's snapshot on request and shows it", async () => {
    listNotes.mockResolvedValue([note({ has_snapshot: true })]);
    fetchSnapshotUrl.mockResolvedValue("blob:snap");
    const user = userEvent.setup();
    panel();
    await openIt(user);
    await user.click(await screen.findByRole("button", { name: "View snapshot" }));
    expect(fetchSnapshotUrl).toHaveBeenCalledWith("n1");
    expect(await screen.findByAltText(/Chart snapshot/)).toHaveAttribute("src", "blob:snap");
  });

  it("gives a note without a snapshot no snapshot button", async () => {
    listNotes.mockResolvedValue([note({ has_snapshot: false })]);
    const user = userEvent.setup();
    panel();
    await openIt(user);
    await screen.findByTestId("note");
    expect(screen.queryByRole("button", { name: "View snapshot" })).not.toBeInTheDocument();
  });

  it("starts a half-written note over when the instrument changes", async () => {
    const user = userEvent.setup();
    const { rerender } = panel();
    await openIt(user);
    await user.type(screen.getByLabelText("Note"), "about nifty");
    rerender(<NotesPanel segment="NSE" symbol="BANKNIFTY" interval="5min" getContext={() => CTX} getChartImage={() => null} aiRead={null} />);
    await waitFor(() => expect(screen.getByLabelText("Note")).toHaveValue(""));
    expect(listNotes).toHaveBeenLastCalledWith("NSE", "BANKNIFTY");
  });
});
