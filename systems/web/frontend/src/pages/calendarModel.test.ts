import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../api/types";
import { dayLabel, figures, groupByDay } from "./calendarModel";

const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({ date: "2026-10-08", time: null, title: "t", kind: "global", impact: "medium", detail: null, forecast: null, previous: null, actual: null, ...over });
const NOW = new Date("2026-10-08T05:00:00Z"); // Thursday 10:30 IST

describe("calendar model", () => {
  it("labels today and tomorrow, then plain weekday dates", () => {
    expect(dayLabel("2026-10-08", NOW)).toBe("Today · Thu 8 Oct");
    expect(dayLabel("2026-10-09", NOW)).toBe("Tomorrow · Fri 9 Oct");
    expect(dayLabel("2026-10-12", NOW)).toBe("Mon 12 Oct");
  });
  it("tomorrow follows the Indian date, not the browser's: 23:00 UTC is already the next day in IST", () => {
    expect(dayLabel("2026-10-09", new Date("2026-10-08T20:00:00Z"))).toBe("Today · Fri 9 Oct");
  });
  it("folds the already-ordered list into one group per day, keeping the order", () => {
    const groups = groupByDay([ev({ title: "a" }), ev({ title: "b" }), ev({ date: "2026-10-12", title: "c" })], NOW);
    expect(groups.map((g) => [g.date, g.events.map((e) => e.title)])).toEqual([["2026-10-08", ["a", "b"]], ["2026-10-12", ["c"]]]);
  });
  it("shows only the figures the feed gave", () => {
    expect(figures(ev({ forecast: "2.5%", previous: "2.4%" }))).toBe("Forecast 2.5% · Previous 2.4%");
    expect(figures(ev({}))).toBe("");
  });
});
