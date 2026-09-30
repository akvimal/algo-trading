import { api } from "./http";
import type { ReviewPayload } from "../pages/journalModel";

export type TradeKind = "position" | "group";

// A trade is a Position row or an option group; the routes are parallel.
const base = (kind: TradeKind, id: string) => (kind === "position" ? `/positions/${id}` : `/option-groups/${id}`);

/** Partial update: only the keys present are changed. `setup_tag: ""` clears the tag. */
export function saveTags(kind: TradeKind, id: string, body: { setup_tag?: string; confidence?: number }) {
  return api<unknown>("execution", `${base(kind, id)}/tags`, { method: "PUT", json: body });
}

/** Free-text journal note; an empty string clears it. Works any number of times. */
export function saveNotes(kind: TradeKind, id: string, notes: string) {
  return api<unknown>("execution", `${base(kind, id)}/notes`, { method: "PUT", json: { notes } });
}

/** The one-time review of a closed manual trade. The server refuses a second review. */
export function submitReview(kind: TradeKind, id: string, payload: ReviewPayload) {
  return api<unknown>("execution", `${base(kind, id)}/review`, { method: "PUT", json: payload });
}
