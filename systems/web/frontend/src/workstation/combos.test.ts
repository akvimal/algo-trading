import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STATE } from "./state";
import { addCombo, applyCombo, comboLabel, hasCombo, isActiveCombo, loadCombos, removeCombo, saveCombos, type Combo } from "./combos";

const NIFTY = { symbol: "NIFTY", segment: "NSE" as const };
const BANKNIFTY = { symbol: "BANKNIFTY", segment: "NSE" as const };
const GOLD = { symbol: "GOLDM", segment: "MCX" as const };
const CRUDE = { symbol: "CRUDEOILM", segment: "MCX" as const };

beforeEach(() => localStorage.clear());

describe("loadCombos", () => {
  it("seeds NIFTY + BANKNIFTY when nothing has been saved yet", () => {
    expect(loadCombos()).toEqual([{ id: "nifty-banknifty", label: "NIFTY + BANKNIFTY", a: NIFTY, b: BANKNIFTY }]);
  });

  it("restores what was saved", () => {
    const combos: Combo[] = [{ id: "c1", label: "Oil + Gold", a: CRUDE, b: GOLD }];
    saveCombos(combos);
    expect(loadCombos()).toEqual(combos);
  });

  it("an intentionally emptied list stays empty, rather than being reseeded", () => {
    saveCombos([]);
    expect(loadCombos()).toEqual([]);
  });

  it("drops a malformed entry but keeps the rest, and falls back to the default if nothing survives", () => {
    localStorage.setItem("web.workstation.combos", JSON.stringify([{ id: "c1", a: NIFTY, b: {} }, { id: "", a: NIFTY, b: BANKNIFTY }]));
    expect(loadCombos()).toEqual([]);
    localStorage.setItem("web.workstation.combos", JSON.stringify([{ id: "c1", a: CRUDE, b: GOLD }, { id: "c2", a: NIFTY, b: {} }]));
    expect(loadCombos()).toEqual([{ id: "c1", label: "CRUDEOILM + GOLDM", a: CRUDE, b: GOLD }]);
  });

  it("a totally broken value falls back to the default", () => {
    localStorage.setItem("web.workstation.combos", "{not json");
    expect(loadCombos()).toEqual([{ id: "nifty-banknifty", label: "NIFTY + BANKNIFTY", a: NIFTY, b: BANKNIFTY }]);
  });
});

describe("addCombo / hasCombo / removeCombo", () => {
  it("adds a new pair with an auto label", () => {
    const out = addCombo([], CRUDE, GOLD);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: "CRUDEOILM + GOLDM", a: CRUDE, b: GOLD });
    expect(out[0].id).toBeTruthy();
  });

  it("takes an explicit label when given one", () => {
    expect(addCombo([], CRUDE, GOLD, "Commodities")[0].label).toBe("Commodities");
  });

  it("does not add the same pair twice, in either order", () => {
    const once = addCombo([], CRUDE, GOLD);
    expect(addCombo(once, CRUDE, GOLD)).toBe(once);
    expect(addCombo(once, GOLD, CRUDE)).toBe(once); // reversed order: still the same pair
    expect(hasCombo(once, GOLD, CRUDE)).toBe(true);
  });

  it("removes by id, leaving the rest", () => {
    const two = addCombo(addCombo([], CRUDE, GOLD), NIFTY, BANKNIFTY);
    const goneId = two.find((c) => c.a.symbol === "CRUDEOILM")!.id;
    const left = removeCombo(two, goneId);
    expect(left).toHaveLength(1);
    expect(left[0].a.symbol).toBe("NIFTY");
  });
});

describe("comboLabel", () => {
  it("joins the two symbols", () => {
    expect(comboLabel(CRUDE, GOLD)).toBe("CRUDEOILM + GOLDM");
  });
});

describe("applyCombo / isActiveCombo", () => {
  const combo: Combo = { id: "c1", label: "Oil + Gold", a: CRUDE, b: GOLD };

  it("puts the two sides on the two charts, side by side, at the first chart's candle size", () => {
    const s = applyCombo(DEFAULT_STATE, combo);
    expect(s.layout).toBe("side");
    expect(s.panes.map((p) => `${p.symbol}@${p.segment}@${p.interval}`)).toEqual(["CRUDEOILM@MCX@15min", "GOLDM@MCX@15min"]);
    expect(isActiveCombo(s, combo)).toBe(true);
    expect(isActiveCombo(DEFAULT_STATE, combo)).toBe(false);
  });

  it("keeps an existing two-chart layout rather than forcing 'side'", () => {
    expect(applyCombo({ ...DEFAULT_STATE, layout: "stack" }, combo).layout).toBe("stack");
  });

  it("is order-sensitive: the reverse pairing is not the same active combo", () => {
    const s = applyCombo(DEFAULT_STATE, combo);
    const reversed: Combo = { id: "c2", label: "Gold + Oil", a: GOLD, b: CRUDE };
    expect(isActiveCombo(s, reversed)).toBe(false);
  });
});
