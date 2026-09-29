import { describe, expect, it } from "vitest";
import type { CustomScreen, CustomScreenDef } from "../api/types";
import { EMPTY_FORM, defToForm, filterSummary, formToDef, sortScreens, validateForm, type CustomScreenForm } from "./customScreenModel";

const form = (over: Partial<CustomScreenForm> = {}): CustomScreenForm => ({ ...EMPTY_FORM, label: "Bearish breakout", expression: "close > 100", ...over });

describe("validateForm", () => {
  it("is happy with a minimal valid form", () => {
    expect(validateForm(form())).toEqual([]);
  });

  it("needs a label and an expression, in words", () => {
    expect(validateForm(form({ label: "" }))).toEqual(["Give the screen a label, e.g. \"Bearish breakout\"."]);
    expect(validateForm(form({ expression: "" }))).toEqual(["Type a condition, e.g. \"close > 100\"."]);
    expect(validateForm(form({ label: "", expression: "" }))).toHaveLength(2);
  });

  it("blank labels made only of whitespace still count as missing", () => {
    expect(validateForm(form({ label: "   " }))).toContain("Give the screen a label, e.g. \"Bearish breakout\".");
  });
});

describe("formToDef / defToForm", () => {
  it("round-trips a fully-filled form", () => {
    const f = form({ fno: "yes", index: "NIFTY100" });
    const def = formToDef(f);
    expect(def).toEqual<CustomScreenDef>({
      label: "Bearish breakout", expression: "close > 100", is_fno: true, index_membership: "NIFTY100", min_price: null, max_price: null,
    });
    expect(defToForm(def)).toEqual(f);
  });

  it("'any' F&O and no index become null, not false/empty-string", () => {
    const def = formToDef(form());
    expect(def.is_fno).toBeNull();
    expect(def.index_membership).toBeNull();
  });

  it("never sends a price range - that is just another condition now, not a separate field", () => {
    expect(formToDef(form())).toMatchObject({ min_price: null, max_price: null });
  });

  it("fno 'no' becomes is_fno: false, distinct from 'any' (null)", () => {
    expect(formToDef(form({ fno: "no" })).is_fno).toBe(false);
  });

  it("trims the label and expression", () => {
    expect(formToDef(form({ label: "  x  ", expression: "  close > 1  " }))).toMatchObject({ label: "x", expression: "close > 1" });
  });

  it("defToForm reads a definition with no filters back as the empty selections", () => {
    const def: CustomScreenDef = { label: "L", expression: "close > 1", is_fno: null, index_membership: null, min_price: null, max_price: null };
    expect(defToForm(def)).toEqual({ label: "L", expression: "close > 1", fno: "any", index: "" });
  });

  it("defToForm drops an old saved screen's own price range too - the form has nowhere to put it", () => {
    // A screen saved before this field was removed may still carry a price range server-side;
    // editing and re-saving it silently loses that range (express it in the condition instead).
    const def: CustomScreenDef = { label: "L", expression: "close > 1", is_fno: null, index_membership: null, min_price: 100, max_price: 500 };
    expect(defToForm(def)).toEqual({ label: "L", expression: "close > 1", fno: "any", index: "" });
  });
});

describe("filterSummary", () => {
  it("is blank with no filters at all", () => {
    expect(filterSummary(form())).toBe("");
  });

  it("names each active filter", () => {
    expect(filterSummary(form({ fno: "yes" }))).toBe("F&O stocks");
    expect(filterSummary(form({ fno: "no" }))).toBe("non-F&O stocks");
    expect(filterSummary(form({ index: "NIFTY100" }))).toBe("in NIFTY100");
  });

  it("combines every active filter in order", () => {
    expect(filterSummary(form({ fno: "yes", index: "NIFTY100" }))).toBe("F&O stocks, in NIFTY100");
  });
});

describe("sortScreens", () => {
  it("puts the newest-created screen first", () => {
    const a = { id: "a", created_at: "2026-09-01T00:00:00Z" } as CustomScreen;
    const b = { id: "b", created_at: "2026-09-28T00:00:00Z" } as CustomScreen;
    expect(sortScreens([a, b]).map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the input array", () => {
    const a = { id: "a", created_at: "2026-09-01T00:00:00Z" } as CustomScreen;
    const b = { id: "b", created_at: "2026-09-28T00:00:00Z" } as CustomScreen;
    const input = [a, b];
    sortScreens(input);
    expect(input).toEqual([a, b]);
  });
});
