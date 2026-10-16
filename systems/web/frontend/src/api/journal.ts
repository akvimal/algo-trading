import { api } from "./http";
import type { ReviewPayload } from "../pages/journalModel";
import type { ReviewSuggestions } from "./types";

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

/** Save what went wrong: the confirmed mistake tags, or `{ clean: true }` for a trade where nothing did. The server files it under the earliest failed level. */
export function saveMistakes(kind: TradeKind, id: string, body: { mistake_tags: string[] } | { clean: true }) {
  return api<unknown>("execution", `${base(kind, id)}/tags`, { method: "PUT", json: body });
}

/** The mistakes the order and its history support for a closed trade, each with why. Suggestions only. */
export function loadSuggestions(kind: TradeKind, id: string) {
  return api<ReviewSuggestions>("execution", `/trade-review/${kind}/${id}/suggestions`);
}
