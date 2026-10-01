import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STATE } from "./state";
import { addCombo, applyCombo, comboLabel, hasCombo, isActiveCombo, loadCombos, removeCombo, saveCombos, sameSide, type Combo } from "./combos";

const NIFTY = { symbol: "NIFTY", segment: "NSE" as const, interval: "15min" };
const BANKNIFTY = { symbol: "BANKNIFTY", segment: "NSE" as const, interval: "15min" };
const GOLD = { symbol: "GOLDM", segment: "MCX" as const, interval: "15min" };
const CRUDE = { symbol: "CRUDEOILM", segment: "MCX" as const, interval: "15min" };
const NIFTY_5M = { symbol: "NIFTY", segment: "NSE" as const, interval: "5min" };
const NIFTY_1H = { symbol: "NIFTY", segment: "NSE" as const, interval: "60min" };

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

  it("a combo saved before interval existed here falls back to the workstation's own default interval", () => {
    localStorage.setItem("web.workstation.combos", JSON.stringify([{ id: "c1", a: { symbol: "CRUDEOILM", segment: "MCX" }, b: { symbol: "GOLDM", segment: "MCX" } }]));
    expect(loadCombos()).toEqual([{ id: "c1", label: "CRUDEOILM + GOLDM", a: CRUDE, b: GOLD }]);
  });

  it("an invalid interval also falls back to the default, rather than being dropped entirely", () => {
    localStorage.setItem("web.workstation.combos", JSON.stringify([{ id: "c1", a: { symbol: "CRUDEOILM", segment: "MCX", interval: "7min" }, b: GOLD }]));
    expect(loadCombos()[0].a.interval).toBe("15min");
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

  it("the same symbol at two different intervals is a legitimate, distinct combo - not blocked as a duplicate", () => {
    const withFiveMin = addCombo([], NIFTY_5M, NIFTY_1H);
    expect(withFiveMin).toHaveLength(1);
    expect(hasCombo(withFiveMin, NIFTY_5M, NIFTY_1H)).toBe(true);
    expect(hasCombo(withFiveMin, NIFTY, NIFTY_1H)).toBe(false); // NIFTY (15min) + 1h is a DIFFERENT pair
    const both = addCombo(withFiveMin, NIFTY, NIFTY_1H);
    expect(both).toHaveLength(2); // 15m+1h and 5m+1h coexist
  });
});

describe("sameSide", () => {
  it("compares symbol, segment AND interval - the same instrument at two intervals is not the same side", () => {
    expect(sameSide(NIFTY, { ...NIFTY })).toBe(true);
    expect(sameSide(NIFTY, NIFTY_5M)).toBe(false);
    expect(sameSide(NIFTY, BANKNIFTY)).toBe(false);
  });
});

describe("comboLabel", () => {
  it("joins the two symbols when they differ", () => {
    expect(comboLabel(CRUDE, GOLD)).toBe("CRUDEOILM + GOLDM");
  });

  it("names both intervals when the symbol is the same on both sides, to stay unambiguous", () => {
    expect(comboLabel(NIFTY_5M, NIFTY_1H)).toBe("NIFTY 5m + NIFTY 1h");
  });

  it("stays plain for a same-symbol pair that (unusually) also shares one interval", () => {
    expect(comboLabel(NIFTY, { ...NIFTY })).toBe("NIFTY + NIFTY");
  });
});

describe("applyCombo / isActiveCombo", () => {
  const combo: Combo = { id: "c1", label: "Oil + Gold", a: CRUDE, b: GOLD };

  it("puts the two sides on the two charts, side by side, each at its own saved interval", () => {
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

  it("a combo saved at two different intervals keeps each side's own size, and starts with the interval link off", () => {
    const mtf: Combo = { id: "c3", label: "NIFTY 5m + NIFTY 1h", a: NIFTY_5M, b: NIFTY_1H };
    const s = applyCombo(DEFAULT_STATE, mtf);
    expect(s.panes.map((p) => p.interval)).toEqual(["5min", "60min"]); // NOT snapped to match each other
    expect(s.links.interval).toBe(false); // linking would immediately undo the whole point of the combo
    expect(isActiveCombo(s, mtf)).toBe(true);
  });

  it("a combo saved at the SAME interval on both sides still starts with the interval link on", () => {
    const s = applyCombo(DEFAULT_STATE, combo); // CRUDE and GOLD both 15min
    expect(s.links.interval).toBe(true);
  });
});
