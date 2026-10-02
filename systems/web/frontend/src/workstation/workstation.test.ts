import { describe, expect, it } from "vitest";
import type { MarketRegime } from "../api/types";
import { directionOf } from "./direction";
import { applyCombo, isActiveCombo, type Combo } from "./combos";
import {
  DEFAULT_STATE, loadWorkstation, paneCount, saveWorkstation, setInterval as setIv, setLayout, setLinks, setSymbol, withUrlSymbol,
} from "./state";

const NIFTY_BANKNIFTY: Combo = { id: "nifty-banknifty", label: "NIFTY + BANKNIFTY", a: { symbol: "NIFTY", segment: "NSE", interval: "15min" }, b: { symbol: "BANKNIFTY", segment: "NSE", interval: "15min" } };
const applyPair = (s: Parameters<typeof applyCombo>[0]) => applyCombo(s, NIFTY_BANKNIFTY);
const isPair = (s: Parameters<typeof isActiveCombo>[0]) => isActiveCombo(s, NIFTY_BANKNIFTY);

const regime = (r: MarketRegime["regime"], trend: MarketRegime["trend"] = "range"): MarketRegime => ({ regime: r, trend, adx: 25, atr_percentile: 50, advice: "" });

describe("directionOf", () => {
  it("a trend regime decides it", () => {
    expect(directionOf(regime("trending_up"))).toBe("up");
    expect(directionOf(regime("trending_down", "up"))).toBe("down"); // the regime outranks the structure trend
  });
  it("otherwise the structure trend, otherwise nowhere", () => {
    expect(directionOf(regime("ranging", "up"))).toBe("up");
    expect(directionOf(regime("transitional", "down"))).toBe("down");
    expect(directionOf(regime("ranging", "range"))).toBe("neutral");
    expect(directionOf(null)).toBeNull();
  });
});

describe("workstation state", () => {
  it("starts as one chart on Nifty, ticket open, crosshair and interval linked but not scrolling/zoom", () => {
    expect(DEFAULT_STATE).toMatchObject({ layout: "single", active: 0, ticketOpen: true, links: { crosshair: true, scale: false, interval: true } });
    expect(paneCount(DEFAULT_STATE)).toBe(1);
  });

  it("saves and restores, and repairs whatever was saved wrong", () => {
    const s = setLayout(DEFAULT_STATE, "side");
    saveWorkstation(s);
    expect(loadWorkstation().layout).toBe("side");
    localStorage.setItem("web.workstation", JSON.stringify({ layout: "diagonal", panes: [{ symbol: "<x>", interval: "7min" }, 5], active: 9, links: { scale: false } }));
    const fixed = loadWorkstation();
    expect(fixed.layout).toBe("single");
    expect(fixed.panes[0]).toMatchObject({ symbol: "NIFTY", interval: "15min" });
    expect(fixed.active).toBe(0);
    expect(fixed.links).toEqual({ crosshair: true, scale: false, interval: true });
    localStorage.setItem("web.workstation", "{broken");
    expect(loadWorkstation()).toEqual(DEFAULT_STATE);
  });

  it("a link from Scan names the first chart and keeps the rest of the setup", () => {
    const saved = { ...applyPair(DEFAULT_STATE), active: 1 as const };
    const s = withUrlSymbol(saved, "reliance", "NSE");
    expect(s.panes[0]).toMatchObject({ symbol: "RELIANCE", segment: "NSE" });
    expect(s.panes[1].symbol).toBe("BANKNIFTY");
    expect(s.layout).toBe("side");
    expect(s.active).toBe(0);
    expect(withUrlSymbol(saved, null, null)).toBe(saved);
  });

  it("the pair puts the two indices side by side at the combo's own saved interval, not whatever the workstation was already showing", () => {
    const start = setIv(DEFAULT_STATE, 0, "5min");
    const s = applyPair(start);
    expect(s.layout).toBe("side");
    expect(s.panes.map((p) => `${p.symbol}@${p.interval}`)).toEqual(["NIFTY@15min", "BANKNIFTY@15min"]); // the combo's own 15min, not the pre-existing 5min
    expect(isPair(s)).toBe(true);
    expect(isPair(DEFAULT_STATE)).toBe(false);
    expect(applyPair(setLayout(s, "stack")).layout).toBe("stack"); // an existing two-chart layout is kept
  });

  it("changing one chart's interval moves the other only while linked", () => {
    const s = applyPair(DEFAULT_STATE);
    expect(setIv(s, 1, "60min").panes.map((p) => p.interval)).toEqual(["60min", "60min"]);
    const free = setLinks(s, { ...s.links, interval: false });
    expect(setIv(free, 1, "60min").panes.map((p) => p.interval)).toEqual(["15min", "60min"]);
    expect(setIv(s, 0, "bogus")).toBe(s);
  });

  it("turning the interval link on brings the other chart to the active chart's size", () => {
    let s = applyPair(DEFAULT_STATE);
    s = setLinks(s, { ...s.links, interval: false });
    s = setIv(s, 1, "5min");
    s = { ...s, active: 1 };
    const linked = setLinks(s, { ...s.links, interval: true });
    expect(linked.panes.map((p) => p.interval)).toEqual(["5min", "5min"]);
  });

  it("setting a symbol infers its market, and a stock defaults to NSE", () => {
    expect(setSymbol(DEFAULT_STATE, 0, "goldm").panes[0]).toMatchObject({ symbol: "GOLDM", segment: "MCX" });
    expect(setSymbol(DEFAULT_STATE, 1, "TCS").panes[1]).toMatchObject({ symbol: "TCS", segment: "NSE" });
    expect(setSymbol(DEFAULT_STATE, 1, "<bad>").panes[1].symbol).toBe("NIFTY");
  });

  it("going back to one chart makes the first active", () => {
    expect(setLayout({ ...applyPair(DEFAULT_STATE), active: 1 }, "single").active).toBe(0);
  });
});
