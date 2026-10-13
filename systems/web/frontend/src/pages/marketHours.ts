import type { Segment } from "../api/types";

// Local exchange time, Monday to Friday. The server uses the same hours to decide when a waiting order is placed. A holiday is not known here.
const SESSIONS: Partial<Record<Segment, [number, number]>> = { NSE: [9 * 60 + 15, 15 * 60 + 30], MCX: [9 * 60, 23 * 60 + 30] };

/** Is this market trading right now? Crypto never closes. */
export function marketIsOpen(segment: Segment, now: Date = new Date()): boolean {
  const session = SESSIONS[segment];
  if (!session) return true;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  if (get("weekday") === "Sat" || get("weekday") === "Sun") return false;
  const minutes = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  return minutes >= session[0] && minutes < session[1];
}
