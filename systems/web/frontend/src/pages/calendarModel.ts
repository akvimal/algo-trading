import type { CalendarEvent } from "../api/types";
import { istDayKey } from "../format";

export type DayGroup = { date: string; label: string; events: CalendarEvent[] };

const dayName = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", ...opts }).format(new Date(`${iso}T12:00:00+05:30`));

/** "Today · Thu 8 Oct", "Tomorrow · Fri 9 Oct", then "Mon 12 Oct". */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const base = `${dayName(iso, { weekday: "short" })} ${dayName(iso, { day: "numeric", month: "short" })}`;
  const today = istDayKey(now);
  if (iso === today) return `Today · ${base}`;
  const tomorrow = istDayKey(new Date(now.getTime() + 24 * 3600 * 1000));
  return iso === tomorrow ? `Tomorrow · ${base}` : base;
}

/** The server's list (already ordered) folded into one group per day. */
export function groupByDay(events: CalendarEvent[], now: Date = new Date()): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && last.date === e.date) last.events.push(e);
    else groups.push({ date: e.date, label: dayLabel(e.date, now), events: [e] });
  }
  return groups;
}

export const KIND_LABEL: Record<CalendarEvent["kind"], string> = { global: "Global", rbi: "RBI", data: "India data", holiday: "Holiday", expiry: "Expiry" };
export const IMPACT_LABEL: Record<CalendarEvent["impact"], string> = { high: "High", medium: "Medium", low: "Low" };

/** "Forecast 230K · Previous 225K · Actual 228K", leaving out whatever the feed did not give. */
export function figures(e: Pick<CalendarEvent, "forecast" | "previous" | "actual">): string {
  return [e.forecast && `Forecast ${e.forecast}`, e.previous && `Previous ${e.previous}`, e.actual && `Actual ${e.actual}`].filter(Boolean).join(" · ");
}
