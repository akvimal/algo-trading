import type { Segment } from "../api/types";
import { DEFAULT_LINKS, paneCount, type PaneSpec, type WorkstationState } from "./state";

// User-saved instrument pairs for the "side by side"/"stacked" two-chart layouts. NIFTY + BANKNIFTY
// used to be the one hardcoded pair the "Layout" row could switch to; it now ships as the one seeded
// default instead, and the person can save any other pair they watch together (CRUDEOIL + GOLD, two
// stocks, ...) or remove any saved one, including that default - same "plain data, persisted,
// testable without a screen" shape as chart/config.ts's own settings.

export type ComboSide = { symbol: string; segment: Segment };
export type Combo = { id: string; label: string; a: ComboSide; b: ComboSide };

const KEY = "web.workstation.combos";

const DEFAULT_COMBOS: Combo[] = [{ id: "nifty-banknifty", label: "NIFTY + BANKNIFTY", a: { symbol: "NIFTY", segment: "NSE" }, b: { symbol: "BANKNIFTY", segment: "NSE" } }];

export const comboLabel = (a: ComboSide, b: ComboSide): string => `${a.symbol} + ${b.symbol}`;

function cleanSide(v: unknown): ComboSide | null {
  const o = (v ?? {}) as Record<string, unknown>;
  if (typeof o.symbol !== "string" || !o.symbol.trim() || typeof o.segment !== "string" || !o.segment.trim()) return null;
  return { symbol: o.symbol.trim().toUpperCase(), segment: o.segment.trim() as Segment };
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

const sameSide = (x: ComboSide, y: ComboSide) => x.symbol === y.symbol && x.segment === y.segment;
const samePair = (c: Combo, a: ComboSide, b: ComboSide) => (sameSide(c.a, a) && sameSide(c.b, b)) || (sameSide(c.a, b) && sameSide(c.b, a));

/** Whether this exact pair (either order) is already saved - the "Save" action checks this so
 * clicking it twice for the same two instruments never creates a duplicate. */
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
 * chosen), linked, at the active chart's own candle size - same behaviour the old hardcoded
 * NIFTY+BANKNIFTY button always had. */
export function applyCombo(s: WorkstationState, combo: Combo): WorkstationState {
  const interval = s.panes[0].interval;
  const toPane = (side: ComboSide): PaneSpec => ({ symbol: side.symbol, segment: side.segment, interval });
  return { ...s, layout: s.layout === "single" ? "side" : s.layout, panes: [toPane(combo.a), toPane(combo.b)], links: DEFAULT_LINKS };
}

/** Whether the two charts right now are showing exactly this combo, in this order - what lights up
 * a saved combo's own button as the active one. */
export const isActiveCombo = (s: WorkstationState, combo: Combo): boolean =>
  paneCount(s) === 2 &&
  s.panes[0].symbol === combo.a.symbol && s.panes[0].segment === combo.a.segment && s.panes[1].symbol === combo.b.symbol && s.panes[1].segment === combo.b.segment;
