import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudyNote } from "../api/types";
import { NotesPage } from "./NotesPage";

let admin = true;
vi.mock("../auth/AuthContext", () => ({ useIsAdmin: () => admin }));

const listNotes = vi.fn();
vi.mock("../api/notes", () => ({
  listNotes: (...a: unknown[]) => listNotes(...a),
  listNoteInstruments: () => Promise.resolve([{ segment: "NSE", symbol: "NIFTY", count: 4, last_at: new Date().toISOString() }]),
  deleteNote: vi.fn(),
  fetchSnapshotUrl: vi.fn(),
}));

const note = (id: string, tag: StudyNote["tag"], over: Partial<StudyNote> = {}): StudyNote => ({
  id, segment: "NSE", symbol: "NIFTY", interval: "5min", text: `note ${id}`, tag, context: null, position_id: null, option_group_id: null, has_snapshot: false,
  created_at: new Date().toISOString(), ...over,
});

let ideaCalls: string[];

beforeEach(() => {
  ideaCalls = [];
  admin = true;
  listNotes.mockReset();
  listNotes.mockResolvedValue([note("p", "plan"), note("o", "observation"), note("m", "mistake"), note("r", "review"), note("x", null)]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/ideas/")) ideaCalls.push(url);
      const body = url.endsWith("/ideas/config")
        ? { bot_configured: true, destination_set: true, destination_hint: "…7890", disclaimer: "Not investment advice." }
        : url.includes("/ideas/published")
          ? [{ note_id: "o", published: true, published_at: "2026-10-06T05:40:00Z", unpublished_at: null, destination_hint: "…7890", has_image: false }]
          : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const page = () => render(<MemoryRouter initialEntries={["/more/notes"]}><NotesPage /></MemoryRouter>);

describe("NotesPage publishing (operator only)", () => {
  it("shows the ideas channel and a Publish button on plan notes only, and marks an already published one", async () => {
    page();
    expect(await screen.findByTestId("ideas-channel")).toBeInTheDocument();
    const rows = await screen.findAllByTestId("note");
    const byText = (t: string) => rows.find((r) => within(r).queryByText(t))!;
    expect(within(byText("note p")).getByRole("button", { name: "Publish idea" })).toBeInTheDocument();
    for (const private_ of ["note m", "note r", "note x"]) expect(within(byText(private_)).queryByRole("button", { name: "Publish idea" })).not.toBeInTheDocument();
    expect(await within(byText("note o")).findByText(/^Published 6 Oct at /)).toBeInTheDocument();
    expect(within(byText("note o")).queryByRole("button", { name: "Publish idea" })).not.toBeInTheDocument();
  });

  it("shows no publishing controls to anyone who is not an admin, and never calls the ideas routes", async () => {
    admin = false;
    page();
    await screen.findAllByTestId("note");
    expect(screen.queryByTestId("ideas-channel")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish idea" })).not.toBeInTheDocument();
    expect(ideaCalls).toEqual([]);
  });
});
