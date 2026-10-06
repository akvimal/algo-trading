import type { Delivery } from "../api/notifications";
import { formatDay, formatTime } from "../format";

/** How many stocks the OI digest lists in EACH of its four boxes. The server accepts 3 to 10; these are the offered steps. */
export const TOP_N_OPTIONS = [3, 5, 7, 10] as const;
export const DEFAULT_TOP_N = 5;

/** The options to show for the digest size, always including the current value (it may have been set to something else). */
export function topNOptions(current: number | undefined): number[] {
  const set = new Set<number>(TOP_N_OPTIONS);
  if (current && Number.isInteger(current)) set.add(current);
  return [...set].sort((a, b) => a - b);
}

export const STATUS_LABEL: Record<Delivery["status"], string> = { sent: "Sent", retrying: "Retrying", gave_up: "Not delivered" };

export function statusTone(s: Delivery["status"]): "up" | "warn" | "dn" {
  return s === "sent" ? "up" : s === "retrying" ? "warn" : "dn";
}

/** "6 Oct 08:45", the time a message was sent (or, if it never was, when it was first tried). */
export function deliveryTime(d: Pick<Delivery, "sent_at" | "created_at">): string {
  const at = d.sent_at ?? d.created_at;
  return `${formatDay(at)} ${formatTime(at)}`;
}

/** What went wrong, in a sentence, or null when nothing did. */
export function deliveryProblem(d: Pick<Delivery, "status" | "last_error" | "attempts">): string | null {
  if (d.status === "sent") return null;
  const why = d.last_error ? `: ${d.last_error}` : "";
  return d.status === "retrying" ? `Could not send yet${why}. It will try again.` : `Gave up after ${d.attempts} tries${why}.`;
}
