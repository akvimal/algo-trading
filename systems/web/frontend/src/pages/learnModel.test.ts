import { describe, expect, it } from "vitest";
import type { MistakeSummary, Requirement } from "../api/types";
import { HABITS, PARTS } from "./learnCatalog";
import { focusHabit, habitRows, meterFill, meterTone, nextCheck, runLabel } from "./learnModel";

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

describe("readiness meters", () => {
  const r = (over: Partial<Requirement>): Requirement => ({ key: "trades", label: "t", required: "30 trades", actual: "12 trades", met: false, value: 12, target: 30, higher_is_better: true, ...over });

  it("fills a floor toward its target and caps at full", () => {
    expect(meterFill(r({}))).toBeCloseTo(0.4);
    expect(meterFill(r({ value: 45, met: true }))).toBe(1);
    expect(meterFill(r({ value: null }))).toBe(0);
  });

  it("fills a ceiling toward its limit and turns red once it is over", () => {
    const dd = (value: number, met: boolean) => r({ key: "drawdown", value, target: 20, higher_is_better: false, met });
    expect(meterFill(dd(5, true))).toBeCloseTo(0.25);
    expect([meterTone(dd(5, true)), meterTone(dd(14, true)), meterTone(dd(25, false))]).toEqual(["up", "warn", "dn"]);
  });

  it("treats a sign check (net profit above zero) as full or empty", () => {
    const profit = (value: number | null, met: boolean) => r({ key: "profit", value, target: 0, met });
    expect(meterFill(profit(1200, true))).toBe(1);
    expect(meterFill(profit(-50, false))).toBe(0);
    expect(meterTone(profit(null, false))).toBe("dim");
  });

  it("reads a check from an older server with no numbers as full or empty by its met flag", () => {
    expect(meterFill(r({ value: undefined, target: undefined, met: true }))).toBe(1);
    expect(meterFill(r({ value: undefined, target: undefined }))).toBe(0);
  });

  it("tones a floor: green when met, amber when started, grey when not started", () => {
    expect([meterTone(r({ met: true })), meterTone(r({})), meterTone(r({ value: 0 }))]).toEqual(["up", "warn", "dim"]);
  });

  it("suggests the quickest unmet check next, and none when all are met", () => {
    const all = [r({ key: "days" }), r({ key: "profit" }), r({ key: "trades" }), r({ key: "costs", met: true })];
    expect(nextCheck(all)?.key).toBe("trades");
    expect(nextCheck(all.map((x) => ({ ...x, met: true })))).toBeNull();
    expect(nextCheck([r({ key: "mystery" }), r({ key: "days" })])?.key).toBe("days");
  });
});
