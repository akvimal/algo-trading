import { SERVICE_URLS } from "../config";
import { getToken } from "../auth/token";
import { ApiError, api } from "./http";
import type { NoteContext, NoteTag, Segment, StudyNote } from "./types";

/** The person's own notes on one instrument, oldest first. */
export const listNotes = (segment: Segment, symbol: string) =>
  api<StudyNote[]>("execution", `/study-notes?segment=${segment}&symbol=${encodeURIComponent(symbol)}&limit=200`);

export type NewNote = {
  segment: Segment;
  symbol: string;
  interval: string;
  text: string;
  tag: NoteTag | null;
  context: NoteContext;
  /** A PNG data URL of the chart with the note on it, when the person asked for one to be kept. */
  snapshot_png_base64?: string;
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
