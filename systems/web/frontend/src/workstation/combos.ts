import type { Segment } from "../api/types";
import { DEFAULT_INTERVAL, INTERVALS, TRADE_INTERVALS } from "../chart/config";
import { DEFAULT_LINKS, paneCount, type PaneSpec, type WorkstationState } from "./state";

// User-saved instrument pairs for the "side by side"/"stacked" two-chart layouts. NIFTY + BANKNIFTY
// used to be the one hardcoded pair the "Layout" row could switch to; it now ships as the one seeded
// default instead, and the person can save any other pair they watch together (CRUDEOIL + GOLD, two
// stocks, the SAME symbol at two different candle sizes for a multi-timeframe read, ...) or remove
// any saved one, including that default - same "plain data, persisted, testable without a screen"
// shape as chart/config.ts's own settings.

export type ComboSide = { symbol: string; segment: Segment; interval: string };
export type Combo = { id: string; label: string; a: ComboSide; b: ComboSide };

const KEY = "web.workstation.combos";
const VALID_INTERVALS = new Set(TRADE_INTERVALS.map((i) => i.value));

const DEFAULT_COMBOS: Combo[] = [
  { id: "nifty-banknifty", label: "NIFTY + BANKNIFTY", a: { symbol: "NIFTY", segment: "NSE", interval: DEFAULT_INTERVAL }, b: { symbol: "BANKNIFTY", segment: "NSE", interval: DEFAULT_INTERVAL } },
];

const intervalLabel = (v: string): string => INTERVALS.find((i) => i.value === v)?.label ?? v;

/** Plain "SYMBOL + SYMBOL" when the two sides differ - the symbols alone already tell them apart.
 * Same symbol on both sides only makes sense at two different candle sizes (that's the whole point
 * of saving it), so the label names both: "NIFTY 5m + NIFTY 1h", not an ambiguous "NIFTY + NIFTY". */
export const comboLabel = (a: ComboSide, b: ComboSide): string =>
  a.symbol === b.symbol && a.interval !== b.interval ? `${a.symbol} ${intervalLabel(a.interval)} + ${b.symbol} ${intervalLabel(b.interval)}` : `${a.symbol} + ${b.symbol}`;

/** Same instrument, same candle size, on both sides - not a real combo (there is nothing to
 * compare), and the CombosMenu's own "+ Save" offer is gated on this. */
export const sameSide = (x: ComboSide, y: ComboSide): boolean => x.symbol === y.symbol && x.segment === y.segment && x.interval === y.interval;

function cleanSide(v: unknown): ComboSide | null {
  const o = (v ?? {}) as Record<string, unknown>;
  if (typeof o.symbol !== "string" || !o.symbol.trim() || typeof o.segment !== "string" || !o.segment.trim()) return null;
  // A combo saved before interval existed here (or a malformed one) falls back to the workstation's
  // own default candle size, same "missing means the default" precedent as state.ts's cleanPane.
  const interval = typeof o.interval === "string" && VALID_INTERVALS.has(o.interval) ? o.interval : DEFAULT_INTERVAL;
  return { symbol: o.symbol.trim().toUpperCase(), segment: o.segment.trim() as Segment, interval };
}

function cleanCombo(v: unknown): Combo | null {
  const o = (v ?? {}) as Record<string, unknown>;
  const a = cleanSide(o.a);
  const b = cleanSide(o.b);
  if (!a || !b || typeof o.id !== "string" || !o.id.trim()) return null;
  return { id: o.id, label: typeof o.label === "string" && o.label.trim() ? o.label : comboLabel(a, b), a, b };
}

/** What was saved, made safe: a malformed or missing list falls back to the one seeded default. An
 * intentionally emptied list (every saved combo, including the default, removed) stays empty rather
 * than being reseeded - "no default" is itself a valid, rememberable choice. */
export function loadCombos(): Combo[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!Array.isArray(raw)) return DEFAULT_COMBOS;
    return raw.map(cleanCombo).filter((c): c is Combo => c != null);
  } catch {
    return DEFAULT_COMBOS;
  }
}

export function saveCombos(combos: Combo[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(combos));
  } catch {
    // storage blocked: the list simply lasts this session
  }
}

const samePair = (c: Combo, a: ComboSide, b: ComboSide) => (sameSide(c.a, a) && sameSide(c.b, b)) || (sameSide(c.a, b) && sameSide(c.b, a));

/** Whether this exact pair (either order, same candle sizes too) is already saved - the "Save"
 * action checks this so clicking it twice for the same two instruments at the same two sizes never
 * creates a duplicate. The SAME symbols at two DIFFERENT sizes are a different, legitimate combo. */
export const hasCombo = (combos: Combo[], a: ComboSide, b: ComboSide): boolean => combos.some((c) => samePair(c, a, b));

export function addCombo(combos: Combo[], a: ComboSide, b: ComboSide, label?: string): Combo[] {
  if (hasCombo(combos, a, b)) return combos;
  const id = `combo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return [...combos, { id, label: label?.trim() || comboLabel(a, b), a, b }];
}

export function removeCombo(combos: Combo[], id: string): Combo[] {
  return combos.filter((c) => c.id !== id);
}

/** Puts `combo`'s two sides on the two charts, side by side (or stacked, if that was already
 * chosen), each at its OWN saved candle size - same behaviour the old hardcoded NIFTY+BANKNIFTY
 * button always had when both sides shared one size, but no longer forces them together: a combo
 * saved at two different sizes (the same symbol on both sides, watched at two timeframes) would
 * otherwise have the interval link immediately snap them back to matching, undoing the whole point
 * of saving it that way. The link starts ON only when the combo's own two sides already agree. */
export function applyCombo(s: WorkstationState, combo: Combo): WorkstationState {
  const toPane = (side: ComboSide): PaneSpec => ({ symbol: side.symbol, segment: side.segment, interval: side.interval });
  return {
    ...s,
    layout: s.layout === "single" ? "side" : s.layout,
    panes: [toPane(combo.a), toPane(combo.b)],
    links: { ...DEFAULT_LINKS, interval: combo.a.interval === combo.b.interval },
  };
}

/** Whether the two charts right now are showing exactly this combo, in this order, at its own
 * saved candle sizes - what lights up a saved combo's own button as the active one. */
export const isActiveCombo = (s: WorkstationState, combo: Combo): boolean => paneCount(s) === 2 && sameSide(s.panes[0], combo.a) && sameSide(s.panes[1], combo.b);
