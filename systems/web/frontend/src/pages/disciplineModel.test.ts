import { describe, expect, it } from "vitest";
import type { DisciplineV2 } from "../api/types";
import { mistakeWord, topMistakes, whatIfText } from "./disciplineModel";

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
