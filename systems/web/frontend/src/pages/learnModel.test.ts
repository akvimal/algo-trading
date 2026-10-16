import { describe, expect, it } from "vitest";
import type { MistakeSummary } from "../api/types";
import { HABITS, PARTS } from "./learnCatalog";
import { focusHabit, habitRows, runLabel } from "./learnModel";

const cost = (n: number, pnl: number, level: "study" | "plan" | "execution") => ({ n, pnl, avg_loss: null, level });
const summary = (by_tag: MistakeSummary["by_tag"], since: Record<string, number>): MistakeSummary => ({
  segment: "NSE", reviewed: 12, pending: 0,
  by_level: { study: { n: 0, pnl: 0, avg_loss: null }, plan: { n: 0, pnl: 0, avg_loss: null }, execution: { n: 0, pnl: 0, avg_loss: null }, clean: { n: 0, pnl: 0, avg_loss: null } },
  by_tag, clean: { n: 0, pnl: 0, avg_loss: null, lost: 0 }, flawed: { n: 0, pnl: 0, avg_loss: null }, trades_since_last: since,
});

describe("learn catalog", () => {
  it("has a repair module for each of the 17 review tags, each with a rule and a drill", () => {
    expect(HABITS).toHaveLength(17);
    expect(new Set(HABITS.map((h) => h.tag)).size).toBe(17);
    for (const h of HABITS) expect(h.rule && h.drill && h.why).toBeTruthy();
  });

  it("only points at lessons that exist in the path", () => {
    const ids = new Set(PARTS.flatMap((p) => p.lessons.map((l) => l.id)));
    for (const h of HABITS) for (const id of h.readFirst) expect(ids.has(id), `${h.tag} -> ${id}`).toBe(true);
  });
});

describe("habitRows", () => {
  const s = summary(
    { no_stop: cost(6, -14200, "plan"), against_trend: cost(4, -3000, "study"), revenge: cost(2, -9000, "execution"), stop_moved: cost(3, -500, "execution") },
    { no_stop: 0, against_trend: 3, revenge: 12, stop_moved: 25 },
  );

  it("lists the habits still repeated first, costliest first, and the ones gone ten clean trades last", () => {
    expect(habitRows(s).map((r) => r.habit.tag)).toEqual(["no_stop", "against_trend", "revenge", "stop_moved"]);
  });

  it("counts the clean run up to ten and calls it fixed there", () => {
    const rows = habitRows(s);
    const at = (tag: string) => rows.find((r) => r.habit.tag === tag)!;
    expect(at("against_trend").cleanRun).toBe(3);
    expect(runLabel(at("against_trend"))).toBe("3 of 10 clean");
    expect(at("revenge").fixed).toBe(true);
    expect(at("stop_moved").cleanRun).toBe(10);
    expect(runLabel(at("revenge"))).toBe("Fixed");
  });

  it("leaves out a tag the catalog does not know, and handles no summary", () => {
    expect(habitRows(summary({ mystery: cost(1, -1, "plan") }, {}))).toEqual([]);
    expect(habitRows(null)).toEqual([]);
  });
});

describe("focusHabit", () => {
  it("picks the earliest level still being repeated, then the costliest in it", () => {
    const s = summary(
      { no_stop: cost(6, -14200, "plan"), against_trend: cost(4, -3000, "study"), impulse: cost(2, -9000, "study") },
      { no_stop: 0, against_trend: 3, impulse: 1 },
    );
    expect(focusHabit(habitRows(s))?.habit.tag).toBe("impulse");
  });

  it("is none when every habit is fixed", () => {
    expect(focusHabit(habitRows(summary({ no_stop: cost(2, -1, "plan") }, { no_stop: 11 })))).toBeNull();
  });
});
