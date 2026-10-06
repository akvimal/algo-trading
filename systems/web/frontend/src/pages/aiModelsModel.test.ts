import { describe, expect, it } from "vitest";
import type { AiModelTask, CatalogModel } from "../api/types";
import { checkChoice, isChanged, priceText, setupSummary } from "./aiModelsModel";

const m = (id: string, prompt: number | null, completion: number | null): CatalogModel => ({ id, name: id, context_length: 1000, prompt_per_m: prompt, completion_per_m: completion });
const task = (key: string, model: string, source: AiModelTask["source"]): AiModelTask => ({ task: key, label: key, description: "", override: source === "task" ? model : null, model, source });

describe("priceText", () => {
  it("shows input and output prices per million tokens", () => {
    expect(priceText(m("a", 0.1, 0.4))).toBe("$0.10 in · $0.40 out per 1M tokens");
    expect(priceText(m("a", 3, 15))).toBe("$3.00 in · $15.0 out per 1M tokens");
  });
  it("says free for a free model and ? for an unknown price", () => {
    expect(priceText(m("a", 0, 0))).toBe("free");
    expect(priceText(m("a", null, 0.4))).toBe("? in · $0.40 out per 1M tokens");
  });
});

describe("checkChoice", () => {
  const catalog = [m("vendor/ok", 0.1, 0.4)];
  it("accepts a catalog model, trimming spaces", () => {
    expect(checkChoice("  vendor/ok ", catalog)).toEqual({ ok: true, id: "vendor/ok" });
  });
  it("rejects an empty box and a name OpenRouter does not list", () => {
    expect(checkChoice("   ", catalog)).toMatchObject({ ok: false });
    expect(checkChoice("vendor/typo", catalog)).toMatchObject({ ok: false, reason: expect.stringContaining("vendor/typo") });
  });
});

describe("isChanged", () => {
  it("is false when the box matches what is saved (an empty box matches nothing saved)", () => {
    expect(isChanged("a/b", "a/b")).toBe(false);
    expect(isChanged(" a/b ", "a/b")).toBe(false);
    expect(isChanged("", null)).toBe(false);
    expect(isChanged("a/c", "a/b")).toBe(true);
    expect(isChanged("a/b", null)).toBe(true);
  });
});

describe("setupSummary", () => {
  it("says when every task shares one model", () => {
    expect(setupSummary([task("news", "x/y", "default"), task("ai_read", "x/y", "default")])).toBe("Every task uses x/y.");
  });
  it("counts the distinct models and the individual choices otherwise", () => {
    const tasks = [task("news", "a/a", "default"), task("premarket", "b/b", "task"), task("ai_read", "a/a", "default")];
    expect(setupSummary(tasks)).toBe("2 different models across 3 tasks, 1 chosen individually.");
  });
});
