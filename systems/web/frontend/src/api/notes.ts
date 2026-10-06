import { SERVICE_URLS } from "../config";
import { getToken } from "../auth/token";
import { ApiError, api } from "./http";
import type { NoteContext, NoteInstrument, NoteTag, Segment, StudyNote } from "./types";

export type NoteFilter = {
  segment?: Segment;
  symbol?: string;
  tag?: NoteTag;
  /** Only notes whose text contains this. */
  q?: string;
  /** Newest first, paged with `offset` - what the history page uses. Without it: the latest `limit`, oldest first. */
  newestFirst?: boolean;
  offset?: number;
  limit?: number;
};

/** The person's own notes, optionally narrowed to one instrument, a tag, or some text. */
export function listNotes(filter: NoteFilter = {}) {
  const params = new URLSearchParams();
  if (filter.segment) params.set("segment", filter.segment);
  if (filter.symbol) params.set("symbol", filter.symbol);
  if (filter.tag) params.set("tag", filter.tag);
  if (filter.q?.trim()) params.set("q", filter.q.trim());
  if (filter.newestFirst) params.set("newest_first", "true");
  if (filter.offset) params.set("offset", String(filter.offset));
  params.set("limit", String(filter.limit ?? 200));
  return api<StudyNote[]>("execution", `/study-notes?${params.toString()}`);
}

/** Every instrument the person has notes on, most recently written first, with a count. */
export const listNoteInstruments = () => api<NoteInstrument[]>("execution", "/study-notes/instruments");

export type NewNote = {
  segment: Segment;
  symbol: string;
  interval: string;
  text: string;
  tag: NoteTag | null;
  context: NoteContext;
  /** A PNG data URL of the chart with the note on it, when the person asked for one to be kept. */
  snapshot_png_base64?: string;
  /** The same chart with only a header (no note text, no AI line): the picture a published idea uses. */
  clean_png_base64?: string;
};

export const addNote = (note: NewNote) => api<StudyNote>("execution", "/study-notes", { method: "POST", json: note });

export const deleteNote = (id: string) => api<void>("execution", `/study-notes/${id}`, { method: "DELETE" });

/** A note's snapshot as an object URL the page can show. The route needs the login token, so an <img src> cannot
 * fetch it directly; the caller revokes the URL when done. */
export async function fetchSnapshotUrl(id: string): Promise<string> {
  const token = getToken();
  let response: Response;
  try {
    response = await fetch(`${SERVICE_URLS.execution}/study-notes/${id}/snapshot`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection and try again.", "network");
  }
  if (!response.ok) throw new ApiError(response.status, response.status === 404 ? "No snapshot for this note." : "Could not load the snapshot.");
  return URL.createObjectURL(await response.blob());
}
