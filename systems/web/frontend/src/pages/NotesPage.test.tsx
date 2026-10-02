import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { NoteInstrument, StudyNote } from "../api/types";
import { NotesPage } from "./NotesPage";

const listNotes = vi.fn();
const listNoteInstruments = vi.fn();
const deleteNote = vi.fn();
vi.mock("../api/notes", () => ({
  listNotes: (...a: unknown[]) => listNotes(...a),
  listNoteInstruments: (...a: unknown[]) => listNoteInstruments(...a),
  deleteNote: (...a: unknown[]) => deleteNote(...a),
  fetchSnapshotUrl: vi.fn(),
}));

const note = (id: string, symbol: string, over: Partial<StudyNote> = {}): StudyNote => ({
  id, segment: "NSE", symbol, interval: "5min", text: `note ${id}`, tag: null, context: null, position_id: null, option_group_id: null, has_snapshot: false,
  created_at: new Date().toISOString(), ...over,
});
const INSTRUMENTS: NoteInstrument[] = [
  { segment: "NSE", symbol: "NIFTY", count: 3, last_at: new Date().toISOString() },
  { segment: "MCX", symbol: "GOLDM", count: 1, last_at: new Date().toISOString() },
];

function page(url = "/more/notes") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <NotesPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  for (const m of [listNotes, listNoteInstruments, deleteNote]) m.mockReset();
  listNoteInstruments.mockResolvedValue(INSTRUMENTS);
  listNotes.mockResolvedValue([note("a", "NIFTY"), note("b", "GOLDM", { segment: "MCX" })]);
});

describe("NotesPage", () => {
  it("lists every note newest first with the instrument each is about, and the instruments with counts", async () => {
    page();
    expect(await screen.findAllByTestId("note")).toHaveLength(2);
    expect(listNotes).toHaveBeenCalledWith({ segment: undefined, symbol: undefined, tag: undefined, q: undefined, newestFirst: true, offset: 0, limit: 30 });
    const row = within(screen.getAllByTestId("note")[1]);
    expect(row.getByText("GOLDM")).toBeInTheDocument();
    const chips = within(screen.getByRole("group", { name: "Instrument" }));
    expect(chips.getByRole("button", { name: /All\s*4/ })).toHaveAttribute("aria-pressed", "true");
    expect(chips.getByRole("button", { name: /NIFTY\s*3/ })).toBeInTheDocument();
    expect(chips.getByRole("button", { name: /GOLDM\s*1/ })).toBeInTheDocument();
  });

  it("needs no heading for today's notes", async () => {
    page();
    await screen.findAllByTestId("note");
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
  });

  it("opens on one instrument from the link under the chart, without repeating its name on every note", async () => {
    listNotes.mockResolvedValue([note("a", "NIFTY")]);
    page("/more/notes?segment=NSE&symbol=NIFTY");
    await screen.findByTestId("note");
    expect(listNotes).toHaveBeenCalledWith(expect.objectContaining({ segment: "NSE", symbol: "NIFTY", newestFirst: true }));
    expect(within(screen.getByTestId("note")).queryByText("NIFTY")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /NIFTY\s*3/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: /Open NIFTY chart/ })).toHaveAttribute("href", "/trade?symbol=NIFTY");
  });

  it("switches instrument from the chips and back to all", async () => {
    const user = userEvent.setup();
    page();
    await screen.findAllByTestId("note");
    await user.click(screen.getByRole("button", { name: /GOLDM\s*1/ }));
    await waitFor(() => expect(listNotes).toHaveBeenLastCalledWith(expect.objectContaining({ segment: "MCX", symbol: "GOLDM" })));
    await user.click(screen.getByRole("button", { name: /^All/ }));
    await waitFor(() => expect(listNotes).toHaveBeenLastCalledWith(expect.objectContaining({ segment: undefined, symbol: undefined })));
  });

  it("filters by type, and a second click clears it", async () => {
    const user = userEvent.setup();
    page();
    await screen.findAllByTestId("note");
    await user.click(screen.getByRole("button", { name: "mistake" }));
    await waitFor(() => expect(listNotes).toHaveBeenLastCalledWith(expect.objectContaining({ tag: "mistake" })));
    await user.click(screen.getByRole("button", { name: "mistake" }));
    await waitFor(() => expect(listNotes).toHaveBeenLastCalledWith(expect.objectContaining({ tag: undefined })));
  });

  it("searches the words a moment after the person stops typing", async () => {
    const user = userEvent.setup();
    page();
    await screen.findAllByTestId("note");
    listNotes.mockClear();
    await user.type(screen.getByLabelText("Search notes"), "retest");
    await waitFor(() => expect(listNotes).toHaveBeenLastCalledWith(expect.objectContaining({ q: "retest" })), { timeout: 2000 });
    expect(listNotes.mock.calls.length).toBeLessThanOrEqual(2); // not one request per key
  });

  it("pages back through the history with Load older notes, only while a full page came back", async () => {
    const full = Array.from({ length: 30 }, (_, i) => note(`n${i}`, "NIFTY"));
    listNotes.mockResolvedValueOnce(full).mockResolvedValueOnce([note("old", "NIFTY")]);
    const user = userEvent.setup();
    page();
    expect(await screen.findAllByTestId("note")).toHaveLength(30);
    await user.click(screen.getByTestId("notes-more"));
    await waitFor(() => expect(screen.getAllByTestId("note")).toHaveLength(31));
    expect(listNotes).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 30, limit: 30 }));
    expect(screen.queryByTestId("notes-more")).not.toBeInTheDocument(); // a short page: that was the last
  });

  it("explains an empty history, and says no notes match when a filter is on", async () => {
    listNotes.mockResolvedValue([]);
    listNoteInstruments.mockResolvedValue([]);
    const user = userEvent.setup();
    page();
    expect(await screen.findByTestId("notes-empty")).toHaveTextContent("No notes yet");
    await user.click(screen.getByRole("button", { name: "plan" }));
    await waitFor(() => expect(screen.getByTestId("notes-empty")).toHaveTextContent("No notes match"));
  });

  it("shows the server's message when the notes cannot be loaded, with a retry", async () => {
    listNotes.mockRejectedValueOnce(new ApiError(503, "execution is down"));
    const user = userEvent.setup();
    page();
    expect(await screen.findByRole("alert")).toHaveTextContent("execution is down");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findAllByTestId("note")).toHaveLength(2);
  });

  it("reloads the list and the counts after a note is deleted", async () => {
    deleteNote.mockResolvedValue(undefined);
    const user = userEvent.setup();
    page();
    await screen.findAllByTestId("note");
    const before = listNoteInstruments.mock.calls.length;
    await user.click(within(screen.getAllByTestId("note")[0]).getByRole("button", { name: "Delete note" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete note" }));
    await waitFor(() => expect(deleteNote).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(listNoteInstruments.mock.calls.length).toBeGreaterThan(before));
  });

  it("ignores a segment it does not know instead of filtering on it", async () => {
    page("/more/notes?segment=BSE&symbol=SENSEX");
    await screen.findAllByTestId("note");
    expect(listNotes).toHaveBeenCalledWith(expect.objectContaining({ segment: undefined, symbol: undefined }));
  });
});
