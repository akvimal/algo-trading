import { describe, expect, it } from "vitest";
import type { Credential, DisciplineV2 } from "../api/types";
import { credentialLine, credentialProgress, lapseLine, mistakeWord, topMistakes, whatIfText } from "./disciplineModel";

const d = (mistakes: Record<string, number>) => ({ mistakes }) as unknown as DisciplineV2;

describe("whatIfText", () => {
  it("says how far price went after leaving, and whether the target was reached", () => {
    expect(whatIfText({ extra_r: 1.4, target_reached: true })).toBe("Price went another 1.4R your way after you left, and reached your target.");
    expect(whatIfText({ extra_r: 0.6, target_reached: false })).toBe("Price went another 0.6R your way after you left.");
  });

  it("says so when leaving was right, and says nothing without data", () => {
    expect(whatIfText({ extra_r: 0, target_reached: false })).toBe("Price did not go further your way after you left.");
    expect(whatIfText(null)).toBeNull();
  });
});

describe("topMistakes", () => {
  it("lists the most frequent first, only the ones it has words for, up to the limit", () => {
    expect(topMistakes(d({ untagged: 1, oversized: 5, tight_trail: 3, mystery: 9, no_review: 2, revenge: 1 }), 3)).toEqual([
      { key: "oversized", count: 5 },
      { key: "tight_trail", count: 3 },
      { key: "no_review", count: 2 },
    ]);
  });
});

describe("mistakeWord", () => {
  it("falls back to the key in plain letters", () => {
    expect(mistakeWord("oversized")).toBe("Sized above plan");
    expect(mistakeWord("some_new_one")).toBe("some new one");
  });
});

const cred = (over: Partial<Credential> = {}): Credential => ({
  key: "risk_keeper", label: "Risk Keeper", blurb: "", unit: "trades at the system size in a row", count: 5, level: null, next_level: "bronze",
  next_at: 20, best_count: 5, best_level: null, lapsed: false, available: true, detail: null, ...over,
});

describe("credentials", () => {
  it("measures progress to the next level, and a top level reads as full", () => {
    expect(credentialProgress(cred())).toBe(25);
    expect(credentialProgress(cred({ count: 120, level: "gold", next_level: null, next_at: null }))).toBe(100);
    expect(credentialProgress(cred({ count: 40 }))).toBe(100); // never over
  });

  it("says where the run stands, and what a credential still needs", () => {
    expect(credentialLine(cred())).toBe("5 of 20 trades at the system size in a row.");
    expect(credentialLine(cred({ count: 120, next_at: null, next_level: null, level: "gold" }))).toBe("120 trades at the system size in a row.");
    expect(credentialLine(cred({ available: false, detail: "Set a daily loss limit." }))).toBe("Set a daily loss limit.");
    expect(credentialLine(cred({ key: "calm_under_pressure", detail: "Fear mistakes in your last 30 trades: 13%", next_level: "silver", next_at: 50 }))).toBe(
      "Fear mistakes in your last 30 trades: 13% Silver needs 50 trades with few fear mistakes.",
    );
  });

  it("calls a broken run a lapse, only after a level was held", () => {
    expect(lapseLine(cred({ lapsed: true, best_level: "silver", best_count: 61 }))).toBe("You held Silver before. The run broke at 61, so it starts again.");
    expect(lapseLine(cred())).toBeNull();
  });
});
